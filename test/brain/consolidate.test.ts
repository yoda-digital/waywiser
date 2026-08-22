import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { deterministicCleanup, findNearDuplicateClusters, consolidate } from "../../extensions/brain/consolidate.ts";
import { BrainStore } from "../../extensions/brain/store.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../extensions/brain/config.ts";

describe("consolidate", () => {
  let store: BrainStore;

  beforeEach(() => {
    store = new BrainStore(":memory:");
  });

  describe("deterministicCleanup", () => {
    it("marks superseded memories", () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES
          (1, 'fact', 'Old fact', 0.8, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0),
          (2, 'fact', 'New fact superseding old', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      store.db.exec("UPDATE memories SET supersedes_id = 1 WHERE id = 2");

      const result = deterministicCleanup(store, DEFAULT_BRAIN_CONFIG);
      assert.equal(result.supersededRemoved, 1);

      const old = store.db.prepare("SELECT status FROM memories WHERE id = 1").get() as any;
      assert.equal(old.status, "superseded");
    });

    it("archives stale non-user memories", () => {
      const staleDate = new Date(Date.now() - 100 * 86400000).toISOString();
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES
          (1, 'fact', 'Old fact', 0.5, 'agent', 'global', 'active', '', '', '${staleDate}', 0, 0, 0),
          (2, 'fact', 'User fact', 0.9, 'user', 'global', 'active', '', '', '${staleDate}', 0, 0, 0)
      `);

      const result = deterministicCleanup(store, DEFAULT_BRAIN_CONFIG);
      assert.equal(result.staleArchived, 1); // only agent-sourced

      const agent = store.db.prepare("SELECT status FROM memories WHERE id = 1").get() as any;
      assert.equal(agent.status, "archived");
      const user = store.db.prepare("SELECT status FROM memories WHERE id = 2").get() as any;
      assert.equal(user.status, "active"); // user memories never auto-archived
    });

    it("retires failing procedures", () => {
      const oldDate = new Date(Date.now() - 10 * 86400000).toISOString();
      store.upsertProcedure({
        id: "proc_1", key: "bad-proc", triggerText: "trigger",
        confidence: 0.3, status: "tentative",
      });
      // Manually set counts and date
      store.db.exec(`
        UPDATE procedures SET success_count = 1, failure_count = 5, created_at = '${oldDate}' WHERE id = 'proc_1'
      `);

      const result = deterministicCleanup(store, DEFAULT_BRAIN_CONFIG);
      assert.equal(result.proceduresRetired, 1);
    });

    it("does not retire young procedures", () => {
      store.upsertProcedure({
        id: "proc_1", key: "new-bad", triggerText: "trigger",
        confidence: 0.3, status: "tentative",
      });
      store.db.exec("UPDATE procedures SET success_count = 1, failure_count = 5 WHERE id = 'proc_1'");
      // created_at is now (< 7 days ago)

      const result = deterministicCleanup(store, DEFAULT_BRAIN_CONFIG);
      assert.equal(result.proceduresRetired, 0);
    });
  });

  describe("findNearDuplicateClusters", () => {
    it("clusters similar memories", () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES
          (1, 'fact', 'The project uses PostgreSQL database version 15', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0),
          (2, 'fact', 'The project uses PostgreSQL database', 0.8, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0),
          (3, 'fact', 'We prefer dark mode for all editors', 0.7, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);

      const clusters = findNearDuplicateClusters(store);
      assert.equal(clusters.length, 1);
      assert.equal(clusters[0].length, 2);
      // Memories 1 and 2 should be clustered
      const ids = clusters[0].map(m => m.id).sort();
      assert.deepEqual(ids, [1, 2]);
    });

    it("returns empty for no duplicates", () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES
          (1, 'fact', 'PostgreSQL database', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0),
          (2, 'fact', 'Dark mode preference', 0.8, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);

      const clusters = findNearDuplicateClusters(store);
      assert.equal(clusters.length, 0);
    });

    it("returns empty for fewer than 2 active memories", () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES
          (1, 'fact', 'Only one memory here', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);

      const clusters = findNearDuplicateClusters(store);
      assert.equal(clusters.length, 0);
    });
  });

  describe("consolidate (full, no LLM)", () => {
    it("runs all deterministic phases and returns report", async () => {
      const report = await consolidate(store, null, DEFAULT_BRAIN_CONFIG);
      assert.ok(report.report.includes("Consolidation Report"));
      assert.ok(report.report.includes("No changes needed"));
      assert.equal(report.nearDuplicatesMerged, 0);
      assert.equal(report.contradictionsFound, 0);
    });

    it("flags mature procedures", async () => {
      store.upsertProcedure({
        id: "proc_1", key: "mature-proc", triggerText: "trigger",
        avoidText: "bad", preferText: "good",
        confidence: 0.8, status: "reinforced",
      });
      store.db.exec("UPDATE procedures SET success_count = 5, failure_count = 0 WHERE id = 'proc_1'");
      // Add evidence from 3 distinct experiences
      store.recordProcedureEvidence("proc_1", "exp_1", null, "success");
      store.recordProcedureEvidence("proc_1", "exp_2", null, "success");
      store.recordProcedureEvidence("proc_1", "exp_3", null, "success");

      const report = await consolidate(store, null, DEFAULT_BRAIN_CONFIG);
      assert.equal(report.proceduresFlaggedMature, 1);

      const proc = store.getProcedure("mature-proc");
      assert.equal(proc?.status, "mature");
    });

    it("does not flag immature procedures", async () => {
      store.upsertProcedure({
        id: "proc_1", key: "young-proc", triggerText: "trigger",
        confidence: 0.5, status: "tentative",
      });
      store.recordProcedureEvidence("proc_1", "exp_1", null, "success");

      const report = await consolidate(store, null, DEFAULT_BRAIN_CONFIG);
      assert.equal(report.proceduresFlaggedMature, 0);

      const proc = store.getProcedure("young-proc");
      assert.equal(proc?.status, "tentative");
    });

    it("skips LLM phases entirely when pool is null, even with near-duplicate memories present", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES
          (1, 'fact', 'The project uses PostgreSQL database version 15', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0),
          (2, 'fact', 'The project uses PostgreSQL database', 0.8, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);

      const report = await consolidate(store, null, DEFAULT_BRAIN_CONFIG);
      assert.equal(report.nearDuplicatesMerged, 0);

      const mem1 = store.db.prepare("SELECT status FROM memories WHERE id = 1").get() as any;
      assert.equal(mem1.status, "active"); // untouched — no LLM ran to merge it
    });

    it("logs the consolidation run to brain_log", async () => {
      await consolidate(store, null, DEFAULT_BRAIN_CONFIG);
      const logs = store.getRecentLogs(5);
      assert.ok(logs.some(l => l.kind === "consolidation"));
    });
  });
});
