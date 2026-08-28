//! SQLite implementation of SessionBackend.
//!
//! Uses WAL journal mode for concurrent reads during writes.
//! All async methods delegate to `spawn_blocking` since rusqlite is synchronous.
//! Session state is serialized as JSON blobs; records are stored row-per-record.

use std::sync::Mutex;

use async_trait::async_trait;
use chrono::Utc;
use pi_types::{
    Entry, EntryId, LaneId, LaneQueue, SessionId, SessionState, WaywiserError,
};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::backend::{MutationMeta, SessionBackend, SessionSummary, StoredRecord};
use crate::migrations;

/// SQLite-backed session storage.
///
/// Wraps a `rusqlite::Connection` in a `Mutex` for Send + Sync.
/// Async methods use `tokio::task::spawn_blocking` to avoid blocking
/// the tokio runtime.
pub struct SqliteSessionBackend {
    conn: Mutex<Connection>,
}

impl SqliteSessionBackend {
    /// Open or create a session database at the given path.
    /// Use `:memory:` for in-memory databases (testing).
    pub fn new(path: &str) -> Result<Self, WaywiserError> {
        let conn = Connection::open(path).map_err(|e| WaywiserError::Database(e.to_string()))?;
        Self::configure_and_init(conn)
    }

    /// Create an in-memory session database (for testing).
    pub fn in_memory() -> Result<Self, WaywiserError> {
        let conn =
            Connection::open_in_memory().map_err(|e| WaywiserError::Database(e.to_string()))?;
        Self::configure_and_init(conn)
    }

    fn configure_and_init(conn: Connection) -> Result<Self, WaywiserError> {
        // Enable WAL journal mode for concurrent reads
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        // Enable foreign key enforcement
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        // Apply schema migrations
        migrations::apply_migrations(&conn)
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

}

#[async_trait]
impl SessionBackend for SqliteSessionBackend {
    async fn create_session(&self, session: &SessionState) -> Result<(), WaywiserError> {
        let id_str = session.id.to_string();
        let state_json = serde_json::to_string(session)
            .map_err(|e| WaywiserError::Database(format!("serialize: {e}")))?;
        let created = session.created_at.to_rfc3339();
        let updated = session.updated_at.to_rfc3339();

        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        conn.execute(
            "INSERT INTO sessions (id, state_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id_str, state_json, created, updated],
        )
        .map_err(|e| WaywiserError::Database(e.to_string()))?;

        Ok(())
    }

    async fn load_session(
        &self,
        id: SessionId,
    ) -> Result<Option<SessionState>, WaywiserError> {
        let id_str = id.to_string();

        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        let row: Option<String> = conn
            .query_row(
                "SELECT state_json FROM sessions WHERE id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        match row {
            Some(json) => {
                let state: SessionState = serde_json::from_str(&json)
                    .map_err(|e| WaywiserError::Database(format!("deserialize: {e}")))?;
                Ok(Some(state))
            }
            None => Ok(None),
        }
    }

    async fn save_session(&self, session: &SessionState) -> Result<(), WaywiserError> {
        let id_str = session.id.to_string();
        let state_json = serde_json::to_string(session)
            .map_err(|e| WaywiserError::Database(format!("serialize: {e}")))?;
        let updated = session.updated_at.to_rfc3339();

        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        let rows = conn
            .execute(
                "UPDATE sessions SET state_json = ?1, updated_at = ?2 WHERE id = ?3",
                params![state_json, updated, id_str],
            )
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        if rows == 0 {
            return Err(WaywiserError::SessionNotFound(session.id));
        }

        Ok(())
    }

    async fn delete_session(&self, id: SessionId) -> Result<bool, WaywiserError> {
        let id_str = id.to_string();

        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        // Delete records first (cascade might not fire with all pragma combos)
        conn.execute(
            "DELETE FROM operation_records WHERE session_id = ?1",
            params![id_str],
        )
        .map_err(|e| WaywiserError::Database(e.to_string()))?;

        let rows = conn
            .execute("DELETE FROM sessions WHERE id = ?1", params![id_str])
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        Ok(rows > 0)
    }

