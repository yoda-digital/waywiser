import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildRecallQuery, reciprocalRankFusion, recall } from "../extensions/brain/recall.ts";
import { BrainStore } from "../extensions/brain/store.ts";
import { DEFAULT_BRAIN_CONFIG } from "../extensions/brain/config.ts";

describe("recall", () => {
  describe("buildRecallQuery", () => {
    it("tokenizes ASCII text", () => {
      const terms = buildRecallQuery("fix the authentication bug in login");
      assert.ok(terms.includes("fix"));
      assert.ok(terms.includes("authentication"));
      assert.ok(terms.includes("bug"));
      assert.ok(terms.includes("login"));
      assert.ok(!terms.includes("the")); // stopword
      assert.ok(!terms.includes("in")); // stopword
    });

    it("tokenizes Romanian text", () => {
      const terms = buildRecallQuery("decizii importante despre proiect");
      assert.ok(terms.includes("decizii"));
      assert.ok(terms.includes("importante"));
      assert.ok(terms.includes("despre"));
      assert.ok(terms.includes("proiect"));
    });

    it("tokenizes Russian text", () => {
      const terms = buildRecallQuery("Проект использует PostgreSQL для данных");
      assert.ok(terms.includes("проект"));
      assert.ok(terms.includes("postgresql"));
    });

    it("removes stopwords", () => {
      const terms = buildRecallQuery("the quick and the furious");
      assert.ok(!terms.includes("the"));
      assert.ok(!terms.includes("and"));
      assert.ok(terms.includes("quick"));
      assert.ok(terms.includes("furious"));
    });

    it("limits terms to a reasonable count", () => {
      const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
      const terms = buildRecallQuery(long);
      assert.ok(terms.length <= 20, `got ${terms.length} terms, expected <= 20`);
    });

    it("deduplicates terms", () => {
      const terms = buildRecallQuery("bug bug bug fix fix");
      assert.equal(terms.filter((t) => t === "bug").length, 1);
    });

    it("returns empty for empty input", () => {
      assert.deepEqual(buildRecallQuery(""), []);
      assert.deepEqual(buildRecallQuery("the and for"), []);
    });
  });

  describe("reciprocalRankFusion", () => {
    it("fuses two rankings", () => {
      const rankings = [
        new Map([["a", 1], ["b", 2], ["c", 3]]),
        new Map([["b", 1], ["c", 2], ["a", 3]]),
      ];
      const fused = reciprocalRankFusion(rankings, [1.0, 1.0], 60);
      // b should rank highest: 1/(60+2) + 1/(60+1) vs a: 1/(60+1) + 1/(60+3)
      assert.equal(fused[0].id, "b");
    });

    it("respects weights", () => {
      const rankings = [
        new Map([["a", 1], ["b", 2]]),
        new Map([["b", 1], ["a", 2]]),
      ];
      // With lexical weight=10 and scope weight=1, a should win (rank 1 in high-weight signal)
      const fused = reciprocalRankFusion(rankings, [10.0, 1.0], 60);
      assert.equal(fused[0].id, "a");
    });

    it("handles items appearing in only one ranking", () => {
      const rankings = [
        new Map([["a", 1]]),
        new Map([["b", 1]]),
      ];
      const fused = reciprocalRankFusion(rankings, [1.0, 1.0], 60);
      assert.equal(fused.length, 2);
    });

    it("returns empty for empty rankings", () => {
      const fused = reciprocalRankFusion([], [], 60);
      assert.deepEqual(fused, []);
    });
  });

  describe("recall (integration with store)", () => {
    let store: BrainStore;

    beforeEach(() => {
      store = new BrainStore(":memory:");
      // Insert test memories
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, project_key, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES
          (1, 'fact', 'Project uses PostgreSQL for database', 0.9, 'user', 'project', 'myproject', 'active', '', '', datetime('now'), 0, 3, 0),
          (2, 'preference', 'User prefers dark mode in all editors', 0.8, 'user', 'global', NULL, 'active', '', '', datetime('now'), 0, 1, 0),
          (3, 'lesson', 'Large JSON files should use native read not cat', 0.7, 'agent', 'global', NULL, 'active', '', '', datetime('now'), 0, 2, 1)
      `);
      // Rebuild FTS
      store.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    });

    it("returns empty for recall=off", async () => {
      const result = await recall({
        prompt: "anything",
        cwd: "/project",
        projectKey: "myproject",
        config: { ...DEFAULT_BRAIN_CONFIG.recall, mode: "off" },
        scopingConfig: DEFAULT_BRAIN_CONFIG.scoping,
        store,
      });
      assert.equal(result.items.length, 0);
    });

    it("returns matching memories", async () => {
      const result = await recall({
        prompt: "PostgreSQL database setup",
        cwd: "/project",
        projectKey: "myproject",
        config: DEFAULT_BRAIN_CONFIG.recall,
        scopingConfig: DEFAULT_BRAIN_CONFIG.scoping,
        store,
      });
      assert.ok(result.items.length > 0);
      assert.ok(result.items.some((i) => i.content.includes("PostgreSQL")));
    });

    it("bumps access_count for returned memories", async () => {
      const before = store.db.prepare("SELECT access_count FROM memories WHERE id = 1").get() as any;
      await recall({
        prompt: "PostgreSQL database",
        cwd: "/project",
        projectKey: "myproject",
        config: DEFAULT_BRAIN_CONFIG.recall,
        scopingConfig: DEFAULT_BRAIN_CONFIG.scoping,
        store,
      });
      const after = store.db.prepare("SELECT access_count FROM memories WHERE id = 1").get() as any;
      assert.ok(after.access_count > before.access_count);
    });

    it("returns empty for no matching terms", async () => {
      const result = await recall({
        prompt: "the and for with",
        cwd: "/project",
        projectKey: null,
        config: DEFAULT_BRAIN_CONFIG.recall,
        scopingConfig: DEFAULT_BRAIN_CONFIG.scoping,
        store,
      });
      assert.equal(result.items.length, 0);
    });

    it("respects maxItems limit", async () => {
      const result = await recall({
        prompt: "PostgreSQL database dark mode JSON read cat",
        cwd: "/project",
        projectKey: "myproject",
        config: { ...DEFAULT_BRAIN_CONFIG.recall, maxItems: 1 },
        scopingConfig: DEFAULT_BRAIN_CONFIG.scoping,
        store,
      });
      assert.ok(result.items.length <= 1);
    });
  });
});
