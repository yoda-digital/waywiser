import initSqlJs, { type Database } from "sql.js";
import { readFileSync } from "fs";
import type { BrainMemory, Procedure, SkillVersion, EvolutionRun, BrainStats } from "./types";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

export class BrainDBReader {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async open(): Promise<void> {
    if (!SQL) {
      SQL = await initSqlJs();
    }
    const buffer = readFileSync(this.dbPath);
    this.db = new SQL.Database(buffer);
  }

  reload(): void {
    if (!SQL) return;
    try {
      const buffer = readFileSync(this.dbPath);
      this.db?.close();
      this.db = new SQL.Database(buffer);
    } catch {
      // File might be locked during write — skip this cycle
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private query<T>(sql: string, params: unknown[] = []): T[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare(sql);
      if (params.length) stmt.bind(params);
      const results: T[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push(row as T);
      }
      stmt.free();
      return results;
    } catch {
      return [];
    }
  }

  getStats(): BrainStats {
    const memRows = this.query<{ status: string; cnt: number }>(
      "SELECT status, COUNT(*) as cnt FROM memories GROUP BY status"
    );
    const procRows = this.query<{ status: string; cnt: number }>(
      "SELECT status, COUNT(*) as cnt FROM procedures GROUP BY status"
    );
    const skillRows = this.query<{ status: string; cnt: number }>(
      "SELECT status, COUNT(*) as cnt FROM skill_versions GROUP BY status"
    );
    const expCount = this.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM experiences"
    );
    const lastExp = this.query<{ settled_at: string }>(
      "SELECT settled_at FROM experiences ORDER BY settled_at DESC LIMIT 1"
    );
    const lastLog = this.query<{ created_at: string }>(
      "SELECT created_at FROM brain_log WHERE kind LIKE '%learn%' ORDER BY created_at DESC LIMIT 1"
    );

    const memMap: Record<string, number> = {};
    for (const r of memRows) memMap[r.status] = r.cnt;
    const procMap: Record<string, number> = {};
    for (const r of procRows) procMap[r.status] = r.cnt;
    const skillMap: Record<string, number> = {};
    for (const r of skillRows) skillMap[r.status] = r.cnt;

    return {
      memories: {
        active: memMap.active ?? 0,
        frozen: memMap.frozen ?? 0,
        archived: memMap.archived ?? 0,
        total: Object.values(memMap).reduce((a, b) => a + b, 0),
      },
      procedures: {
        tentative: procMap.tentative ?? 0,
        reinforced: procMap.reinforced ?? 0,
        mature: procMap.mature ?? 0,
        contradicted: procMap.contradicted ?? 0,
        total: Object.values(procMap).reduce((a, b) => a + b, 0),
      },
      skills: {
        active: skillMap.active ?? 0,
        candidates: skillMap.candidate ?? 0,
        total: Object.values(skillMap).reduce((a, b) => a + b, 0),
      },
      experiences: expCount[0]?.cnt ?? 0,
      lastExperience: lastExp[0]?.settled_at ?? null,
      lastLearning: lastLog[0]?.created_at ?? null,
    };
  }

  getMemories(filter?: { status?: string; type?: string; limit?: number }): BrainMemory[] {
    let sql = "SELECT * FROM memories WHERE 1=1";
    const params: unknown[] = [];
    if (filter?.status) { sql += " AND status = ?"; params.push(filter.status); }
    if (filter?.type) { sql += " AND type = ?"; params.push(filter.type); }
    sql += " ORDER BY last_accessed DESC";
    if (filter?.limit) { sql += " LIMIT ?"; params.push(filter.limit); }
    return this.query<BrainMemory>(sql, params);
  }

  getProcedures(filter?: { status?: string; limit?: number }): Procedure[] {
    let sql = "SELECT * FROM procedures WHERE 1=1";
    const params: unknown[] = [];
    if (filter?.status) { sql += " AND status = ?"; params.push(filter.status); }
    sql += " ORDER BY updated_at DESC";
    if (filter?.limit) { sql += " LIMIT ?"; params.push(filter.limit); }
    return this.query<Procedure>(sql, params);
  }

  getSkillVersions(filter?: { status?: string }): SkillVersion[] {
    let sql = "SELECT * FROM skill_versions WHERE 1=1";
    const params: unknown[] = [];
    if (filter?.status) { sql += " AND status = ?"; params.push(filter.status); }
    sql += " ORDER BY created_at DESC";
    return this.query<SkillVersion>(sql, params);
  }

  getEvolutionRuns(limit: number = 10): EvolutionRun[] {
    return this.query<EvolutionRun>(
      "SELECT * FROM evolution_runs ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
  }

  getRecentLogs(limit: number = 20): Array<{ kind: string; details: string; created_at: string }> {
    return this.query(
      "SELECT kind, details, created_at FROM brain_log ORDER BY id DESC LIMIT ?",
      [limit]
    );
  }

  getContradictions(): Array<{ details: string; created_at: string }> {
    return this.query(
      "SELECT details, created_at FROM brain_log WHERE kind = 'contradiction' ORDER BY created_at DESC"
    );
  }

  getMemoryEvidence(memoryId: number): Array<{ experience_id: string; relation: string }> {
    return this.query(
      "SELECT experience_id, relation FROM memory_evidence WHERE memory_id = ?",
      [memoryId]
    );
  }
}
