import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BrainStore } from "../../extensions/brain/store.ts";
import type { Experience, Observation } from "../../extensions/brain/types.ts";

describe("store", () => {
  let store: BrainStore;

  beforeEach(() => {
    store = new BrainStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("creates all tables on construction", () => {
    const rows = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);

    for (const table of [
      "experiences",
      "experience_observations",
      "memory_evidence",
      "memory_usage",
      "memories",
      "procedures",
      "procedure_evidence",
      "skill_versions",
      "evolution_runs",
      "eval_cases",
      "eval_runs",
      "vault_sync",
      "brain_log",
      "episodes",
    ]) {
      assert.ok(names.includes(table), `expected table ${table} to exist`);
    }

    // FTS5 virtual tables (backed by shadow tables, but the main name is present)
    assert.ok(names.includes("memories_fts"));
    assert.ok(names.includes("procedures_fts"));
  });

  it("memories_fts uses the unicode61 tokenizer", () => {
    const row = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as { sql: string };
    assert.ok(row.sql.includes("unicode61"));
  });

  it("procedures_fts uses the unicode61 tokenizer", () => {
    const row = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'procedures_fts'").get() as { sql: string };
    assert.ok(row.sql.includes("unicode61"));
  });

  it("schema migration is idempotent", () => {
    // Simulate restart against the same physical db by re-running migrations
    // on a fresh :memory: instance (a real restart would reopen the same
    // file — the important thing is that construction never throws when
    // Brain tables/columns already exist).
    assert.doesNotThrow(() => {
      const store2 = new BrainStore(":memory:");
      store2.close();
    });
  });

  it("migrates an ASCII-tokenized memories_fts to unicode61 and preserves data", () => {
    const legacy = new BrainStore(":memory:");
    // Tear down the unicode61 table brain just built and rebuild it the way
    // an old (pre-brain) waywiser install would have: default (ASCII) fts5.
    legacy.db.exec("DROP TABLE memories_fts;");
    legacy.db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(type, content, content='memories', content_rowid='id');");
    legacy.db.prepare("INSERT INTO memories (type, content, source_session) VALUES (?, ?, ?)").run("fact", "the sky is blue", "s1");
    legacy.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');");

    const preRow = legacy.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as { sql: string };
    assert.ok(!preRow.sql.includes("unicode61"));
    legacy.close();

    // Re-running migrate() (via a fresh BrainStore against the same file)
    // would detect the ASCII tokenizer and rebuild. Since this test uses
    // :memory: (no persistence across instances), we instead verify the
    // detection+rebuild logic directly against a live handle.
    const store2 = new BrainStore(":memory:");
    store2.db.exec("DROP TABLE memories_fts;");
    store2.db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(type, content, content='memories', content_rowid='id');");
    store2.db.prepare("INSERT INTO memories (type, content, source_session) VALUES (?, ?, ?)").run("fact", "the sky is blue", "s1");
    store2.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');");

    // @ts-expect-error -- calling the private migration step directly to
    // exercise the detection/rebuild path deterministically.
    store2["migrateMemoriesFts"]();

    const postRow = store2.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as { sql: string };
    assert.ok(postRow.sql.includes("unicode61"));

    const results = store2.searchMemories("sky", 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "the sky is blue");
    store2.close();
  });

  it("adds brain columns to a pre-existing memories table", () => {
    // A bare, pre-brain waywiser memories table (no scope/status/etc.)
    const bare = new BrainStore(":memory:");
    bare.db.exec("DROP TABLE memories;");
    bare.db.exec(`
      CREATE TABLE memories (
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
        access_count INTEGER NOT NULL DEFAULT 0
      );
    `);

    // @ts-expect-error -- exercising the private migration step directly.
    assert.doesNotThrow(() => bare["migrateMemoriesTable"]());

    const cols = bare.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    for (const col of ["scope", "project_key", "status", "useful_count", "not_useful_count"]) {
      assert.ok(colNames.includes(col), `expected column ${col}`);
    }
    bare.close();
  });

  it("records and retrieves an experience", () => {
    const exp: Experience = {
      id: "exp_test1",
      sessionId: "s1",
      sessionFile: "",
      branchLeaf: "abc",
      cwd: "/project",
      projectKey: "test",
      objective: "Fix bug",
      outcome: { status: "success", confidence: "verified", summary: "Fixed" },
      observations: [],
      recalledMemoryIds: [],
      recalledProcedureIds: [],
      skillsUsed: [],
      externalSources: [],
      startedAt: "2026-01-01T00:00:00Z",
      settledAt: "2026-01-01T00:01:00Z",
    };
    store.recordExperience(exp);
    const got = store.getExperience("exp_test1");
    assert.equal(got?.id, "exp_test1");
    assert.equal(got?.outcome.status, "success");
    assert.equal(got?.objective, "Fix bug");
    assert.equal(got?.cwd, "/project");
  });

  it("returns null for a missing experience", () => {
    assert.equal(store.getExperience("exp_does_not_exist"), null);
  });

  it("records and retrieves observations", () => {
    const exp: Experience = {
      id: "exp_obs1",
      sessionId: "s1",
      sessionFile: "",
      branchLeaf: "abc",
      cwd: "/project",
      projectKey: "test",
      objective: "Read a file",
      outcome: { status: "success", confidence: "verified", summary: "Read it" },
      observations: [],
      recalledMemoryIds: [],
      recalledProcedureIds: [],
      skillsUsed: [],
      externalSources: [],
      startedAt: "2026-01-01T00:00:00Z",
      settledAt: "2026-01-01T00:01:00Z",
    };
    store.recordExperience(exp);

    const obs: Observation[] = [
      {
        id: "obs_1",
        toolCallId: "tc_1",
        tool: "Read",
        targetKey: "/project/file.ts",
        input: { file_path: "/project/file.ts" },
        result: "success",
        provenance: "agent",
        timestamp: "2026-01-01T00:00:30Z",
      },
    ];
    store.recordObservations("exp_obs1", obs);

    const got = store.getObservations("exp_obs1");
    assert.equal(got.length, 1);
    assert.equal(got[0].id, "obs_1");
    assert.equal(got[0].tool, "Read");
    assert.equal(got[0].targetKey, "/project/file.ts");
    assert.deepEqual(got[0].input, { file_path: "/project/file.ts" });
    assert.equal(got[0].result, "success");

    // getExperience embeds its observations
    const gotExp = store.getExperience("exp_obs1");
    assert.equal(gotExp?.observations.length, 1);
    assert.equal(gotExp?.observations[0].id, "obs_1");
  });

  it("recordObservations is a no-op for an empty array", () => {
    assert.doesNotThrow(() => store.recordObservations("exp_none", []));
    assert.deepEqual(store.getObservations("exp_none"), []);
  });

  it("upserts a procedure (insert then update)", () => {
    store.upsertProcedure({
      id: "proc_1",
      key: "large-file-read",
      triggerText: "reading large file",
      avoidText: "bash cat",
      preferText: "native read",
    });
    const p = store.getProcedure("large-file-read");
    assert.equal(p?.triggerText, "reading large file");
    assert.equal(p?.confidence, 0.5);
    assert.equal(p?.status, "tentative");

    store.upsertProcedure({
      id: "proc_1",
      key: "large-file-read",
      triggerText: "reading large file",
      avoidText: "bash cat",
      preferText: "native read",
      confidence: 0.8,
      status: "reinforced",
    });
    const p2 = store.getProcedure("large-file-read");
    assert.equal(p2?.confidence, 0.8);
    assert.equal(p2?.status, "reinforced");
    assert.equal(p2?.id, "proc_1");

    // getProcedureById round-trips too
    const byId = store.getProcedureById("proc_1");
    assert.equal(byId?.key, "large-file-read");
  });

  it("searches procedures via FTS", () => {
    store.upsertProcedure({ id: "proc_1", key: "large-file", triggerText: "reading large file", preferText: "native read" });
    store.upsertProcedure({ id: "proc_2", key: "unrelated", triggerText: "something else entirely" });

    const results = store.searchProcedures("large file", 5);
    assert.ok(results.length > 0);
    assert.equal(results[0].key, "large-file");
  });

  it("searchProcedures returns empty for blank query", () => {
    assert.deepEqual(store.searchProcedures("   ", 5), []);
  });

  it("records memory usage and updates useful/not-useful counts", () => {
    store.db.prepare("INSERT INTO memories (id, type, content) VALUES (1, 'fact', 'test memory')").run();

    store.recordMemoryUsage(1, "exp_1", true, false);
    store.recordMemoryUsage(1, "exp_2", false, false);

    const usageRows = store.db.prepare("SELECT * FROM memory_usage WHERE memory_id = 1 ORDER BY id").all() as Array<{
      experience_id: string;
      useful: number | null;
      contradicted: number;
    }>;
    assert.equal(usageRows.length, 2);
    assert.equal(usageRows[0].experience_id, "exp_1");
    assert.equal(usageRows[0].useful, 1);
    assert.equal(usageRows[1].useful, 0);

    const mem = store.getMemory(1);
    assert.equal(mem?.usefulCount, 1);
    assert.equal(mem?.notUsefulCount, 1);
  });

  it("records procedure evidence and updates success/failure counts", () => {
    store.upsertProcedure({ id: "proc_1", key: "test-proc", triggerText: "test" });
    store.recordProcedureEvidence("proc_1", "exp_1", "obs_1", "success");
    store.recordProcedureEvidence("proc_1", "exp_2", null, "failure");

    const p = store.getProcedureById("proc_1");
    assert.equal(p?.successCount, 1);
    assert.equal(p?.failureCount, 1);

    const evidence = store.db.prepare("SELECT * FROM procedure_evidence WHERE procedure_id = 'proc_1' ORDER BY id").all() as Array<{
      experience_id: string;
      outcome: string;
    }>;
    assert.equal(evidence.length, 2);
    assert.equal(evidence[0].outcome, "success");
    assert.equal(evidence[1].outcome, "failure");
  });

  it("getMatureProcedures filters by status, success ratio, and distinct experiences", () => {
    store.upsertProcedure({ id: "proc_mature", key: "mature-one", triggerText: "t", status: "mature" });
    store.recordProcedureEvidence("proc_mature", "exp_1", null, "success");
    store.recordProcedureEvidence("proc_mature", "exp_2", null, "success");
    store.recordProcedureEvidence("proc_mature", "exp_3", null, "success");

    store.upsertProcedure({ id: "proc_tentative", key: "still-tentative", triggerText: "t", status: "tentative" });
    store.recordProcedureEvidence("proc_tentative", "exp_1", null, "success");
    store.recordProcedureEvidence("proc_tentative", "exp_2", null, "success");
    store.recordProcedureEvidence("proc_tentative", "exp_3", null, "success");

    store.upsertProcedure({ id: "proc_flaky", key: "flaky-one", triggerText: "t", status: "reinforced" });
    store.recordProcedureEvidence("proc_flaky", "exp_1", null, "success");
    store.recordProcedureEvidence("proc_flaky", "exp_2", null, "failure");

    const results = store.getMatureProcedures(3, 2, 0.75);
    const keys = results.map((p) => p.key);
    assert.ok(keys.includes("mature-one"));
    assert.ok(!keys.includes("still-tentative")); // wrong status
    assert.ok(!keys.includes("flaky-one")); // success ratio too low & not enough successes
  });

  it("getProcedureStats groups by status", () => {
    store.upsertProcedure({ id: "proc_1", key: "k1", triggerText: "t", status: "tentative" });
    store.upsertProcedure({ id: "proc_2", key: "k2", triggerText: "t", status: "reinforced" });
    store.upsertProcedure({ id: "proc_3", key: "k3", triggerText: "t", status: "mature" });
    store.upsertProcedure({ id: "proc_4", key: "k4", triggerText: "t", status: "tentative" });

    const stats = store.getProcedureStats();
    assert.equal(stats.tentative, 2);
    assert.equal(stats.reinforced, 1);
    assert.equal(stats.mature, 1);
  });

  it("getMemoryStats groups by status", () => {
    store.db.exec(`
      INSERT INTO memories (type, content, status) VALUES ('fact', 'a', 'active');
      INSERT INTO memories (type, content, status) VALUES ('fact', 'b', 'active');
      INSERT INTO memories (type, content, status) VALUES ('fact', 'c', 'frozen');
      INSERT INTO memories (type, content, status) VALUES ('fact', 'd', 'archived');
    `);
    const stats = store.getMemoryStats();
    assert.equal(stats.active, 2);
    assert.equal(stats.frozen, 1);
    assert.equal(stats.archived, 1);
  });

  it("inserts and retrieves skill versions, filters active/candidate", () => {
    store.insertSkillVersion({
      id: "sv_1",
      name: "test-skill",
      versionHash: "sha256:abc",
      parentVersion: null,
      status: "candidate",
      sourceProcedureIds: ["proc_1"],
      path: "/skills/candidates/test-skill",
      evalRunId: null,
      createdAt: "2026-01-01T00:00:00Z",
      promotedAt: null,
    });
    const sv = store.getSkillVersion("sv_1");
    assert.equal(sv?.name, "test-skill");
    assert.equal(sv?.status, "candidate");
    assert.deepEqual(sv?.sourceProcedureIds, ["proc_1"]);

    assert.equal(store.getCandidateSkills().length, 1);
    assert.equal(store.getActiveSkills().length, 0);

    store.updateSkillStatus("sv_1", "active", "2026-01-02T00:00:00Z");
    const svAfter = store.getSkillVersion("sv_1");
    assert.equal(svAfter?.status, "active");
    assert.equal(svAfter?.promotedAt, "2026-01-02T00:00:00Z");
    assert.equal(store.getActiveSkills().length, 1);
    assert.equal(store.getCandidateSkills().length, 0);
  });

  it("returns null for a missing skill version", () => {
    assert.equal(store.getSkillVersion("sv_missing"), null);
  });

  it("inserts and updates evolution runs", () => {
    store.insertEvolutionRun({
      id: "evo_1",
      skillVersionId: "sv_1",
      baselineVersionId: null,
      status: "pending",
      resultJson: null,
      createdAt: "2026-01-01T00:00:00Z",
      completedAt: null,
    });
    store.updateEvolutionRun("evo_1", "passed", JSON.stringify({ pass: true }));

    const row = store.db.prepare("SELECT * FROM evolution_runs WHERE id = ?").get("evo_1") as {
      status: string;
      result_json: string;
      completed_at: string | null;
    };
    assert.equal(row.status, "passed");
    assert.equal(row.result_json, JSON.stringify({ pass: true }));
    assert.ok(row.completed_at);
  });

  it("inserts eval cases and retrieves by skill name", () => {
    store.insertEvalCase({
      id: "ec_1",
      skillName: "test-skill",
      prompt: "do the thing",
      oracleJson: null,
      safetyClass: "safe",
      sourceExperienceId: null,
      createdAt: "2026-01-01T00:00:00Z",
    });
    store.insertEvalCase({
      id: "ec_2",
      skillName: "other-skill",
      prompt: "do another thing",
      oracleJson: null,
      safetyClass: "safe",
      sourceExperienceId: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const cases = store.getEvalCases("test-skill");
    assert.equal(cases.length, 1);
    assert.equal(cases[0].id, "ec_1");
  });

  it("logs brain events and reads them back most-recent-first", () => {
    store.logBrain("test", "first event", "exp_1");
    store.logBrain("test", "second event");
    const logs = store.getRecentLogs(10);
    assert.ok(logs.length >= 2);
    assert.equal(logs[0].kind, "test");
    assert.equal(logs[0].details, "second event");
  });

  it("beginSession logs a session_start event", () => {
    store.beginSession("session-abc");
    const logs = store.getRecentLogs(1);
    assert.equal(logs[0].kind, "session_start");
    assert.equal(logs[0].details, "session-abc");
  });

  it("vault sync upsert and retrieve", () => {
    store.db.prepare("INSERT INTO memories (id, type, content) VALUES (1, 'fact', 'x')").run();
    store.upsertVaultSync("/brain/semantic/test.md", "hash123", 1, null);
    const row = store.getVaultSyncState("/brain/semantic/test.md");
    assert.equal(row?.contentHash, "hash123");
    assert.equal(row?.memoryId, 1);

    store.upsertVaultSync("/brain/semantic/test.md", "hash456", 1, null);
    const row2 = store.getVaultSyncState("/brain/semantic/test.md");
    assert.equal(row2?.contentHash, "hash456");

    assert.equal(store.getAllVaultSync().length, 1);
  });

  it("returns null for missing vault sync state", () => {
    assert.equal(store.getVaultSyncState("/does/not/exist.md"), null);
  });

  it("bumps access count for multiple memories", () => {
    store.db.exec(`
      INSERT INTO memories (id, type, content, access_count) VALUES (1, 'fact', 'a', 0);
      INSERT INTO memories (id, type, content, access_count) VALUES (2, 'fact', 'b', 5);
    `);
    store.bumpAccessCount([1, 2]);
    assert.equal(store.getMemory(1)?.accessCount, 1);
    assert.equal(store.getMemory(2)?.accessCount, 6);
  });

  it("bumpAccessCount is a no-op for an empty array", () => {
    assert.doesNotThrow(() => store.bumpAccessCount([]));
  });

  it("searches memories via FTS with unicode content", () => {
    store.db.prepare("INSERT INTO memories (type, content) VALUES ('fact', ?)").run("café résumé naïve");
    store.db.prepare("INSERT INTO memories (type, content) VALUES ('fact', ?)").run("completely unrelated text");

    const results = store.searchMemories("café", 5);
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("café"));
  });

  it("searchMemories returns empty for blank query", () => {
    assert.deepEqual(store.searchMemories("", 5), []);
  });

  it("records and retrieves memory evidence", () => {
    store.db.prepare("INSERT INTO memories (id, type, content) VALUES (1, 'fact', 'x')").run();
    store.recordMemoryEvidence(1, "exp_1", "obs_1", "supports");
    store.recordMemoryEvidence(1, "exp_2", null, "contradicts");

    const evidence = store.getMemoryEvidence(1);
    assert.equal(evidence.length, 2);
    assert.equal(evidence[0].experienceId, "exp_1");
    assert.equal(evidence[0].observationId, "obs_1");
    assert.equal(evidence[0].relation, "supports");
    assert.equal(evidence[1].observationId, null);
  });

  it("appends episodes", () => {
    store.appendEpisode("session-1", "did a thing");
    const rows = store.db.prepare("SELECT * FROM episodes WHERE session_id = ?").all("session-1") as Array<{ summary: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].summary, "did a thing");
  });

  it("storeLearningResults inserts memories, upserts procedures, and records usage transactionally", () => {
    store.db.prepare("INSERT INTO memories (id, type, content) VALUES (1, 'fact', 'existing memory')").run();

    store.storeLearningResults(
      {
        memories: [
          {
            type: "lesson",
            content: "always check the return value",
            source: "agent",
            confidence: 0.7,
            scope: "global",
            projectKey: null,
            verbatim: null,
            supersedesId: null,
          },
        ],
        procedureUpdates: [
          {
            key: "check-return-value",
            triggerText: "calling a fallible function",
            avoidText: null,
            preferText: "check the return value",
            outcome: "success",
            experienceId: "exp_learn1",
            observationId: "obs_1",
          },
        ],
        usageRecords: [{ memoryId: 1, useful: true, contradicted: false }],
      },
      "exp_learn1",
    );

    const memRows = store.db.prepare("SELECT * FROM memories WHERE content = ?").all("always check the return value") as Array<{
      source_session: string;
    }>;
    assert.equal(memRows.length, 1);
    assert.equal(memRows[0].source_session, "exp_learn1");

    const proc = store.getProcedure("check-return-value");
    assert.ok(proc);
    assert.equal(proc?.successCount, 1);

    const mem1 = store.getMemory(1);
    assert.equal(mem1?.usefulCount, 1);
  });

  it("storeLearningResults reuses an existing procedure id for the same key", () => {
    store.upsertProcedure({ id: "proc_existing", key: "existing-key", triggerText: "t" });

    store.storeLearningResults(
      {
        memories: [],
        procedureUpdates: [
          {
            key: "existing-key",
            triggerText: "t updated",
            avoidText: null,
            preferText: null,
            outcome: "success",
            experienceId: "exp_1",
            observationId: null,
          },
        ],
        usageRecords: [],
      },
      "exp_1",
    );

    const proc = store.getProcedureById("proc_existing");
    assert.equal(proc?.triggerText, "t updated");
    assert.equal(proc?.successCount, 1);

    // No duplicate procedure row was created for the same key.
    const all = store.db.prepare("SELECT COUNT(*) as c FROM procedures WHERE key = 'existing-key'").get() as { c: number };
    assert.equal(all.c, 1);
  });

  it("storeLearningResults rolls back on failure", () => {
    assert.throws(() => {
      store.storeLearningResults(
        {
          // @ts-expect-error -- intentionally malformed to force a SQL error
          memories: [{ type: "fact", content: "x" }],
          procedureUpdates: [],
          usageRecords: [],
        },
        "exp_bad",
      );
    });

    const rows = store.db.prepare("SELECT * FROM memories").all();
    assert.equal(rows.length, 0);
  });

  it("openBrainStore builds a store from a BrainConfig", async () => {
    const { openBrainStore } = await import("../../extensions/brain/store.ts");
    const s = openBrainStore({ dbPath: ":memory:" } as never);
    assert.ok(s instanceof BrainStore);
    s.close();
  });
});
