/**
 * E2E tests proving Tier 1 (enhanced vault markdown) and Tier 2 (Obsidian
 * plugin) both work correctly for the Waywiser Brain project.
 *
 * Tier 1 exercises vault.ts's Obsidian-native rendering path (RenderContext):
 * wikilinks, typed Properties (tag arrays / cssclasses / aliases), callout
 * blocks, mermaid diagrams, MOC generation, canvas generation, and the
 * parse round-trip.
 *
 * Tier 2 can't drive the actual Obsidian runtime from Node, so it instead
 * proves the two halves of the contract independently: the brain package
 * produces a real sqlite file with the schema the plugin's db-reader.ts
 * expects, and the plugin itself has a built bundle + valid manifest +
 * all its source modules in place.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BrainStore } from "../extensions/brain/store.ts";
import { DEFAULT_BRAIN_CONFIG } from "../extensions/brain/config.ts";
import {
  renderMemoryMarkdown,
  renderProcedureMarkdown,
  parseMemoryMarkdown,
  parseProcedureMarkdown,
  vaultSyncOutbound,
  memorySlug,
  procedureSlug,
  generateSemanticMOC,
  generateProceduresMOC,
  generateBrainCanvas,
} from "../extensions/brain/vault.ts";
import type { BrainMemory, Procedure, BrainConfig } from "../extensions/brain/types.ts";
import type { RenderContext } from "../extensions/brain/vault.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MEMORY: BrainMemory = {
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

const BASE_PROCEDURE: Procedure = {
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

const EMPTY_CTX: RenderContext = { evidenceIds: [], relatedProcedureKeys: [], relatedMemoryIds: [] };

function ctx(overrides: Partial<RenderContext>): RenderContext {
  return { ...EMPTY_CTX, ...overrides };
}

describe("Obsidian E2E", () => {
  // -------------------------------------------------------------------
  // Tier 1: Wikilinks
  // -------------------------------------------------------------------
  describe("Tier 1: wikilinks", () => {
    it("renders wikilinks to related procedures in memory output", () => {
      const md = renderMemoryMarkdown(BASE_MEMORY, ctx({ relatedProcedureKeys: ["large-file-read"] }));
      assert.ok(md.includes("Related:"));
      assert.ok(md.includes("[[large-file-read]]"));
    });

    it("renders wikilinks to related memories in memory output", () => {
      const md = renderMemoryMarkdown(BASE_MEMORY, ctx({ relatedMemoryIds: [7] }));
      assert.ok(md.includes("[[memory-7]]"));
    });

    it("omits the Related line when no relations are given", () => {
      const md = renderMemoryMarkdown(BASE_MEMORY, EMPTY_CTX);
      assert.ok(!md.includes("Related:"));
    });

    it("renders wikilinks to related memories in procedure output", () => {
      const md = renderProcedureMarkdown(BASE_PROCEDURE, ctx({ relatedMemoryIds: [3, 5] }));
      assert.ok(md.includes("See also: [[memory-3]] | [[memory-5]]"));
    });

    it("omits the See also line when no related memories are given", () => {
      const md = renderProcedureMarkdown(BASE_PROCEDURE, EMPTY_CTX);
      assert.ok(!md.includes("See also:"));
    });
  });

  // -------------------------------------------------------------------
  // Tier 1: Obsidian Properties (frontmatter)
  // -------------------------------------------------------------------
  describe("Tier 1: Obsidian Properties frontmatter", () => {
    it("renders memory tags as a YAML array with brain/ hierarchy plus user tags", () => {
      const md = renderMemoryMarkdown(BASE_MEMORY, EMPTY_CTX);
      assert.ok(
        md.includes(
          "tags:\n  - brain/memory/decision\n  - brain/scope/project\n  - brain/source/user\n  - database\n  - architecture",
        ),
      );
      assert.ok(!md.includes("tags: database,architecture"), "must not fall back to the legacy flat tags line");
    });

    it("adds brain/status/frozen tag for frozen memories", () => {
      const md = renderMemoryMarkdown({ ...BASE_MEMORY, status: "frozen" }, EMPTY_CTX);
      assert.ok(md.includes("brain/status/frozen"));
    });

    it("reflects scope=global and scope=session directly (no project segment)", () => {
      const globalMd = renderMemoryMarkdown({ ...BASE_MEMORY, scope: "global", projectKey: null }, EMPTY_CTX);
      assert.ok(globalMd.includes("brain/scope/global"));
      assert.ok(!globalMd.includes("project:"));

      const sessionMd = renderMemoryMarkdown({ ...BASE_MEMORY, scope: "session", projectKey: null }, EMPTY_CTX);
      assert.ok(sessionMd.includes("brain/scope/session"));
    });

    it("renders scope and project as separate typed fields, not colon-joined", () => {
      const md = renderMemoryMarkdown(BASE_MEMORY, EMPTY_CTX);
      assert.ok(md.includes("scope: project"));
      assert.ok(md.includes("project: waywiser"));
      assert.ok(!md.includes("scope: project:waywiser"));
    });

    it("includes cssclasses reflecting the memory status", () => {
      const md = renderMemoryMarkdown(BASE_MEMORY, EMPTY_CTX);
      assert.ok(md.includes("cssclasses:\n  - brain-memory\n  - brain-active"));
    });

    it("includes aliases with the memory slug", () => {
      const md = renderMemoryMarkdown(BASE_MEMORY, EMPTY_CTX);
      assert.ok(md.includes(`aliases:\n  - ${memorySlug(BASE_MEMORY)}`));
    });

    it("renders procedure tag hierarchy and cssclasses", () => {
      const md = renderProcedureMarkdown(BASE_PROCEDURE, EMPTY_CTX);
      assert.ok(md.includes("tags:\n  - brain/procedure/mature\n  - brain/scope/global"));
      assert.ok(md.includes("cssclasses:\n  - brain-procedure\n  - brain-mature"));
    });

    it("renders procedure project field only for project-scoped procedures", () => {
      const md = renderProcedureMarkdown({ ...BASE_PROCEDURE, scope: "project", projectKey: "waywiser" }, EMPTY_CTX);
      assert.ok(md.includes("project: waywiser"));
    });
  });

  // -------------------------------------------------------------------
  // Tier 1: Callout blocks
  // -------------------------------------------------------------------
  describe("Tier 1: callout blocks", () => {
    it("renders a success callout for active memories", () => {
      const md = renderMemoryMarkdown({ ...BASE_MEMORY, status: "active" }, EMPTY_CTX);
      assert.ok(md.includes("> [!success]"));
      assert.ok(md.includes("Active"));
    });

    it("renders a warning callout for superseded memories", () => {
      const md = renderMemoryMarkdown({ ...BASE_MEMORY, status: "superseded" }, EMPTY_CTX);
      assert.ok(md.includes("> [!warning] Superseded"));
    });

    it("renders a caution callout for frozen external memories", () => {
      const md = renderMemoryMarkdown({ ...BASE_MEMORY, status: "frozen", source: "external", confidence: 0.3 }, EMPTY_CTX);
      assert.ok(md.includes("> [!caution] External (Frozen)"));
    });

    it("renders a caution callout for frozen non-external memories", () => {
      const md = renderMemoryMarkdown({ ...BASE_MEMORY, status: "frozen", source: "agent" }, EMPTY_CTX);
      assert.ok(md.includes("> [!caution] Frozen"));
    });

    it("renders a note callout for archived memories", () => {
      const md = renderMemoryMarkdown({ ...BASE_MEMORY, status: "archived" }, EMPTY_CTX);
      assert.ok(md.includes("> [!note] Archived"));
    });

    it("renders a success callout for mature procedures", () => {
      const md = renderProcedureMarkdown({ ...BASE_PROCEDURE, status: "mature" }, EMPTY_CTX);
      assert.ok(md.includes("> [!success] Mature"));
    });

    it("renders an info callout for reinforced procedures", () => {
      const md = renderProcedureMarkdown({ ...BASE_PROCEDURE, status: "reinforced" }, EMPTY_CTX);
      assert.ok(md.includes("> [!info] Reinforced"));
    });

    it("renders a warning callout for tentative procedures", () => {
      const md = renderProcedureMarkdown({ ...BASE_PROCEDURE, status: "tentative" }, EMPTY_CTX);
      assert.ok(md.includes("> [!warning] Tentative"));
    });

    it("renders a danger callout for contradicted procedures", () => {
      const md = renderProcedureMarkdown({ ...BASE_PROCEDURE, status: "contradicted" }, EMPTY_CTX);
      assert.ok(md.includes("> [!danger] Contradicted"));
    });
  });

  // -------------------------------------------------------------------
  // Tier 1: Mermaid diagrams
  // -------------------------------------------------------------------
  describe("Tier 1: mermaid diagrams", () => {
    it("renders a mermaid evidence chain for memories with 2+ evidence", () => {
      const md = renderMemoryMarkdown(
        BASE_MEMORY,
        ctx({ evidenceIds: ["exp_1 (created_from)", "exp_2 (reinforced_by)"] }),
      );
      assert.ok(md.includes("```mermaid"));
      assert.ok(md.includes("graph LR"));
      assert.ok(md.includes('exp_1["exp_1"]'));
      assert.ok(md.includes('exp_2["exp_2"]'));
      assert.ok(md.includes("-->|created_from|"));
      assert.ok(md.includes("-->|reinforced_by|"));
      assert.ok(md.includes(`mem_${BASE_MEMORY.id}((`));
    });

    it("omits the mermaid evidence chain for a single evidence item", () => {
      const md = renderMemoryMarkdown(BASE_MEMORY, ctx({ evidenceIds: ["exp_1 (created_from)"] }));
      assert.ok(md.includes("## Evidence"));
      assert.ok(!md.includes("```mermaid"));
    });

    it("omits the Evidence section entirely with no evidence", () => {
      const md = renderMemoryMarkdown(BASE_MEMORY, EMPTY_CTX);
      assert.ok(!md.includes("## Evidence"));
    });

    it("renders a mermaid trigger/avoid/prefer flow for procedures with both set", () => {
      const md = renderProcedureMarkdown(BASE_PROCEDURE, EMPTY_CTX);
      assert.ok(md.includes("```mermaid"));
      assert.ok(md.includes("graph TD"));
      assert.ok(md.includes("trigger["));
      assert.ok(md.includes("avoid["));
      assert.ok(md.includes("prefer["));
      assert.ok(md.includes("style avoid fill:#ff6b6b"));
      assert.ok(md.includes("style prefer fill:#51cf66"));
    });

    it("renders only the avoid node when prefer is not set", () => {
      const md = renderProcedureMarkdown({ ...BASE_PROCEDURE, preferText: null }, EMPTY_CTX);
      assert.ok(md.includes("avoid["));
      assert.ok(!md.includes("prefer["));
    });

    it("omits the Flow section entirely when neither avoid nor prefer is set", () => {
      const md = renderProcedureMarkdown({ ...BASE_PROCEDURE, avoidText: null, preferText: null }, EMPTY_CTX);
      assert.ok(!md.includes("## Flow"));
      assert.ok(!md.includes("```mermaid"));
    });
  });

  // -------------------------------------------------------------------
  // Tier 1: MOC generation
  // -------------------------------------------------------------------
  describe("Tier 1: MOC generation", () => {
    const now = "2026-08-21T12:00:00Z";

    const memFact: BrainMemory = { ...BASE_MEMORY, id: 1, type: "fact", status: "active", confidence: 0.95, content: "Fact one" };
    const memPref: BrainMemory = { ...BASE_MEMORY, id: 2, type: "preference", status: "active", confidence: 0.6, content: "Prefer two" };
    const memDecision: BrainMemory = { ...BASE_MEMORY, id: 3, type: "decision", status: "active", confidence: 0.4, content: "Decision three" };
    const memLesson: BrainMemory = { ...BASE_MEMORY, id: 4, type: "lesson", status: "active", confidence: 0.85, content: "Lesson four" };
    const memArchived: BrainMemory = { ...BASE_MEMORY, id: 5, type: "fact", status: "archived", confidence: 0.99, content: "Archived five" };

    it("groups active memories by type with wikilinks", () => {
      const moc = generateSemanticMOC([memFact, memPref, memDecision, memLesson, memArchived], now);
      assert.ok(moc.includes("# Semantic Memories"));
      assert.ok(moc.includes("### Facts"));
      assert.ok(moc.includes(`[[${memorySlug(memFact)}]]`));
      assert.ok(moc.includes("### Preferences"));
      assert.ok(moc.includes(`[[${memorySlug(memPref)}]]`));
      assert.ok(moc.includes("### Decisions"));
      assert.ok(moc.includes(`[[${memorySlug(memDecision)}]]`));
      assert.ok(moc.includes("### Lessons"));
      assert.ok(moc.includes(`[[${memorySlug(memLesson)}]]`));
    });

    it("excludes non-active memories from the MOC", () => {
      const moc = generateSemanticMOC([memFact, memArchived], now);
      assert.ok(!moc.includes(memorySlug(memArchived)));
    });

    it("groups memories by confidence tier", () => {
      const moc = generateSemanticMOC([memFact, memPref, memDecision, memLesson], now);
      assert.ok(moc.includes("### High (>=0.8)"));
      assert.ok(moc.includes(`[[${memorySlug(memFact)}]]`));
      assert.ok(moc.includes("### Medium (0.5-0.8)"));
      assert.ok(moc.includes(`[[${memorySlug(memPref)}]]`));
      assert.ok(moc.includes("### Low (<0.5)"));
      assert.ok(moc.includes(`[[${memorySlug(memDecision)}]]`));
    });

    it("has MOC frontmatter with tags and cssclasses", () => {
      const moc = generateSemanticMOC([memFact], now);
      assert.ok(moc.includes("tags:\n  - brain/moc"));
      assert.ok(moc.includes("cssclasses:\n  - brain-moc"));
    });

    const procMature: Procedure = { ...BASE_PROCEDURE, id: "p1", key: "mature-proc", status: "mature" };
    const procReinforced: Procedure = { ...BASE_PROCEDURE, id: "p2", key: "reinforced-proc", status: "reinforced" };
    const procTentative: Procedure = { ...BASE_PROCEDURE, id: "p3", key: "tentative-proc", status: "tentative" };
    const procContradicted: Procedure = { ...BASE_PROCEDURE, id: "p4", key: "contradicted-proc", status: "contradicted" };
    const procRetired: Procedure = { ...BASE_PROCEDURE, id: "p5", key: "retired-proc", status: "retired" };

    it("groups procedures by status with wikilinks", () => {
      const moc = generateProceduresMOC(
        [procMature, procReinforced, procTentative, procContradicted, procRetired],
        now,
      );
      assert.ok(moc.includes("# Procedures"));
      assert.ok(moc.includes("## Mature (ready for evolution)"));
      assert.ok(moc.includes(`[[${procedureSlug(procMature)}]]`));
      assert.ok(moc.includes("## Reinforced"));
      assert.ok(moc.includes(`[[${procedureSlug(procReinforced)}]]`));
      assert.ok(moc.includes("## Tentative"));
      assert.ok(moc.includes(`[[${procedureSlug(procTentative)}]]`));
      assert.ok(moc.includes("## Contradicted"));
      assert.ok(moc.includes(`[[${procedureSlug(procContradicted)}]]`));
      assert.ok(!moc.includes(procedureSlug(procRetired)));
    });
  });

  // -------------------------------------------------------------------
  // Tier 1: Canvas generation
  // -------------------------------------------------------------------
  describe("Tier 1: canvas generation", () => {
    const structure = DEFAULT_BRAIN_CONFIG.vault.structure;
    const mem1: BrainMemory = { ...BASE_MEMORY, id: 10, status: "active", confidence: 0.9, type: "fact", content: "Canvas memory one" };
    const mem2: BrainMemory = { ...BASE_MEMORY, id: 11, status: "archived", confidence: 0.99, type: "fact", content: "Canvas memory two archived" };
    const proc1: Procedure = { ...BASE_PROCEDURE, id: "p10", key: "mature-one", status: "mature" };
    const proc2: Procedure = { ...BASE_PROCEDURE, id: "p11", key: "retired-one", status: "retired" };

    it("produces valid JSON with nodes and edges arrays", () => {
      const canvasStr = generateBrainCanvas([mem1, mem2], [proc1, proc2], structure);
      const canvas = JSON.parse(canvasStr);
      assert.ok(Array.isArray(canvas.nodes));
      assert.ok(Array.isArray(canvas.edges));
    });

    it("includes text summary nodes for memories and procedures", () => {
      const canvas = JSON.parse(generateBrainCanvas([mem1], [proc1], structure));
      const textNodes = canvas.nodes.filter((n: any) => n.type === "text");
      assert.ok(textNodes.length >= 2);
      assert.ok(textNodes.some((n: any) => n.text.includes("Memories")));
      assert.ok(textNodes.some((n: any) => n.text.includes("Procedures")));
    });

    it("includes file nodes for mature procedures and active memories, excluding retired/archived", () => {
      const canvas = JSON.parse(generateBrainCanvas([mem1, mem2], [proc1, proc2], structure));
      const fileNodes = canvas.nodes.filter((n: any) => n.type === "file");

      assert.ok(fileNodes.some((n: any) => n.file === `${structure.procedures}/${procedureSlug(proc1)}.md`));
      assert.ok(!fileNodes.some((n: any) => n.file?.includes(procedureSlug(proc2))));

      assert.ok(fileNodes.some((n: any) => n.file === `${structure.semantic}/${memorySlug(mem1)}.md`));
      assert.ok(!fileNodes.some((n: any) => n.file?.includes(memorySlug(mem2))));
    });
  });

  // -------------------------------------------------------------------
  // Tier 1: Parse round-trip (enhanced Obsidian format)
  // -------------------------------------------------------------------
  describe("Tier 1: parse round-trip (enhanced format)", () => {
    it("parseMemoryMarkdown recovers fields from an Obsidian-native rendering", () => {
      const context: RenderContext = {
        evidenceIds: ["exp_1 (created_from)", "exp_2 (reinforced_by)"],
        relatedProcedureKeys: ["large-file-read"],
        relatedMemoryIds: [9],
      };
      const md = renderMemoryMarkdown(BASE_MEMORY, context);
      const parsed = parseMemoryMarkdown(md);

      assert.ok(parsed);
      assert.equal(parsed!.id, BASE_MEMORY.id);
      assert.equal(parsed!.type, BASE_MEMORY.type);
      assert.equal(parsed!.scope, "project");
      assert.equal(parsed!.projectKey, "waywiser");
      assert.equal(parsed!.confidence, BASE_MEMORY.confidence);
      assert.equal(parsed!.status, BASE_MEMORY.status);
      assert.equal(parsed!.source, BASE_MEMORY.source);
      assert.equal(parsed!.tags, "database,architecture");
      assert.equal(parsed!.content, BASE_MEMORY.content);
      assert.ok(!parsed!.content!.includes("Related:"));
      assert.ok(!parsed!.content!.includes("```mermaid"));
      assert.ok(!parsed!.content!.includes("[!success]"));
    });

    it("parseProcedureMarkdown recovers fields from an Obsidian-native rendering", () => {
      const context: RenderContext = {
        evidenceIds: ["exp_1 (success)"],
        relatedProcedureKeys: [],
        relatedMemoryIds: [4],
      };
      const md = renderProcedureMarkdown(BASE_PROCEDURE, context);
      const parsed = parseProcedureMarkdown(md);

      assert.ok(parsed);
      assert.equal(parsed!.id, BASE_PROCEDURE.id);
      assert.equal(parsed!.key, BASE_PROCEDURE.key);
      assert.equal(parsed!.status, BASE_PROCEDURE.status);
      assert.equal(parsed!.confidence, BASE_PROCEDURE.confidence);
      assert.equal(parsed!.scope, BASE_PROCEDURE.scope);
      assert.equal(parsed!.triggerText, BASE_PROCEDURE.triggerText);
      assert.equal(parsed!.avoidText, BASE_PROCEDURE.avoidText);
      assert.equal(parsed!.preferText, BASE_PROCEDURE.preferText);
    });
  });

  // -------------------------------------------------------------------
  // Tier 1: Full vault sync E2E (Obsidian-native output end to end)
  // -------------------------------------------------------------------
  describe("Tier 1: full vault sync E2E", () => {
    let tmpDir: string;
    let config: BrainConfig;
    let store: BrainStore;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-obsidian-e2e-"));
      config = { ...DEFAULT_BRAIN_CONFIG, markdownRoot: tmpDir };
      store = new BrainStore(":memory:");
    });

    afterEach(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("produces Obsidian-native memory + procedure files with wikilinks, tag arrays, callouts, and mermaid", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'lesson', 'Always read large files natively', 0.92, 'agent', 'global', 'active', 'io', '', datetime('now'), 0, 0, 0)
      `);
      store.upsertProcedure({
        id: "proc_1",
        key: "large-file-read",
        triggerText: "Reading a large file",
        avoidText: "bash cat",
        preferText: "native read tool",
        confidence: 0.88,
        status: "mature",
      });

      // Link memory <-> procedure through a shared experience id so the
      // relationship queries built into vaultSyncOutbound find each other.
      store.recordMemoryEvidence(1, "exp_shared", null, "created_from");
      store.recordMemoryEvidence(1, "exp_second", null, "reinforced_by");
      store.recordProcedureEvidence("proc_1", "exp_shared", null, "success");

      await vaultSyncOutbound(store, config);

      const memFiles = fs.readdirSync(path.join(tmpDir, "semantic"));
      assert.equal(memFiles.length, 1);
      const memContent = fs.readFileSync(path.join(tmpDir, "semantic", memFiles[0]), "utf-8");

      assert.ok(memContent.includes("tags:\n  - brain/memory/lesson"));
      assert.ok(memContent.includes("cssclasses:\n  - brain-memory\n  - brain-active"));
      assert.ok(memContent.includes("aliases:"));
      assert.ok(memContent.includes("> [!success]"));
      assert.ok(memContent.includes("[[large-file-read]]"), "memory should wikilink to its related procedure");
      assert.ok(memContent.includes("```mermaid"));
      assert.ok(memContent.includes("graph LR"));

      const procFiles = fs.readdirSync(path.join(tmpDir, "procedures"));
      assert.equal(procFiles.length, 1);
      const procContent = fs.readFileSync(path.join(tmpDir, "procedures", procFiles[0]), "utf-8");

      assert.ok(procContent.includes("tags:\n  - brain/procedure/mature"));
      assert.ok(procContent.includes("> [!success]"));
      assert.ok(procContent.includes("See also: [[memory-1]]"), "procedure should wikilink to its related memory");
      assert.ok(procContent.includes("```mermaid"));
      assert.ok(procContent.includes("graph TD"));
    });

    it("generates MOC index files with wikilinks", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Fact content', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      store.upsertProcedure({ id: "proc_1", key: "some-proc", triggerText: "Trigger", confidence: 0.8, status: "mature" });

      await vaultSyncOutbound(store, config);

      const semanticMocPath = path.join(tmpDir, "_MOC-semantic.md");
      const proceduresMocPath = path.join(tmpDir, "_MOC-procedures.md");
      assert.ok(fs.existsSync(semanticMocPath));
      assert.ok(fs.existsSync(proceduresMocPath));

      const semanticMoc = fs.readFileSync(semanticMocPath, "utf-8");
      assert.ok(semanticMoc.includes("# Semantic Memories"));
      assert.ok(semanticMoc.includes("[["));

      const proceduresMoc = fs.readFileSync(proceduresMocPath, "utf-8");
      assert.ok(proceduresMoc.includes("# Procedures"));
      assert.ok(proceduresMoc.includes("[[some-proc]]"));
    });

    it("generates a valid brain overview canvas file", async () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Fact content', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      store.upsertProcedure({ id: "proc_1", key: "some-proc", triggerText: "Trigger", confidence: 0.8, status: "mature" });

      await vaultSyncOutbound(store, config);

      const canvasPath = path.join(tmpDir, "_brain-overview.canvas");
      assert.ok(fs.existsSync(canvasPath));
      const canvas = JSON.parse(fs.readFileSync(canvasPath, "utf-8"));
      assert.ok(Array.isArray(canvas.nodes));
      assert.ok(Array.isArray(canvas.edges));
      assert.ok(canvas.nodes.length > 0);
    });
  });

  // -------------------------------------------------------------------
  // Tier 2: Obsidian plugin build artifacts
  // -------------------------------------------------------------------
  describe("Tier 2: Obsidian plugin build artifacts", () => {
    const pluginRoot = path.resolve(import.meta.dirname, "../../obsidian-plugin");

    it("has a built main.js bundle", () => {
      const mainJs = path.join(pluginRoot, "main.js");
      assert.ok(fs.existsSync(mainJs), "obsidian-plugin/main.js should exist after build");
      const stat = fs.statSync(mainJs);
      assert.ok(stat.size > 1000, "main.js should be a non-trivial bundled artifact");
      const content = fs.readFileSync(mainJs, "utf-8");
      assert.ok(content.includes("class"), "bundled output should define plugin classes");
    });

    it("has a valid plugin manifest", () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "manifest.json"), "utf-8"));
      assert.equal(manifest.id, "waywiser-brain");
      assert.ok(manifest.version);
      assert.ok(manifest.minAppVersion);
    });

    it("has all expected plugin source files", () => {
      const srcDir = path.join(pluginRoot, "src");
      for (const file of [
        "main.ts",
        "db-reader.ts",
        "settings.ts",
        "watcher.ts",
        "types.ts",
        "dashboard-view.ts",
        "commands.ts",
        "graph-integration.ts",
      ]) {
        assert.ok(fs.existsSync(path.join(srcDir, file)), `${file} should exist`);
      }
    });
  });

  // -------------------------------------------------------------------
  // Tier 2: Brain DB matches the plugin's expected schema
  // -------------------------------------------------------------------
  describe("Tier 2: brain DB matches the plugin's expected schema", () => {
    let tmpDbDir: string;
    let dbPath: string;

    beforeEach(() => {
      tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-e2e-plugindb-"));
      dbPath = path.join(tmpDbDir, "brain.db");
    });

    afterEach(() => {
      fs.rmSync(tmpDbDir, { recursive: true, force: true });
    });

    it("writes a real sqlite file to disk with known data", () => {
      const store = new BrainStore(dbPath);
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Plugin visible fact', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      store.upsertProcedure({ id: "proc_1", key: "plugin-proc", triggerText: "Trigger", confidence: 0.8, status: "mature" });
      store.logBrain("test", "hello");
      store.close();

      assert.ok(fs.existsSync(dbPath));
      assert.ok(fs.statSync(dbPath).size > 0);
    });

    it("has all tables the Obsidian plugin's db-reader queries against", () => {
      const store = new BrainStore(dbPath);
      store.db.exec(`
        INSERT INTO memories (id, type, content, confidence, source, scope, status, tags, source_session, last_accessed, access_count, useful_count, not_useful_count)
        VALUES (1, 'fact', 'Plugin visible fact', 0.9, 'user', 'global', 'active', '', '', datetime('now'), 0, 0, 0)
      `);
      store.close();

      // Reopen fresh — simulates the plugin opening the same file (as
      // sql.js would) in a separate process/runtime.
      const reopened = new BrainStore(dbPath);
      const tables = (
        reopened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((r) => r.name);

      for (const table of [
        "memories",
        "procedures",
        "skill_versions",
        "experiences",
        "evolution_runs",
        "brain_log",
        "memory_evidence",
        "vault_sync",
      ]) {
        assert.ok(tables.includes(table), `missing table: ${table}`);
      }

      const mem = reopened.getMemory(1);
      assert.ok(mem);
      assert.equal(mem!.content, "Plugin visible fact");

      reopened.close();
    });
  });
});
