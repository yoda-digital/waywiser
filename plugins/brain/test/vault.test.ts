import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  renderMemoryMarkdown,
  renderProcedureMarkdown,
  parseMemoryMarkdown,
  parseProcedureMarkdown,
  contentHash,
  memorySlug,
  procedureSlug,
  vaultSyncOutbound,
  vaultSyncInbound,
} from "../extensions/brain/vault.ts";
import { BrainStore } from "../extensions/brain/store.ts";
import { DEFAULT_BRAIN_CONFIG } from "../extensions/brain/config.ts";
import type { BrainMemory, Procedure, BrainConfig } from "../extensions/brain/types.ts";

const SAMPLE_MEMORY: BrainMemory = {
  id: 42,
  type: "decision",
  content: "Use PostgreSQL for the database",
  confidence: 0.91,
  source: "user",
  scope: "project",
  projectKey: "waywiser",
  status: "active",
  verbatim: null,
  tags: "database,architecture",
  supersedesId: null,
  sourceSession: "s1",
  createdAt: "2026-08-15T10:30:00Z",
  lastAccessed: "2026-08-21T09:00:00Z",
  accessCount: 5,
  usefulCount: 3,
  notUsefulCount: 0,
};

const SAMPLE_PROCEDURE: Procedure = {
  id: "proc_abc",
  key: "large-file-read",
  triggerText: "Reading a large file",
  avoidText: "bash cat",
  preferText: "native read",
  confidence: 0.86,
  successCount: 7,
  failureCount: 1,
  status: "mature",
  scope: "global",
  projectKey: null,
  createdAt: "2026-08-10T08:00:00Z",
  updatedAt: "2026-08-20T14:30:00Z",
};

