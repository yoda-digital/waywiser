//! MemoryStore — durable memory storage with FTS5 lexical recall.
//!
//! P0 implementation: SQLite FTS5 lexical recall only.
//! Semantic (vector) recall added in P2.

use async_trait::async_trait;
use chrono::Utc;
use pi_types::{MemoryRecord, WaywiserError};
use rusqlite::params;
use std::sync::Mutex;
use uuid::Uuid;

/// Convert rusqlite::Error to WaywiserError::Database.
fn db_err(e: rusqlite::Error) -> WaywiserError {
    WaywiserError::Database(e.to_string())
}

/// Memory storage and recall abstraction.
#[async_trait]
pub trait MemoryStore: Send + Sync {
    /// Store a new memory record.
    async fn store(&self, record: &MemoryRecord) -> Result<(), WaywiserError>;

    /// Recall memories matching a query (FTS in P0, hybrid in P2).
    async fn recall(&self, query: &str, limit: u32) -> Result<Vec<MemoryRecord>, WaywiserError>;

    /// Get a specific memory by ID.
    async fn get(&self, id: Uuid) -> Result<Option<MemoryRecord>, WaywiserError>;

    /// Update an existing memory record.
    async fn update(&self, record: &MemoryRecord) -> Result<(), WaywiserError>;

    /// Delete a memory by ID. Returns true if found and deleted.
    async fn delete(&self, id: Uuid) -> Result<bool, WaywiserError>;

    /// Full-text search using SQLite FTS5.
    async fn search_fts(&self, query: &str, limit: u32) -> Result<Vec<MemoryRecord>, WaywiserError>;
}

/// SQLite-backed memory store with FTS5 for lexical recall.
pub struct SqliteMemoryStore {
    conn: Mutex<rusqlite::Connection>,
}

impl SqliteMemoryStore {
    /// Create a new memory store at the given database path.
    pub fn new(path: &str) -> Result<Self, WaywiserError> {
        let conn = rusqlite::Connection::open(path).map_err(db_err)?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.init_schema()?;
        Ok(store)
    }

    /// Create an in-memory store (for testing).
    pub fn in_memory() -> Result<Self, WaywiserError> {
        Self::new(":memory:")
    }

    fn init_schema(&self) -> Result<(), WaywiserError> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT '',
                provenance_json TEXT NOT NULL,
                confidence REAL NOT NULL,
                usage_count INTEGER NOT NULL DEFAULT 0,
                last_recalled TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                content,
                scope,
                content='memories',
                content_rowid='rowid'
            );

            CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, content, scope)
                VALUES (new.rowid, new.content, new.scope);
            END;

            CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content, scope)
                VALUES ('delete', old.rowid, old.content, old.scope);
            END;

            CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content, scope)
                VALUES ('delete', old.rowid, old.content, old.scope);
                INSERT INTO memories_fts(rowid, content, scope)
                VALUES (new.rowid, new.content, new.scope);
            END;
            ",
        )
        .map_err(db_err)?;
        Ok(())
    }

    fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
        let id_str: String = row.get(0)?;
        let provenance_json: String = row.get(3)?;
        let last_recalled: Option<String> = row.get(6)?;
        let created_at_str: String = row.get(7)?;
        let updated_at_str: String = row.get(8)?;

        Ok(MemoryRecord {
            id: Uuid::parse_str(&id_str).unwrap_or_default(),
            content: row.get(1)?,
            scope: row.get(2)?,
            provenance: serde_json::from_str(&provenance_json).unwrap_or_else(|_| {
                pi_types::Provenance {
                    source: pi_types::ProvenanceSource::SystemDefault,
                    session_id: None,
                    created_at: Utc::now(),
                    confidence_ceiling: 1.0,
                }
            }),
            confidence: row.get(4)?,
            usage_count: row.get::<_, u32>(5)?,
            last_recalled: last_recalled.and_then(|s| {
                chrono::DateTime::parse_from_rfc3339(&s)
                    .ok()
                    .map(|dt| dt.with_timezone(&Utc))
            }),
            created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
            updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
        })
    }
}

