/**
 * waywiser-brain — database store.
 *
 * Opens or creates the Brain SQLite database via Node's built-in
 * `node:sqlite` (`DatabaseSync`). Adds all Brain tables via idempotent
 * migrations (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
 * try/catch `ALTER TABLE`). When `dbPath` points at an existing Waywiser
 * database, Brain adds its tables alongside whatever schema is already
 * there — it never drops or truncates data it doesn't own.
 *
 * This module is the only place in the package that talks SQL. Every other
 * module goes through `BrainStore`'s typed methods.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  BrainConfig,
  BrainMemory,
  EvalCase,
  EvolutionRun,
  Experience,
  LearningResult,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  Observation,
  Procedure,
  ProcedureStatus,
  ProvenanceSource,
  SkillStatus,
  SkillVersion,
  VaultSyncRow,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row shapes (raw sqlite rows, snake_case)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function asString(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function asNullableString(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function asNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function asNullableNumber(v: unknown): number | null {
  return v === null || v === undefined ? null : asNumber(v);
}

function boolToInt(v: boolean | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
}

function intToBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return Number(v) !== 0;
}

/** Wraps a raw search string as an FTS5 phrase query so punctuation/hyphens
 * in user text never blow up the MATCH syntax parser. */
function ftsPhrase(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// BrainStore
// ---------------------------------------------------------------------------

export class BrainStore {
  db: DatabaseSync;

  constructor(dbPath: string) {
    // Ensure the parent directory exists (unless :memory:)
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    // WAL isn't supported for :memory: databases; SQLite just falls back
    // silently (journal_mode reports "memory"), so this is safe everywhere.
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
    } catch {
      // best-effort only
    }
    this.migrate();
  }

  // -------------------------------------------------------------------
  // Migrations
  // -------------------------------------------------------------------

  private migrate(): void {
    this.migrateMemoriesTable();
    this.migrateMemoriesFts();
    this.migrateEpisodesTable();
    this.migrateBrainTables();
  }

  /** Creates `memories` with the full (base + brain) column set if it
   * doesn't exist yet, then adds the brain-specific columns to whatever
   * `memories` table is already there (idempotent via try/catch — SQLite
   * has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). */
  private migrateMemoriesTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          source TEXT NOT NULL DEFAULT 'agent',
          verbatim TEXT,
          tags TEXT NOT NULL DEFAULT '',
          supersedes_id INTEGER,
          source_session TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
          access_count INTEGER NOT NULL DEFAULT 0,
          scope TEXT NOT NULL DEFAULT 'global',
          project_key TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          useful_count INTEGER NOT NULL DEFAULT 0,
          not_useful_count INTEGER NOT NULL DEFAULT 0
      );
    `);

    const brainColumns: Array<[string, string]> = [
      ["scope", "TEXT NOT NULL DEFAULT 'global'"],
      ["project_key", "TEXT"],
      ["status", "TEXT NOT NULL DEFAULT 'active'"],
      ["useful_count", "INTEGER NOT NULL DEFAULT 0"],
      ["not_useful_count", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [col, def] of brainColumns) {
      try {
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${col} ${def};`);
      } catch {
        // column already exists — expected on every restart
      }
    }

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mem_status ON memories(status);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project_key);");
  }

  /** Ensures `memories_fts` exists and uses the `unicode61` tokenizer.
   * Detects a stale ASCII-tokenized table by inspecting its stored SQL and
   * rebuilds it (and its index) when the tokenizer isn't unicode61. */
  private migrateMemoriesFts(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as
      | { sql: string }
      | undefined;
    // remove_diacritics 2 strips ALL diacritical marks during indexing AND querying.
    // This means "decizii" matches "décizii", "ț" matches "t", "ă" matches "a".
    // Critical for Moldova (Romanian/Russian/English mix, with/without diacritics).
    const needsRebuild = !row || !row.sql.includes("remove_diacritics");

    if (needsRebuild) {
      this.db.exec("DROP TABLE IF EXISTS memories_fts;");
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            type, content, content='memories', content_rowid='id',
            tokenize='unicode61 remove_diacritics 2'
        );
      `);
      this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');");
    }

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS mem_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, type, content) VALUES (new.id, new.type, new.content);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS mem_fts_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, type, content) VALUES ('delete', old.id, old.type, old.content);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS mem_fts_au AFTER UPDATE OF type, content ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, type, content) VALUES ('delete', old.id, old.type, old.content);
          INSERT INTO memories_fts(rowid, type, content) VALUES (new.id, new.type, new.content);
      END;
    `);
  }

  private migrateEpisodesTable(): void {
    // Waywiser's original episodes table uses column `session`.
    // Brain's schema uses `session_id`. Accept either — CREATE TABLE IF NOT
    // EXISTS won't alter an existing table, and the index must match whatever
    // column the table actually has.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Check which column exists and index accordingly
    const cols = this.db.prepare("PRAGMA table_info(episodes)").all() as Array<{ name: string }>;
    const hasSessionId = cols.some((c) => c.name === "session_id");
    const hasSession = cols.some((c) => c.name === "session");
    try {
      if (hasSessionId) {
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);");
      } else if (hasSession) {
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session);");
      }
    } catch {
      // Index may already exist — ignore
    }
  }

  private migrateBrainTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiences (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          session_file TEXT,
          branch_leaf TEXT,
          cwd TEXT,
          project_key TEXT,
          objective TEXT,
          outcome_status TEXT,
          outcome_confidence TEXT,
          outcome_summary TEXT,
          started_at TEXT NOT NULL,
          settled_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_exp_session ON experiences(session_id);
      CREATE INDEX IF NOT EXISTS idx_exp_project ON experiences(project_key);

      CREATE TABLE IF NOT EXISTS experience_observations (
          id TEXT PRIMARY KEY,
          experience_id TEXT NOT NULL,
          tool_call_id TEXT,
          tool TEXT NOT NULL,
          target_key TEXT,
          input_json TEXT,
          result TEXT NOT NULL,
          error_class TEXT,
          recovery_of TEXT,
          provenance TEXT NOT NULL,
          details_json TEXT,
          timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_obs_exp ON experience_observations(experience_id);
      CREATE INDEX IF NOT EXISTS idx_obs_target ON experience_observations(target_key);

      CREATE TABLE IF NOT EXISTS memory_evidence (
          memory_id INTEGER NOT NULL,
          experience_id TEXT NOT NULL,
          observation_id TEXT NOT NULL DEFAULT '',
          relation TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY(memory_id, experience_id, observation_id)
      );

      CREATE TABLE IF NOT EXISTS memory_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id INTEGER NOT NULL,
          experience_id TEXT NOT NULL,
          injected INTEGER NOT NULL DEFAULT 1,
          useful INTEGER,
          contradicted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_musage_mem ON memory_usage(memory_id);

      CREATE TABLE IF NOT EXISTS procedures (
          id TEXT PRIMARY KEY,
          key TEXT UNIQUE NOT NULL,
          trigger_text TEXT NOT NULL,
          avoid_text TEXT,
          prefer_text TEXT,
          confidence REAL NOT NULL DEFAULT 0.5,
          success_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'tentative',
          scope TEXT NOT NULL DEFAULT 'global',
          project_key TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_proc_status ON procedures(status);

      CREATE VIRTUAL TABLE IF NOT EXISTS procedures_fts USING fts5(
          trigger_text, avoid_text, prefer_text,
          content='procedures', content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS procedure_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          procedure_id TEXT NOT NULL,
          experience_id TEXT NOT NULL,
          observation_id TEXT,
          outcome TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pevid_proc ON procedure_evidence(procedure_id);

      CREATE TABLE IF NOT EXISTS skill_versions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          version_hash TEXT NOT NULL,
          parent_version TEXT,
          status TEXT NOT NULL DEFAULT 'candidate',
          source_procedure_ids TEXT,
          path TEXT NOT NULL,
          eval_run_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          promoted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sv_name ON skill_versions(name);
      CREATE INDEX IF NOT EXISTS idx_sv_status ON skill_versions(status);

      CREATE TABLE IF NOT EXISTS evolution_runs (
          id TEXT PRIMARY KEY,
          skill_version_id TEXT NOT NULL,
          baseline_version_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          result_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS eval_cases (
          id TEXT PRIMARY KEY,
          skill_name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          oracle_json TEXT,
          safety_class TEXT NOT NULL DEFAULT 'safe',
          source_experience_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ec_skill ON eval_cases(skill_name);

      CREATE TABLE IF NOT EXISTS eval_runs (
          id TEXT PRIMARY KEY,
          evolution_run_id TEXT NOT NULL,
          case_id TEXT NOT NULL,
          treatment TEXT NOT NULL,
          outcome_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS vault_sync (
          file_path TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          memory_id INTEGER,
          procedure_id TEXT,
          last_synced TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS brain_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          details TEXT NOT NULL,
          experience_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS proc_fts_ai AFTER INSERT ON procedures BEGIN
          INSERT INTO procedures_fts(rowid, trigger_text, avoid_text, prefer_text)
          VALUES (new.rowid, new.trigger_text, new.avoid_text, new.prefer_text);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS proc_fts_ad AFTER DELETE ON procedures BEGIN
          INSERT INTO procedures_fts(procedures_fts, rowid, trigger_text, avoid_text, prefer_text)
          VALUES ('delete', old.rowid, old.trigger_text, old.avoid_text, old.prefer_text);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS proc_fts_au AFTER UPDATE OF trigger_text, avoid_text, prefer_text ON procedures BEGIN
          INSERT INTO procedures_fts(procedures_fts, rowid, trigger_text, avoid_text, prefer_text)
          VALUES ('delete', old.rowid, old.trigger_text, old.avoid_text, old.prefer_text);
          INSERT INTO procedures_fts(rowid, trigger_text, avoid_text, prefer_text)
          VALUES (new.rowid, new.trigger_text, new.avoid_text, new.prefer_text);
      END;
    `);
  }

  // -------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------

  /** No dedicated `sessions` table exists in the schema — session
   * boundaries are recorded through the generic brain_log so every other
   * module can observe them via getRecentLogs() without a new table. */
  beginSession(sessionId: string): void {
    this.logBrain("session_start", sessionId);
  }

  // -------------------------------------------------------------------
  // Experiences
  // -------------------------------------------------------------------

  recordExperience(exp: Experience): void {
    this.db
      .prepare(
        `INSERT INTO experiences
          (id, session_id, session_file, branch_leaf, cwd, project_key, objective,
           outcome_status, outcome_confidence, outcome_summary, started_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        exp.id,
        exp.sessionId,
        exp.sessionFile,
        exp.branchLeaf,
        exp.cwd,
        exp.projectKey,
        exp.objective,
        exp.outcome.status,
        exp.outcome.confidence,
        exp.outcome.summary,
        exp.startedAt,
        exp.settledAt,
      );
  }

  getExperience(id: string): Experience | null {
    const row = this.db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      sessionFile: asString(row.session_file),
      branchLeaf: asString(row.branch_leaf),
      cwd: asString(row.cwd),
      projectKey: asString(row.project_key),
      objective: asString(row.objective),
      outcome: {
        status: (row.outcome_status as Experience["outcome"]["status"]) ?? "unknown",
        confidence: (row.outcome_confidence as Experience["outcome"]["confidence"]) ?? "unknown",
        summary: asString(row.outcome_summary),
      },
      observations: this.getObservations(id),
      recalledMemoryIds: [],
      recalledProcedureIds: [],
      skillsUsed: [],
      externalSources: [],
      startedAt: asString(row.started_at),
      settledAt: asString(row.settled_at),
    };
  }

  // -------------------------------------------------------------------
  // Observations
  // -------------------------------------------------------------------

  recordObservations(experienceId: string, observations: Observation[]): void {
    if (observations.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO experience_observations
        (id, experience_id, tool_call_id, tool, target_key, input_json, result,
         error_class, recovery_of, provenance, details_json, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const obs of observations) {
        stmt.run(
          obs.id,
          experienceId,
          obs.toolCallId ?? null,
          obs.tool,
          obs.targetKey ?? null,
          obs.input ? JSON.stringify(obs.input) : null,
          obs.result,
          obs.errorClass ?? null,
          obs.recoveryOf ?? null,
          obs.provenance,
          obs.detailsJson ?? null,
          obs.timestamp,
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getObservations(experienceId: string): Observation[] {
    const rows = this.db
      .prepare("SELECT * FROM experience_observations WHERE experience_id = ? ORDER BY timestamp ASC")
      .all(experienceId) as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      toolCallId: asString(row.tool_call_id),
      tool: asString(row.tool),
      targetKey: asString(row.target_key),
      input: row.input_json ? (JSON.parse(String(row.input_json)) as Record<string, unknown>) : {},
      result: row.result as Observation["result"],
      errorClass: asNullableString(row.error_class) ?? undefined,
      recoveryOf: asNullableString(row.recovery_of) ?? undefined,
      provenance: row.provenance as ProvenanceSource,
      detailsJson: asNullableString(row.details_json) ?? undefined,
      timestamp: asString(row.timestamp),
    }));
  }

  // -------------------------------------------------------------------
  // Memories
  // -------------------------------------------------------------------

  private rowToBrainMemory(row: Row): BrainMemory {
    return {
      id: asNumber(row.id),
      type: row.type as MemoryType,
      content: asString(row.content),
      confidence: asNumber(row.confidence),
      source: row.source as ProvenanceSource,
      scope: row.scope as MemoryScope,
      projectKey: asNullableString(row.project_key),
      status: row.status as MemoryStatus,
      verbatim: asNullableString(row.verbatim),
      tags: asString(row.tags),
      supersedesId: asNullableNumber(row.supersedes_id),
      sourceSession: asString(row.source_session),
      createdAt: asString(row.created_at),
      lastAccessed: asString(row.last_accessed),
      accessCount: asNumber(row.access_count),
      usefulCount: asNumber(row.useful_count),
      notUsefulCount: asNumber(row.not_useful_count),
    };
  }

  getMemory(id: number): BrainMemory | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToBrainMemory(row) : null;
  }

  searchMemories(query: string, limit: number): BrainMemory[] {
    if (!query.trim()) return [];
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsPhrase(query), limit) as Row[];
    return rows.map((row) => this.rowToBrainMemory(row));
  }

  bumpAccessCount(memoryIds: number[]): void {
    if (memoryIds.length === 0) return;
    const placeholders = memoryIds.map(() => "?").join(", ");
    this.db
      .prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = datetime('now') WHERE id IN (${placeholders})`)
      .run(...memoryIds);
  }

  recordMemoryUsage(memoryId: number, experienceId: string, useful: boolean | null, contradicted: boolean): void {
    this.db
      .prepare(
        `INSERT INTO memory_usage (memory_id, experience_id, injected, useful, contradicted)
         VALUES (?, ?, 1, ?, ?)`,
      )
      .run(memoryId, experienceId, boolToInt(useful), boolToInt(contradicted) ?? 0);

    if (useful === true) {
      this.db.prepare("UPDATE memories SET useful_count = useful_count + 1 WHERE id = ?").run(memoryId);
    } else if (useful === false) {
      this.db.prepare("UPDATE memories SET not_useful_count = not_useful_count + 1 WHERE id = ?").run(memoryId);
    }
  }

  getMemoryStats(): { active: number; frozen: number; archived: number } {
    const rows = this.db.prepare("SELECT status, COUNT(*) as c FROM memories GROUP BY status").all() as Row[];
    const stats = { active: 0, frozen: 0, archived: 0 };
    for (const row of rows) {
      const status = String(row.status);
      if (status === "active" || status === "frozen" || status === "archived") {
        stats[status] = asNumber(row.c);
      }
    }
    return stats;
  }

  // -------------------------------------------------------------------
  // Procedures
  // -------------------------------------------------------------------

  private rowToProcedure(row: Row): Procedure {
    return {
      id: asString(row.id),
      key: asString(row.key),
      triggerText: asString(row.trigger_text),
      avoidText: asNullableString(row.avoid_text),
      preferText: asNullableString(row.prefer_text),
      confidence: asNumber(row.confidence),
      successCount: asNumber(row.success_count),
      failureCount: asNumber(row.failure_count),
      status: row.status as ProcedureStatus,
      scope: row.scope as MemoryScope,
      projectKey: asNullableString(row.project_key),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    };
  }

  getProcedure(key: string): Procedure | null {
    const row = this.db.prepare("SELECT * FROM procedures WHERE key = ?").get(key) as Row | undefined;
    return row ? this.rowToProcedure(row) : null;
  }

  getProcedureById(id: string): Procedure | null {
    const row = this.db.prepare("SELECT * FROM procedures WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToProcedure(row) : null;
  }

  upsertProcedure(p: {
    id: string;
    key: string;
    triggerText: string;
    avoidText?: string | null;
    preferText?: string | null;
    confidence?: number;
    status?: string;
    scope?: string;
    projectKey?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO procedures (id, key, trigger_text, avoid_text, prefer_text, confidence, status, scope, project_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           trigger_text = excluded.trigger_text,
           avoid_text = excluded.avoid_text,
           prefer_text = excluded.prefer_text,
           confidence = excluded.confidence,
           status = excluded.status,
           scope = excluded.scope,
           project_key = excluded.project_key,
           updated_at = datetime('now')`,
      )
      .run(
        p.id,
        p.key,
        p.triggerText,
        p.avoidText ?? null,
        p.preferText ?? null,
        p.confidence ?? 0.5,
        p.status ?? "tentative",
        p.scope ?? "global",
        p.projectKey ?? null,
      );
  }

  searchProcedures(query: string, limit: number): Procedure[] {
    if (!query.trim()) return [];
    const rows = this.db
      .prepare(
        `SELECT p.* FROM procedures_fts
         JOIN procedures p ON p.rowid = procedures_fts.rowid
         WHERE procedures_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsPhrase(query), limit) as Row[];
    return rows.map((row) => this.rowToProcedure(row));
  }

  recordProcedureEvidence(procedureId: string, experienceId: string, observationId: string | null, outcome: string): void {
    this.db
      .prepare(
        `INSERT INTO procedure_evidence (procedure_id, experience_id, observation_id, outcome)
         VALUES (?, ?, ?, ?)`,
      )
      .run(procedureId, experienceId, observationId ?? null, outcome);

    if (outcome === "success") {
      this.db
        .prepare("UPDATE procedures SET success_count = success_count + 1, updated_at = datetime('now') WHERE id = ?")
        .run(procedureId);
    } else if (outcome === "failure") {
      this.db
        .prepare("UPDATE procedures SET failure_count = failure_count + 1, updated_at = datetime('now') WHERE id = ?")
        .run(procedureId);
    }
  }

  getMatureProcedures(minPositive: number, minExperiences: number, minSuccessRatio: number): Procedure[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM procedures p
         WHERE p.status IN ('reinforced', 'mature')
           AND p.success_count >= ?
           AND (p.failure_count * 1.0 / NULLIF(p.success_count + p.failure_count, 0)) <= (1.0 - ?)
           AND (SELECT COUNT(DISTINCT pe.experience_id) FROM procedure_evidence pe WHERE pe.procedure_id = p.id) >= ?`,
      )
      .all(minPositive, minSuccessRatio, minExperiences) as Row[];
    return rows.map((row) => this.rowToProcedure(row));
  }

  getProcedureStats(): { tentative: number; reinforced: number; mature: number } {
    const rows = this.db.prepare("SELECT status, COUNT(*) as c FROM procedures GROUP BY status").all() as Row[];
    const stats = { tentative: 0, reinforced: 0, mature: 0 };
    for (const row of rows) {
      const status = String(row.status);
      if (status === "tentative" || status === "reinforced" || status === "mature") {
        stats[status] = asNumber(row.c);
      }
    }
    return stats;
  }

  // -------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------

  private rowToSkillVersion(row: Row): SkillVersion {
    return {
      id: asString(row.id),
      name: asString(row.name),
      versionHash: asString(row.version_hash),
      parentVersion: asNullableString(row.parent_version),
      status: row.status as SkillStatus,
      sourceProcedureIds: row.source_procedure_ids ? (JSON.parse(String(row.source_procedure_ids)) as string[]) : [],
      path: asString(row.path),
      evalRunId: asNullableString(row.eval_run_id),
      createdAt: asString(row.created_at),
      promotedAt: asNullableString(row.promoted_at),
    };
  }

  getSkillVersion(id: string): SkillVersion | null {
    const row = this.db.prepare("SELECT * FROM skill_versions WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToSkillVersion(row) : null;
  }

  insertSkillVersion(sv: SkillVersion): void {
    this.db
      .prepare(
        `INSERT INTO skill_versions
          (id, name, version_hash, parent_version, status, source_procedure_ids, path, eval_run_id, created_at, promoted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sv.id,
        sv.name,
        sv.versionHash,
        sv.parentVersion ?? null,
        sv.status,
        JSON.stringify(sv.sourceProcedureIds ?? []),
        sv.path,
        sv.evalRunId ?? null,
        sv.createdAt,
        sv.promotedAt ?? null,
      );
  }

  updateSkillStatus(id: string, status: string, promotedAt?: string): void {
    if (promotedAt !== undefined) {
      this.db.prepare("UPDATE skill_versions SET status = ?, promoted_at = ? WHERE id = ?").run(status, promotedAt, id);
    } else {
      this.db.prepare("UPDATE skill_versions SET status = ? WHERE id = ?").run(status, id);
    }
  }

  getActiveSkills(): SkillVersion[] {
    const rows = this.db.prepare("SELECT * FROM skill_versions WHERE status = 'active'").all() as Row[];
    return rows.map((row) => this.rowToSkillVersion(row));
  }

  getCandidateSkills(): SkillVersion[] {
    const rows = this.db.prepare("SELECT * FROM skill_versions WHERE status = 'candidate'").all() as Row[];
    return rows.map((row) => this.rowToSkillVersion(row));
  }

  // -------------------------------------------------------------------
  // Evolution
  // -------------------------------------------------------------------

  insertEvolutionRun(run: EvolutionRun): void {
    this.db
      .prepare(
        `INSERT INTO evolution_runs
          (id, skill_version_id, baseline_version_id, status, result_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.skillVersionId,
        run.baselineVersionId ?? null,
        run.status,
        run.resultJson ?? null,
        run.createdAt,
        run.completedAt ?? null,
      );
  }

  updateEvolutionRun(id: string, status: string, resultJson?: string): void {
    const isTerminal = status === "passed" || status === "failed" || status === "cancelled";
    if (resultJson !== undefined) {
      this.db
        .prepare(
          `UPDATE evolution_runs SET status = ?, result_json = ?, completed_at = ${isTerminal ? "datetime('now')" : "completed_at"} WHERE id = ?`,
        )
        .run(status, resultJson, id);
    } else {
      this.db
        .prepare(`UPDATE evolution_runs SET status = ?, completed_at = ${isTerminal ? "datetime('now')" : "completed_at"} WHERE id = ?`)
        .run(status, id);
    }
  }

  // -------------------------------------------------------------------
  // Eval
  // -------------------------------------------------------------------

  private rowToEvalCase(row: Row): EvalCase {
    return {
      id: asString(row.id),
      skillName: asString(row.skill_name),
      prompt: asString(row.prompt),
      oracleJson: asNullableString(row.oracle_json),
      safetyClass: asString(row.safety_class),
      sourceExperienceId: asNullableString(row.source_experience_id),
      createdAt: asString(row.created_at),
    };
  }

  insertEvalCase(c: EvalCase): void {
    this.db
      .prepare(
        `INSERT INTO eval_cases (id, skill_name, prompt, oracle_json, safety_class, source_experience_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.skillName, c.prompt, c.oracleJson ?? null, c.safetyClass, c.sourceExperienceId ?? null, c.createdAt);
  }

  getEvalCases(skillName: string): EvalCase[] {
    const rows = this.db.prepare("SELECT * FROM eval_cases WHERE skill_name = ?").all(skillName) as Row[];
    return rows.map((row) => this.rowToEvalCase(row));
  }

  // -------------------------------------------------------------------
  // Vault
  // -------------------------------------------------------------------

  private rowToVaultSyncRow(row: Row): VaultSyncRow {
    return {
      filePath: asString(row.file_path),
      contentHash: asString(row.content_hash),
      memoryId: asNullableNumber(row.memory_id),
      procedureId: asNullableString(row.procedure_id),
      lastSynced: asString(row.last_synced),
    };
  }

  getVaultSyncState(filePath: string): VaultSyncRow | null {
    const row = this.db.prepare("SELECT * FROM vault_sync WHERE file_path = ?").get(filePath) as Row | undefined;
    return row ? this.rowToVaultSyncRow(row) : null;
  }

  upsertVaultSync(filePath: string, contentHash: string, memoryId?: number | null, procedureId?: string | null): void {
    this.db
      .prepare(
        `INSERT INTO vault_sync (file_path, content_hash, memory_id, procedure_id, last_synced)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           content_hash = excluded.content_hash,
           memory_id = excluded.memory_id,
           procedure_id = excluded.procedure_id,
           last_synced = datetime('now')`,
      )
      .run(filePath, contentHash, memoryId ?? null, procedureId ?? null);
  }

  getAllVaultSync(): VaultSyncRow[] {
    const rows = this.db.prepare("SELECT * FROM vault_sync").all() as Row[];
    return rows.map((row) => this.rowToVaultSyncRow(row));
  }

  // -------------------------------------------------------------------
  // Memory Evidence
  // -------------------------------------------------------------------

  recordMemoryEvidence(memoryId: number, experienceId: string, observationId: string | null, relation: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_evidence (memory_id, experience_id, observation_id, relation)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(memory_id, experience_id, observation_id) DO UPDATE SET relation = excluded.relation`,
      )
      .run(memoryId, experienceId, observationId ?? "", relation);
  }

  getMemoryEvidence(memoryId: number): Array<{ experienceId: string; observationId: string | null; relation: string }> {
    const rows = this.db
      .prepare("SELECT * FROM memory_evidence WHERE memory_id = ? ORDER BY created_at ASC")
      .all(memoryId) as Row[];
    return rows.map((row) => ({
      experienceId: asString(row.experience_id),
      observationId: row.observation_id ? String(row.observation_id) : null,
      relation: asString(row.relation),
    }));
  }

  // -------------------------------------------------------------------
  // Learning Results (batch insert, transactional)
  // -------------------------------------------------------------------

  storeLearningResults(results: LearningResult, experienceId: string): void {
    this.db.exec("BEGIN");
    try {
      const insertMemory = this.db.prepare(
        `INSERT INTO memories
          (type, content, confidence, source, scope, project_key, verbatim, supersedes_id, source_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const mem of results.memories) {
        insertMemory.run(
          mem.type,
          mem.content,
          mem.confidence,
          mem.source,
          mem.scope,
          mem.projectKey ?? null,
          mem.verbatim ?? null,
          mem.supersedesId ?? null,
          experienceId,
        );
      }

      for (const update of results.procedureUpdates) {
        const existing = this.db.prepare("SELECT id FROM procedures WHERE key = ?").get(update.key) as
          | { id: string }
          | undefined;
        const procedureId = existing ? existing.id : `proc_${randomUUID()}`;
        this.upsertProcedure({
          id: procedureId,
          key: update.key,
          triggerText: update.triggerText,
          avoidText: update.avoidText,
          preferText: update.preferText,
        });
        this.recordProcedureEvidence(procedureId, update.experienceId, update.observationId, update.outcome);
      }

      for (const usage of results.usageRecords) {
        this.recordMemoryUsage(usage.memoryId, experienceId, usage.useful, usage.contradicted);
      }

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // -------------------------------------------------------------------
  // Episodes
  // -------------------------------------------------------------------

  appendEpisode(sessionId: string, summary: string): void {
    // Waywiser's original episodes table uses `session`; brain's uses `session_id`.
    // Detect which column exists and use it.
    try {
      this.db.prepare("INSERT INTO episodes (session_id, summary) VALUES (?, ?)").run(sessionId, summary);
    } catch {
      try {
        this.db.prepare("INSERT INTO episodes (session, summary) VALUES (?, ?)").run(sessionId, summary);
      } catch { /* episodes table may not exist at all — best effort */ }
    }
  }

  // -------------------------------------------------------------------
  // Brain Log
  // -------------------------------------------------------------------

  logBrain(kind: string, details: string, experienceId?: string): void {
    this.db
      .prepare("INSERT INTO brain_log (kind, details, experience_id) VALUES (?, ?, ?)")
      .run(kind, details, experienceId ?? null);
  }

  getRecentLogs(limit = 20): Array<{ kind: string; details: string; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT kind, details, created_at FROM brain_log ORDER BY id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((row) => ({
      kind: asString(row.kind),
      details: asString(row.details),
      createdAt: asString(row.created_at),
    }));
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Convenience constructor
// ---------------------------------------------------------------------------

export function openBrainStore(config: BrainConfig): BrainStore {
  return new BrainStore(config.dbPath);
}