describe("vault", () => {
  describe("renderMemoryMarkdown", () => {
    it("renders memory with frontmatter and content", () => {
      const md = renderMemoryMarkdown(SAMPLE_MEMORY, ["exp_83 (created_from)"]);
      assert.ok(md.includes("id: 42"));
      assert.ok(md.includes("kind: decision"));
      assert.ok(md.includes("scope: project:waywiser"));
      assert.ok(md.includes("confidence: 0.91"));
      assert.ok(md.includes("status: active"));
      assert.ok(md.includes("source: user"));
      assert.ok(md.includes("tags: database,architecture"));
      assert.ok(md.includes("Use PostgreSQL"));
      assert.ok(md.includes("## Evidence"));
      assert.ok(md.includes("exp_83 (created_from)"));
    });

    it("omits tags line when tags is empty", () => {
      const md = renderMemoryMarkdown({ ...SAMPLE_MEMORY, tags: "" });
      assert.ok(!md.includes("tags:"));
    });

    it("uses bare scope for global/session memories", () => {
      const md = renderMemoryMarkdown({ ...SAMPLE_MEMORY, scope: "global", projectKey: null });
      assert.ok(md.includes("scope: global"));
      assert.ok(!md.includes("scope: global:"));
    });

    it("omits Evidence section when no evidence given", () => {
      const md = renderMemoryMarkdown(SAMPLE_MEMORY);
      assert.ok(!md.includes("## Evidence"));
    });
  });

  describe("renderProcedureMarkdown", () => {
    it("renders procedure with sections", () => {
      const md = renderProcedureMarkdown(SAMPLE_PROCEDURE, ["exp_12 (success)"]);
      assert.ok(md.includes("id: proc_abc"));
      assert.ok(md.includes("key: large-file-read"));
      assert.ok(md.includes("status: mature"));
      assert.ok(md.includes("success_count: 7"));
      assert.ok(md.includes("failure_count: 1"));
      assert.ok(md.includes("## Trigger"));
      assert.ok(md.includes("Reading a large file"));
      assert.ok(md.includes("## Avoid"));
      assert.ok(md.includes("bash cat"));
      assert.ok(md.includes("## Prefer"));
      assert.ok(md.includes("native read"));
      assert.ok(md.includes("## Evidence"));
      assert.ok(md.includes("exp_12 (success)"));
    });

    it("omits Avoid/Prefer sections when not set", () => {
      const md = renderProcedureMarkdown({ ...SAMPLE_PROCEDURE, avoidText: null, preferText: null });
      assert.ok(!md.includes("## Avoid"));
      assert.ok(!md.includes("## Prefer"));
      assert.ok(md.includes("## Trigger"));
    });
  });

  describe("parseMemoryMarkdown", () => {
    it("round-trips a rendered memory", () => {
      const md = renderMemoryMarkdown(SAMPLE_MEMORY);
      const parsed = parseMemoryMarkdown(md);
      assert.ok(parsed);
      assert.equal(parsed!.id, 42);
      assert.equal(parsed!.type, "decision");
      assert.equal(parsed!.scope, "project");
      assert.equal(parsed!.projectKey, "waywiser");
      assert.equal(parsed!.confidence, 0.91);
      assert.equal(parsed!.status, "active");
      assert.equal(parsed!.source, "user");
      assert.equal(parsed!.tags, "database,architecture");
      assert.equal(parsed!.content, "Use PostgreSQL for the database");
      assert.equal(parsed!.createdAt, "2026-08-15T10:30:00Z");
      assert.equal(parsed!.lastAccessed, "2026-08-21T09:00:00Z");
    });

    it("round-trips a global-scope memory without a projectKey", () => {
      const md = renderMemoryMarkdown({ ...SAMPLE_MEMORY, scope: "global", projectKey: null });
      const parsed = parseMemoryMarkdown(md);
      assert.ok(parsed);
      assert.equal(parsed!.scope, "global");
      assert.equal(parsed!.projectKey, null);
    });

    it("strips the Evidence section from parsed content", () => {
      const md = renderMemoryMarkdown(SAMPLE_MEMORY, ["exp_83 (created_from)", "exp_91 (reinforced_by)"]);
      const parsed = parseMemoryMarkdown(md);
      assert.ok(parsed);
      assert.equal(parsed!.content, "Use PostgreSQL for the database");
      assert.ok(!parsed!.content!.includes("Evidence"));
    });

    it("returns null for invalid content", () => {
      assert.equal(parseMemoryMarkdown("not valid"), null);
    });

    it("returns null for content with no frontmatter delimiters", () => {
      assert.equal(parseMemoryMarkdown("# Just a heading\n\nSome text"), null);
    });
  });

  describe("parseProcedureMarkdown", () => {
    it("round-trips a rendered procedure", () => {
      const md = renderProcedureMarkdown(SAMPLE_PROCEDURE);
      const parsed = parseProcedureMarkdown(md);
      assert.ok(parsed);
      assert.equal(parsed!.id, "proc_abc");
      assert.equal(parsed!.key, "large-file-read");
      assert.equal(parsed!.status, "mature");
      assert.equal(parsed!.confidence, 0.86);
      assert.equal(parsed!.scope, "global");
      assert.equal(parsed!.successCount, 7);
      assert.equal(parsed!.failureCount, 1);
      assert.equal(parsed!.triggerText, "Reading a large file");
      assert.equal(parsed!.avoidText, "bash cat");
      assert.equal(parsed!.preferText, "native read");
    });

    it("round-trips a procedure with no Avoid/Prefer sections", () => {
      const md = renderProcedureMarkdown({ ...SAMPLE_PROCEDURE, avoidText: null, preferText: null });
      const parsed = parseProcedureMarkdown(md);
      assert.ok(parsed);
      assert.equal(parsed!.triggerText, "Reading a large file");
      assert.equal(parsed!.avoidText, null);
      assert.equal(parsed!.preferText, null);
    });

    it("returns null for invalid content", () => {
      assert.equal(parseProcedureMarkdown("not valid"), null);
    });
  });

  describe("contentHash", () => {
    it("produces a deterministic hash", () => {
      assert.equal(contentHash("foo"), contentHash("foo"));
    });

    it("produces different hashes for different content", () => {
      assert.notEqual(contentHash("foo"), contentHash("bar"));
    });
  });

  describe("memorySlug", () => {
    it("generates a slug from type and content", () => {
      const slug = memorySlug(SAMPLE_MEMORY);
      assert.ok(slug.startsWith("decision-"));
      assert.ok(slug.includes("postgresql"));
    });

    it("falls back to id when content has no letters/digits", () => {
      const slug = memorySlug({ ...SAMPLE_MEMORY, content: "???" });
      assert.equal(slug, "decision-42");
    });
  });

  describe("procedureSlug", () => {
    it("generates a slug from the key", () => {
      assert.equal(procedureSlug(SAMPLE_PROCEDURE), "large-file-read");
    });

    it("falls back to id when key has no letters/digits", () => {
      assert.equal(procedureSlug({ ...SAMPLE_PROCEDURE, key: "???" }), "proc_abc");
    });
  });

  describe("vaultSyncOutbound + vaultSyncInbound", () => {
    let tmpDir: string;
    let config: BrainConfig;
    let store: BrainStore;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-vault-test-"));
      config = { ...DEFAULT_BRAIN_CONFIG, markdownRoot: tmpDir };
      store = new BrainStore(":memory:");
    });

    afterEach(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates the full vault directory structure", async () => {
      await vaultSyncOutbound(store, config);
      for (const sub of Object.values(config.vault.structure)) {
        assert.ok(fs.existsSync(path.join(tmpDir, sub)), `missing ${sub}`);
      }
    });

    it("writes memories to markdown files", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Test memory content', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);

      await vaultSyncOutbound(store, config);

      const files = fs.readdirSync(path.join(tmpDir, "semantic"));
      assert.equal(files.length, 1);
      const content = fs.readFileSync(path.join(tmpDir, "semantic", files[0]), "utf-8");
      assert.ok(content.includes("Test memory content"));
      assert.ok(content.includes("id: 1"));

      const syncState = store.getVaultSyncState(path.join(tmpDir, "semantic", files[0]));
      assert.ok(syncState);
      assert.equal(syncState!.memoryId, 1);
      assert.equal(syncState!.procedureId, null);
    });

    it("does not write non-active memories", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Archived content', 0.9, 'user', 'global', 'archived', '', '', datetime('now'), 0, 0, 0)
      `);

      await vaultSyncOutbound(store, config);
      const files = fs.readdirSync(path.join(tmpDir, "semantic"));
      assert.equal(files.length, 0);
    });

    it("writes procedures to markdown files and excludes retired ones", async () => {
      store.upsertProcedure({
        id: "proc_1",
        key: "keep-me",
        triggerText: "Trigger text",
        confidence: 0.8,
        status: "mature",
      });
      store.upsertProcedure({
        id: "proc_2",
        key: "retired-one",
        triggerText: "Should not appear",
        confidence: 0.2,
        status: "retired",
      });

      await vaultSyncOutbound(store, config);

      const files = fs.readdirSync(path.join(tmpDir, "procedures"));
      assert.equal(files.length, 1);
      assert.equal(files[0], "keep-me.md");
    });

    it("includes evidence in written memory markdown", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Evidenced content', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      store.recordMemoryEvidence(1, "exp_1", "obs_1", "created_from");

      await vaultSyncOutbound(store, config);

      const files = fs.readdirSync(path.join(tmpDir, "semantic"));
      const content = fs.readFileSync(path.join(tmpDir, "semantic", files[0]), "utf-8");
      assert.ok(content.includes("## Evidence"));
      assert.ok(content.includes("exp_1 (created_from)"));
    });

    it("detects and imports human edits on inbound sync", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Original content', 0.9, 'agent', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      await vaultSyncOutbound(store, config);

      const files = fs.readdirSync(path.join(tmpDir, "semantic"));
      const filePath = path.join(tmpDir, "semantic", files[0]);
      let fileContent = fs.readFileSync(filePath, "utf-8");
      fileContent = fileContent.replace("Original content", "Human edited content");
      fs.writeFileSync(filePath, fileContent);

      await vaultSyncInbound(store, config);

      const mem = store.db.prepare("SELECT content, source FROM memories WHERE id = 1").get() as any;
      assert.equal(mem.content, "Human edited content");
      assert.equal(mem.source, "user");

      // The sync state should now reflect the human-edited hash, so a
      // second inbound sync is a no-op.
      const syncState = store.getVaultSyncState(filePath);
      assert.equal(syncState!.contentHash, contentHash(fileContent));
    });

    it("imports human edits to procedures on inbound sync", async () => {
      store.upsertProcedure({
        id: "proc_1",
        key: "edit-me",
        triggerText: "Original trigger",
        confidence: 0.5,
        status: "tentative",
      });
      await vaultSyncOutbound(store, config);

      const files = fs.readdirSync(path.join(tmpDir, "procedures"));
      const filePath = path.join(tmpDir, "procedures", files[0]);
      let fileContent = fs.readFileSync(filePath, "utf-8");
      fileContent = fileContent.replace("Original trigger", "Edited trigger");
      fs.writeFileSync(filePath, fileContent);

      await vaultSyncInbound(store, config);

      const proc = store.db.prepare("SELECT trigger_text FROM procedures WHERE id = 'proc_1'").get() as any;
      assert.equal(proc.trigger_text, "Edited trigger");
    });

    it("skips unchanged files on outbound sync (no rewrite)", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Stable content', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);

      await vaultSyncOutbound(store, config);
      const files1 = fs.readdirSync(path.join(tmpDir, "semantic"));
      const mtime1 = fs.statSync(path.join(tmpDir, "semantic", files1[0])).mtimeMs;

      await new Promise((r) => setTimeout(r, 50));
      await vaultSyncOutbound(store, config);

      const mtime2 = fs.statSync(path.join(tmpDir, "semantic", files1[0])).mtimeMs;
      assert.equal(mtime1, mtime2);
    });

    it("skips unchanged files on inbound sync (no DB write)", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Untouched content', 0.9, 'agent', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      await vaultSyncOutbound(store, config);

      await vaultSyncInbound(store, config);

      const mem = store.db.prepare("SELECT source FROM memories WHERE id = 1").get() as any;
      assert.equal(mem.source, "agent"); // untouched — not imported as user
    });

    it("skips vault_sync entries whose file was deleted", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Doomed content', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      await vaultSyncOutbound(store, config);

      const files = fs.readdirSync(path.join(tmpDir, "semantic"));
      fs.rmSync(path.join(tmpDir, "semantic", files[0]));

      // Should not throw even though the tracked file no longer exists.
      await assert.doesNotReject(vaultSyncInbound(store, config));
    });

    it("rewrites a memory file whose content changed in the DB", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'First version', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      await vaultSyncOutbound(store, config);

      store.db.prepare("UPDATE memories SET content = 'Second version' WHERE id = 1").run();
      await vaultSyncOutbound(store, config);

      const files = fs.readdirSync(path.join(tmpDir, "semantic"));
      const content = fs.readFileSync(path.join(tmpDir, "semantic", files[0]), "utf-8");
      assert.ok(content.includes("Second version"));
      assert.ok(!content.includes("First version"));
    });

    it("logs a brain_log entry after outbound and inbound sync", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Logged content', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      await vaultSyncOutbound(store, config);
      await vaultSyncInbound(store, config);

      const logs = store.getRecentLogs(20);
      assert.ok(logs.some((l) => l.kind === "vault-sync-outbound"));
    });
  });
});