#[async_trait]
impl MemoryStore for SqliteMemoryStore {
    async fn store(&self, record: &MemoryRecord) -> Result<(), WaywiserError> {
        let record = record.clone();
        let conn = self.conn.lock().unwrap();
        let provenance_json =
            serde_json::to_string(&record.provenance).map_err(|e| WaywiserError::MemoryStore(e.to_string()))?;

        conn.execute(
            "INSERT INTO memories (id, content, scope, provenance_json, confidence, usage_count, last_recalled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                record.id.to_string(),
                record.content,
                record.scope,
                provenance_json,
                record.confidence,
                record.usage_count,
                record.last_recalled.map(|dt| dt.to_rfc3339()),
                record.created_at.to_rfc3339(),
                record.updated_at.to_rfc3339(),
            ],
        )
        .map_err(db_err)?;
        Ok(())
    }

    async fn recall(&self, query: &str, limit: u32) -> Result<Vec<MemoryRecord>, WaywiserError> {
        // In P0, recall just uses FTS5
        self.search_fts(query, limit).await
    }

    async fn get(&self, id: Uuid) -> Result<Option<MemoryRecord>, WaywiserError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, content, scope, provenance_json, confidence, usage_count, last_recalled, created_at, updated_at
                 FROM memories WHERE id = ?1",
            )
            .map_err(db_err)?;

        let mut rows = stmt
            .query_map(params![id.to_string()], Self::row_to_record)
            .map_err(db_err)?;

        match rows.next() {
            Some(Ok(record)) => Ok(Some(record)),
            Some(Err(e)) => Err(db_err(e)),
            None => Ok(None),
        }
    }

    async fn update(&self, record: &MemoryRecord) -> Result<(), WaywiserError> {
        let record = record.clone();
        let conn = self.conn.lock().unwrap();
        let provenance_json =
            serde_json::to_string(&record.provenance).map_err(|e| WaywiserError::MemoryStore(e.to_string()))?;

        let updated = conn
            .execute(
                "UPDATE memories SET content = ?2, scope = ?3, provenance_json = ?4, confidence = ?5,
                 usage_count = ?6, last_recalled = ?7, updated_at = ?8
                 WHERE id = ?1",
                params![
                    record.id.to_string(),
                    record.content,
                    record.scope,
                    provenance_json,
                    record.confidence,
                    record.usage_count,
                    record.last_recalled.map(|dt| dt.to_rfc3339()),
                    record.updated_at.to_rfc3339(),
                ],
            )
            .map_err(db_err)?;

        if updated == 0 {
            return Err(WaywiserError::MemoryStore(format!(
                "Memory not found: {}",
                record.id
            )));
        }
        Ok(())
    }

    async fn delete(&self, id: Uuid) -> Result<bool, WaywiserError> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn
            .execute("DELETE FROM memories WHERE id = ?1", params![id.to_string()])
            .map_err(db_err)?;
        Ok(deleted > 0)
    }

    async fn search_fts(&self, query: &str, limit: u32) -> Result<Vec<MemoryRecord>, WaywiserError> {
        if query.trim().is_empty() {
            return Ok(vec![]);
        }

        let conn = self.conn.lock().unwrap();

        // Use FTS5 match query. Escape special FTS5 syntax characters.
        let safe_query = query
            .replace('"', "\"\"")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" OR ");

        if safe_query.is_empty() {
            return Ok(vec![]);
        }

        let sql = format!(
            "SELECT m.id, m.content, m.scope, m.provenance_json, m.confidence,
                    m.usage_count, m.last_recalled, m.created_at, m.updated_at
             FROM memories m
             JOIN memories_fts f ON m.rowid = f.rowid
             WHERE memories_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2"
        );

        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt
            .query_map(params![safe_query, limit], Self::row_to_record)
            .map_err(db_err)?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(db_err)?);
        }
        Ok(results)
    }
}