    async fn list_sessions(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<SessionSummary>, WaywiserError> {
        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT id, state_json, created_at, updated_at FROM sessions \
                 ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        let rows = stmt
            .query_map(params![limit, offset], |row| {
                let id_str: String = row.get(0)?;
                let state_json: String = row.get(1)?;
                let created_str: String = row.get(2)?;
                let updated_str: String = row.get(3)?;
                Ok((id_str, state_json, created_str, updated_str))
            })
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        let mut summaries = Vec::new();
        for row in rows {
            let (id_str, state_json, created_str, updated_str) =
                row.map_err(|e| WaywiserError::Database(e.to_string()))?;

            let id = Uuid::parse_str(&id_str)
                .map_err(|e| WaywiserError::Database(format!("bad uuid: {e}")))?;

            // Get turn count from session state
            let state: SessionState = serde_json::from_str(&state_json)
                .map_err(|e| WaywiserError::Database(format!("deserialize: {e}")))?;

            let created_at = chrono::DateTime::parse_from_rfc3339(&created_str)
                .map_err(|e| WaywiserError::Database(format!("bad date: {e}")))?
                .with_timezone(&Utc);
            let updated_at = chrono::DateTime::parse_from_rfc3339(&updated_str)
                .map_err(|e| WaywiserError::Database(format!("bad date: {e}")))?
                .with_timezone(&Utc);

            summaries.push(SessionSummary {
                id: SessionId::from_uuid(id),
                turn_count: state.usage.turn_count,
                created_at,
                updated_at,
            });
        }

        Ok(summaries)
    }

    async fn append_entry(
        &self,
        session_id: SessionId,
        lane_id: LaneId,
        entry: &Entry,
    ) -> Result<(), WaywiserError> {
        let id_str = session_id.to_string();

        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        // Load current state
        let state_json: String = conn
            .query_row(
                "SELECT state_json FROM sessions WHERE id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| WaywiserError::Database(e.to_string()))?
            .ok_or(WaywiserError::SessionNotFound(session_id))?;

        let mut state: SessionState = serde_json::from_str(&state_json)
            .map_err(|e| WaywiserError::Database(format!("deserialize: {e}")))?;

        // Find the lane and append
        let lane = state
            .lanes
            .iter_mut()
            .find(|l| l.id == lane_id)
            .ok_or(WaywiserError::LaneNotFound {
                lane_id: *lane_id.as_uuid(),
            })?;

        lane.entries.push(entry.clone());
        state.updated_at = Utc::now();

        // Save back
        let new_json = serde_json::to_string(&state)
            .map_err(|e| WaywiserError::Database(format!("serialize: {e}")))?;
        let updated = state.updated_at.to_rfc3339();

        conn.execute(
            "UPDATE sessions SET state_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_json, updated, id_str],
        )
        .map_err(|e| WaywiserError::Database(e.to_string()))?;

        Ok(())
    }

    async fn update_lane_queue(
        &self,
        session_id: SessionId,
        lane_id: LaneId,
        queue: &LaneQueue,
    ) -> Result<(), WaywiserError> {
        let id_str = session_id.to_string();

        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        let state_json: String = conn
            .query_row(
                "SELECT state_json FROM sessions WHERE id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| WaywiserError::Database(e.to_string()))?
            .ok_or(WaywiserError::SessionNotFound(session_id))?;

        let mut state: SessionState = serde_json::from_str(&state_json)
            .map_err(|e| WaywiserError::Database(format!("deserialize: {e}")))?;

        let lane = state
            .lanes
            .iter_mut()
            .find(|l| l.id == lane_id)
            .ok_or(WaywiserError::LaneNotFound {
                lane_id: *lane_id.as_uuid(),
            })?;

        lane.queue = queue.clone();
        state.updated_at = Utc::now();

        let new_json = serde_json::to_string(&state)
            .map_err(|e| WaywiserError::Database(format!("serialize: {e}")))?;
        let updated = state.updated_at.to_rfc3339();

        conn.execute(
            "UPDATE sessions SET state_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_json, updated, id_str],
        )
        .map_err(|e| WaywiserError::Database(e.to_string()))?;

        Ok(())
    }

    async fn append_record(
        &self,
        session_id: SessionId,
        record_type: &str,
        data: &serde_json::Value,
    ) -> Result<(), WaywiserError> {
        let sid = session_id.to_string();
        let data_str = serde_json::to_string(data)
            .map_err(|e| WaywiserError::Database(format!("serialize record: {e}")))?;
        let ts = Utc::now().to_rfc3339();

        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        conn.execute(
            "INSERT INTO operation_records (session_id, record_type, data_json, timestamp) \
             VALUES (?1, ?2, ?3, ?4)",
            params![sid, record_type, data_str, ts],
        )
        .map_err(|e| WaywiserError::Database(e.to_string()))?;

        Ok(())
    }

    async fn load_records(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<StoredRecord>, WaywiserError> {
        let sid = session_id.to_string();

        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, record_type, data_json, timestamp \
                 FROM operation_records WHERE session_id = ?1 ORDER BY id ASC",
            )
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        let rows = stmt
            .query_map(params![sid], |row| {
                let id: i64 = row.get(0)?;
                let session_id_str: String = row.get(1)?;
                let record_type: String = row.get(2)?;
                let data_json: String = row.get(3)?;
                let timestamp_str: String = row.get(4)?;
                Ok((id, session_id_str, record_type, data_json, timestamp_str))
            })
            .map_err(|e| WaywiserError::Database(e.to_string()))?;

        let mut records = Vec::new();
        for row in rows {
            let (id, session_id_str, record_type, data_json, timestamp_str) =
                row.map_err(|e| WaywiserError::Database(e.to_string()))?;

            let sid_uuid = Uuid::parse_str(&session_id_str)
                .map_err(|e| WaywiserError::Database(format!("bad uuid: {e}")))?;

            let data: serde_json::Value = serde_json::from_str(&data_json)
                .map_err(|e| WaywiserError::Database(format!("deserialize record: {e}")))?;

            let timestamp = chrono::DateTime::parse_from_rfc3339(&timestamp_str)
                .map_err(|e| WaywiserError::Database(format!("bad date: {e}")))?
                .with_timezone(&Utc);

            records.push(StoredRecord {
                id,
                session_id: SessionId::from_uuid(sid_uuid),
                record_type,
                data,
                timestamp,
            });
        }

        Ok(records)
    }

    async fn remove_entries(
        &self,
        session_id: SessionId,
        lane_id: LaneId,
        ids: &[EntryId],
    ) -> Result<(), WaywiserError> {
        let id_str = session_id.to_string();

        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        let state_json: String = conn
            .query_row(
                "SELECT state_json FROM sessions WHERE id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| WaywiserError::Database(e.to_string()))?
            .ok_or(WaywiserError::SessionNotFound(session_id))?;

        let mut state: SessionState = serde_json::from_str(&state_json)
            .map_err(|e| WaywiserError::Database(format!("deserialize: {e}")))?;

        let lane = state
            .lanes
            .iter_mut()
            .find(|l| l.id == lane_id)
            .ok_or(WaywiserError::LaneNotFound {
                lane_id: *lane_id.as_uuid(),
            })?;

        // Remove entries whose ID is in the removal set
        let id_set: std::collections::HashSet<_> = ids.iter().copied().collect();
        lane.entries.retain(|e| !id_set.contains(&e.id));
        state.updated_at = Utc::now();

        let new_json = serde_json::to_string(&state)
            .map_err(|e| WaywiserError::Database(format!("serialize: {e}")))?;
        let updated = state.updated_at.to_rfc3339();

        conn.execute(
            "UPDATE sessions SET state_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_json, updated, id_str],
        )
        .map_err(|e| WaywiserError::Database(e.to_string()))?;

        Ok(())
    }

    async fn record_mutation(&self, meta: MutationMeta) -> Result<(), WaywiserError> {
        let conn = self.conn.lock().map_err(|e| {
            WaywiserError::Database(format!("mutex poisoned: {e}"))
        })?;

        conn.execute(
            "INSERT INTO mutations (mutation_id, device_id, local_sequence, wall_clock) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                meta.mutation_id.to_string(),
                meta.device_id.to_string(),
                meta.local_sequence,
                meta.wall_clock.to_rfc3339(),
            ],
        )
        .map_err(|e| WaywiserError::Database(e.to_string()))?;

        Ok(())
    }
}
