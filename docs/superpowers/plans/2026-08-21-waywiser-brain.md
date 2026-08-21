# Waywiser Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@yoda-digital/waywiser-brain` — a self-learning, auto-evolving brain extension for Pi, living at `waywiser/brain/` inside the waywiser git repo.

**Architecture:** Separate Pi package with 17 composable modules. Brain observes Pi tool events, learns at `agent_settled` boundaries, accumulates procedural knowledge, evolves mature procedures into native Pi skills via competitive evaluation, and projects all state to Obsidian-compatible markdown. Existing Waywiser tools become compatibility facades.

**Tech Stack:** Node.js >=22.5, TypeScript (ESM), SQLite via `node:sqlite` (DatabaseSync), FTS5 with `unicode61`, Pi ExtensionAPI >=0.84.2, `node:test` for testing.

**Spec:** `waywiser/docs/specs/2026-08-21-waywiser-brain-design.md`

## Global Constraints

- Peer dependency floor: `@earendil-works/pi-coding-agent` >= 0.84.2
- Node.js >= 22.5 (required for `node:sqlite` DatabaseSync)
- ESM only (`"type": "module"` in package.json)
- No external dependencies (use `node:` built-ins only)
- All SQL schema changes are idempotent (`CREATE TABLE IF NOT EXISTS`, try/catch `ALTER TABLE`)
- FTS5 tokenizer: `unicode61` (never ASCII-only `[a-z0-9_]`)
- All file paths: absolute, normalized via `path.resolve`
- Test runner: `node --test` (built-in)
- Import Pi types as `import type { ... } from "@earendil-works/pi-coding-agent"`
- Follow Waywiser's existing patterns: stderr for diagnostics, per-module failure containment

---

### Task 1: Package Scaffold + Types

**Files:**
- Create: `waywiser/brain/package.json`
- Create: `waywiser/brain/extensions/brain/types.ts`

**Interfaces:**
- Consumes: nothing (foundation task)
- Produces: All shared types used by every subsequent task — `ProvenanceSource`, `ProvenanceRecord`, `Observation`, `Experience`, `ExperienceOutcome`, `BrainMemory`, `MemoryType`, `MemoryScope`, `MemoryStatus`, `Procedure`, `ProcedureStatus`, `SkillVersion`, `SkillStatus`, `EvolutionRun`, `EvolutionStatus`, `RecallResult`, `RecallItem`, `BrainConfig`, `LearningResult`, `DeterministicPass1Result`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@yoda-digital/waywiser-brain",
  "version": "1.0.0",
  "description": "Waywiser Brain — self-learning, auto-evolving brain extension for Pi",
  "keywords": ["pi-package", "pi-extension", "brain", "self-learning", "evolution"],
  "type": "module",
  "license": "MIT",
  "pi": {
    "extensions": ["extensions"],
    "skills": ["skills"]
  },
  "engines": { "node": ">=22.5" },
  "files": ["extensions", "skills", "README.md"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.84.2"
  },
  "scripts": {
    "test": "node --test test/*.test.ts"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.84.2"
  }
}
```

- [ ] **Step 2: Create types.ts with all shared types**

Write `waywiser/brain/extensions/brain/types.ts` with every type from spec §4.1. All types are exported. Use string literal unions (not enums). Every interface has JSDoc on non-obvious fields.

Key types (all from spec, copied verbatim):

```typescript
// Provenance
export type ProvenanceSource = "user" | "agent" | "external" | "environment" | "existing-memory";
export interface ProvenanceRecord { ... }  // spec §4.1

// Observations
export interface Observation { ... }  // spec §4.1

// Experience
export interface Experience { ... }  // spec §4.1
export interface ExperienceOutcome { ... }

// Memory
export type MemoryType = "fact" | "preference" | "decision" | "lesson";
export type MemoryScope = "global" | "project" | "session";
export type MemoryStatus = "active" | "frozen" | "archived" | "superseded";
export interface BrainMemory { ... }  // spec §4.1

// Procedure
export type ProcedureStatus = "tentative" | "reinforced" | "mature" | "contradicted" | "retired";
export interface Procedure { ... }

// Skill Versions
export type SkillStatus = "candidate" | "evaluating" | "active" | "retired" | "rejected";
export interface SkillVersion { ... }

// Evolution
export type EvolutionStatus = "pending" | "running" | "passed" | "failed" | "cancelled";
export interface EvolutionRun { ... }

// Recall
export interface RecallResult { ... }
export interface RecallItem { ... }

// Learning pipeline types
export interface DeterministicPass1Result {
  hasDurableSignals: boolean;
  userCorrections: Array<{ content: string; verbatim: string }>;
  userStatements: Array<{ content: string; verbatim: string }>;
  toolFailures: Observation[];
  recoveries: Array<{ failed: Observation; succeeded: Observation }>;
  skillsUsed: Array<{ name: string; versionHash: string }>;
  externalObservations: Observation[];
}

export interface LearningResult {
  memories: Array<{
    type: MemoryType;
    content: string;
    source: ProvenanceSource;
    confidence: number;
    scope: MemoryScope;
    projectKey: string | null;
    verbatim: string | null;
    supersedesId: number | null;
  }>;
  procedureUpdates: Array<{
    key: string;
    triggerText: string;
    avoidText: string | null;
    preferText: string | null;
    outcome: "success" | "failure";
    experienceId: string;
    observationId: string | null;
  }>;
  usageRecords: Array<{
    memoryId: number;
    useful: boolean | null;
    contradicted: boolean;
  }>;
}
```

- [ ] **Step 3: Create directory structure**

```bash
mkdir -p waywiser/brain/extensions/brain
mkdir -p waywiser/brain/skills/brain
mkdir -p waywiser/brain/test
```

- [ ] **Step 4: Verify types compile**

Run: `cd waywiser/brain && npx tsc --noEmit extensions/brain/types.ts` (or use `node --check` via jiti)

- [ ] **Step 5: Commit**

```bash
cd waywiser && git add brain/
git commit -m "feat(brain): package scaffold and shared types"
```

---

### Task 2: Configuration

**Files:**
- Create: `waywiser/brain/extensions/brain/config.ts`
- Test: `waywiser/brain/test/config.test.ts`

**Interfaces:**
- Consumes: `BrainConfig` from `types.ts`
- Produces: `loadBrainConfig(): BrainConfig`, `reloadBrainConfig(): void`, `brainHome(): string`, `brainDbPath(): string`, `brainSkillsRoot(): string`, `DEFAULT_BRAIN_CONFIG: BrainConfig`

- [ ] **Step 1: Write config test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadBrainConfig, DEFAULT_BRAIN_CONFIG } from "../extensions/brain/config.js";

describe("config", () => {
  it("returns defaults when no config file exists", () => {
    const cfg = loadBrainConfig("/nonexistent/brain.json");
    assert.equal(cfg.learning.boundary, "agent_settled");
    assert.equal(cfg.recall.mode, "selective");
    assert.equal(cfg.modules.trace, true);
    assert.equal(cfg.modules.evolve, true);
    assert.equal(cfg.provenance.userConfidence, 0.9);
    assert.equal(cfg.provenance.externalConfidence, 0.3);
  });

  it("deep-merges partial config over defaults", () => {
    // Write a temp config with partial override
    const cfg = loadBrainConfig("/nonexistent", {
      learning: { maxReflectionsPerSession: 5 },
      modules: { vault: false },
    });
    assert.equal(cfg.learning.maxReflectionsPerSession, 5);
    assert.equal(cfg.learning.boundary, "agent_settled"); // default preserved
    assert.equal(cfg.modules.vault, false);
    assert.equal(cfg.modules.trace, true); // default preserved
  });

  it("clamps confidence values to 0-1", () => {
    const cfg = loadBrainConfig("/nonexistent", {
      provenance: { userConfidence: 1.5, externalConfidence: -0.3 },
    });
    assert.equal(cfg.provenance.userConfidence, 1.0);
    assert.equal(cfg.provenance.externalConfidence, 0.0);
  });

  it("disables evolve when eval is disabled", () => {
    const cfg = loadBrainConfig("/nonexistent", {
      modules: { eval: false, evolve: true },
    });
    assert.equal(cfg.modules.evolve, false);
  });

  it("applies env var overrides", () => {
    process.env.BRAIN_MARKDOWN_ROOT = "/tmp/test-brain";
    const cfg = loadBrainConfig("/nonexistent");
    assert.equal(cfg.markdownRoot, "/tmp/test-brain");
    delete process.env.BRAIN_MARKDOWN_ROOT;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd waywiser/brain && node --test test/config.test.ts`
Expected: FAIL (config.js not found)

- [ ] **Step 3: Implement config.ts**

Key implementation details:
- `DEFAULT_BRAIN_CONFIG` is a frozen object with every default from spec §3.2
- `loadBrainConfig(configPath?, overrides?)` reads JSON, deep-merges with defaults
- Deep merge: recursive for plain objects, overwrite for arrays/primitives
- Validation: clamp confidence 0-1, clamp timeouts, enforce module dependencies (evolve needs eval+skills)
- Env var overrides: `BRAIN_MARKDOWN_ROOT`, `BRAIN_DB_PATH`, `BRAIN_SKILLS_ROOT`, `BRAIN_CONFIG`
- `reloadBrainConfig()` re-reads the file and replaces the cached config
- `brainHome()` returns `config.markdownRoot` (creates dir if needed)
- Version read from package.json (fixes WAYWISER_VERSION mismatch bug)

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import type { BrainConfig } from "./types.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const PKG = JSON.parse(fs.readFileSync(path.join(here, "../../package.json"), "utf-8"));
export const BRAIN_VERSION: string = PKG.version;

export const DEFAULT_BRAIN_CONFIG: BrainConfig = Object.freeze({
  markdownRoot: path.join(process.env.HOME || ".", ".waywiser", "brain"),
  dbPath: path.join(process.env.HOME || ".", ".waywiser", "waywiser.db"),
  skillsRoot: path.join(process.env.HOME || ".", ".waywiser", "skills"),
  experienceRoot: null,
  modules: { trace: true, learner: true, procedures: true, recovery: true,
    consolidate: true, skills: true, evolve: true, eval: true, vault: true, cognition: true },
  learning: { boundary: "agent_settled", maxReflectionsPerSession: 10,
    maxMemoriesPerRun: 3, gateTimeoutMs: 12000, minObservationsForReflection: 1 },
  recall: { mode: "selective", maxItems: 8, maxChars: 2000,
    fusionWeights: { lexical: 1.0, scope: 0.8, usage: 0.5, confidence: 0.3, recency: 0.2 },
    useCustomMessage: true },
  provenance: { externalConfidence: 0.3, userConfidence: 0.9, agentConfidence: 0.7, environmentConfidence: 0.6 },
  scoping: { defaultScope: "infer", projectDetection: "git-root", scopeBoost: 2.0 },
  evolution: { maturity: { minPositiveObservations: 3, minIndependentExperiences: 2,
      minSuccessRatio: 0.75, requireNoContradictions: true },
    evalCasesPerCandidate: 5, promotionPolicy: "auto", promotionBoundary: "next-session" },
  vault: { syncOnStart: true, syncOnShutdown: true, conflictResolution: "human-wins",
    structure: { semantic: "semantic", procedures: "procedures", projects: "projects",
      entities: "entities", hypotheses: "hypotheses", archive: "archive", skills: "skills" } },
  cognition: { poolSize: 2, model: null, thinkingLevel: null, idleTtlMs: 600_000 },
  soul: { narrowMode: true, snapshotAtStart: true },
  consolidation: { batchSize: 50, runOnShutdown: true, dryRunByDefault: false },
});

function deepMerge(base: any, patch: any): any { /* recursive plain-object merge */ }
function clamp(v: number, min: number, max: number): number { return Math.min(Math.max(v, min), max); }

let cached: BrainConfig | null = null;

export function loadBrainConfig(configPath?: string, overrides?: Partial<BrainConfig>): BrainConfig {
  const file = configPath ?? process.env.BRAIN_CONFIG
    ?? path.join(process.env.HOME || ".", ".waywiser", "brain.json");
  let fileData = {};
  try { fileData = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* no file = defaults */ }

  const merged = deepMerge(DEFAULT_BRAIN_CONFIG, fileData);
  if (overrides) deepMerge(merged, overrides);

  // Env var overrides (highest priority)
  if (process.env.BRAIN_MARKDOWN_ROOT) merged.markdownRoot = process.env.BRAIN_MARKDOWN_ROOT;
  if (process.env.BRAIN_DB_PATH) merged.dbPath = process.env.BRAIN_DB_PATH;
  if (process.env.BRAIN_SKILLS_ROOT) merged.skillsRoot = process.env.BRAIN_SKILLS_ROOT;

  // Validate
  for (const k of ["userConfidence","agentConfidence","externalConfidence","environmentConfidence"] as const)
    merged.provenance[k] = clamp(merged.provenance[k], 0, 1);
  merged.learning.gateTimeoutMs = clamp(merged.learning.gateTimeoutMs, 1000, 30000);

  // Module dependency enforcement
  if (merged.modules.evolve && !merged.modules.eval) merged.modules.evolve = false;
  if (merged.modules.evolve && !merged.modules.skills) merged.modules.evolve = false;

  cached = merged;
  return merged;
}

export function reloadBrainConfig(): BrainConfig { cached = null; return loadBrainConfig(); }
export function brainConfig(): BrainConfig { return cached ?? loadBrainConfig(); }
export function brainHome(): string {
  const dir = brainConfig().markdownRoot;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function brainDbPath(): string { return brainConfig().dbPath; }
export function brainSkillsRoot(): string { return brainConfig().skillsRoot; }
```

- [ ] **Step 4: Run tests**

Run: `cd waywiser/brain && node --test test/config.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add brain/extensions/brain/config.ts brain/test/config.test.ts
git commit -m "feat(brain): configuration with defaults, deep-merge, env overrides"
```

---

### Task 3: Store (Database)

**Files:**
- Create: `waywiser/brain/extensions/brain/store.ts`
- Test: `waywiser/brain/test/store.test.ts`

**Interfaces:**
- Consumes: `BrainConfig` from `config.ts`, all types from `types.ts`
- Produces: `BrainStore` class with methods:
  - `constructor(dbPath: string)` — opens DB, runs migrations
  - `beginSession(sessionId: string): void`
  - `recordExperience(exp: Experience): void`
  - `recordObservations(expId: string, obs: Observation[]): void`
  - `storeLearningResults(results: LearningResult): void`
  - `appendEpisode(sessionId: string, summary: string): void`
  - `getMemory(id: number): BrainMemory | null`
  - `searchMemories(query: string, limit: number): BrainMemory[]`
  - `searchProcedures(query: string, limit: number): Procedure[]`
  - `bumpAccessCount(memoryIds: number[]): void`
  - `recordMemoryUsage(memId: number, expId: string, useful: boolean | null, contradicted: boolean): void`
  - `getProcedure(key: string): Procedure | null`
  - `upsertProcedure(p: Partial<Procedure>): void`
  - `recordProcedureEvidence(procId: string, expId: string, obsId: string | null, outcome: string): void`
  - `getMatureProcedures(config: BrainConfig): Procedure[]`
  - `getSkillVersion(id: string): SkillVersion | null`
  - `insertSkillVersion(sv: SkillVersion): void`
  - `updateSkillStatus(id: string, status: SkillStatus): void`
  - `insertEvolutionRun(run: EvolutionRun): void`
  - `insertEvalCase(c: EvalCase): void`
  - `getEvalCases(skillName: string): EvalCase[]`
  - `getVaultSyncState(filePath: string): VaultSyncRow | null`
  - `upsertVaultSync(filePath: string, contentHash: string, memId?: number, procId?: string): void`
  - `logBrain(kind: string, details: string, expId?: string): void`
  - `getMemoryStats(): { active: number; frozen: number; archived: number }`
  - `getProcedureStats(): { tentative: number; reinforced: number; mature: number }`
  - `close(): void`
  - `db: DatabaseSync` (exposed for advanced queries)

Key implementation details:
- All schema from spec §4.3 — 12 new tables + existing table modifications
- FTS5 unicode migration: detect `memories_fts` tokenizer, rebuild if ASCII
- Idempotent `ALTER TABLE` via try/catch (SQLite has no `IF NOT EXISTS` for ALTER)
- `procedures_fts` with `unicode61` tokenizer
- `memories_fts` rebuild with `unicode61` tokenizer

- [ ] **Step 1: Write store tests**

Tests cover: schema creation idempotency, CRUD for experiences/observations/memories/procedures, FTS unicode search, memory usage tracking, procedure maturity query, brain log.

- [ ] **Step 2: Implement store.ts**

Full schema creation + CRUD methods. Use `DatabaseSync` from `node:sqlite`.

- [ ] **Step 3: Run tests, verify, commit**

---

### Task 4: Provenance

**Files:**
- Create: `waywiser/brain/extensions/brain/provenance.ts`
- Test: `waywiser/brain/test/provenance.test.ts`

**Interfaces:**
- Consumes: `ProvenanceSource`, `BrainConfig` from types/config
- Produces:
  - `classifyToolProvenance(toolName: string): ProvenanceSource` — deterministic
  - `classifyEventProvenance(eventType: string, role?: string): ProvenanceSource`
  - `confidenceForSource(source: ProvenanceSource, config: BrainConfig): number`
  - `isCallFromUser(ctx: ExtensionContext): boolean` — determines if a tool call originated from a user command vs model

Pure functions, no I/O. Every classification rule from spec §4.5.

- [ ] **Step 1: Write provenance tests**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyToolProvenance, classifyEventProvenance, confidenceForSource } from "../extensions/brain/provenance.js";
import { DEFAULT_BRAIN_CONFIG } from "../extensions/brain/config.js";

describe("provenance", () => {
  it("classifies native file tools as environment", () => {
    assert.equal(classifyToolProvenance("read"), "environment");
    assert.equal(classifyToolProvenance("edit"), "environment");
    assert.equal(classifyToolProvenance("write"), "environment");
    assert.equal(classifyToolProvenance("grep"), "environment");
    assert.equal(classifyToolProvenance("find"), "environment");
    assert.equal(classifyToolProvenance("ls"), "environment");
    assert.equal(classifyToolProvenance("bash"), "environment");
  });

  it("classifies web tools as external", () => {
    assert.equal(classifyToolProvenance("web_search"), "external");
    assert.equal(classifyToolProvenance("web_fetch"), "external");
  });

  it("classifies MCP tools as external", () => {
    assert.equal(classifyToolProvenance("mcp__some_server__tool"), "external");
  });

  it("classifies unknown tools as agent", () => {
    assert.equal(classifyToolProvenance("custom_tool"), "agent");
  });

  it("classifies user messages as user provenance", () => {
    assert.equal(classifyEventProvenance("turn_end", "user"), "user");
  });

  it("classifies assistant messages as agent provenance", () => {
    assert.equal(classifyEventProvenance("turn_end", "assistant"), "agent");
  });

  it("returns correct confidence for each source", () => {
    const cfg = DEFAULT_BRAIN_CONFIG;
    assert.equal(confidenceForSource("user", cfg), 0.9);
    assert.equal(confidenceForSource("external", cfg), 0.3);
    assert.equal(confidenceForSource("agent", cfg), 0.7);
    assert.equal(confidenceForSource("environment", cfg), 0.6);
  });
});
```

- [ ] **Step 2: Implement provenance.ts**

```typescript
import type { ProvenanceSource, BrainConfig } from "./types.js";

const ENVIRONMENT_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls", "bash"]);
const EXTERNAL_TOOLS = new Set(["web_search", "web_fetch"]);

export function classifyToolProvenance(toolName: string): ProvenanceSource {
  if (ENVIRONMENT_TOOLS.has(toolName)) return "environment";
  if (EXTERNAL_TOOLS.has(toolName)) return "external";
  if (toolName.startsWith("mcp__")) return "external";
  return "agent";
}

export function classifyEventProvenance(eventType: string, role?: string): ProvenanceSource {
  if (eventType === "turn_end" && role === "user") return "user";
  if (eventType === "turn_end" && role === "assistant") return "agent";
  if (eventType === "tool_result") return "environment"; // overridden by classifyToolProvenance
  return "agent";
}

export function confidenceForSource(source: ProvenanceSource, config: BrainConfig): number {
  const map: Record<ProvenanceSource, number> = {
    user: config.provenance.userConfidence,
    agent: config.provenance.agentConfidence,
    external: config.provenance.externalConfidence,
    environment: config.provenance.environmentConfidence,
    "existing-memory": 0.5, // inherited from the original memory
  };
  return map[source] ?? 0.5;
}

export function isCallFromUser(ctx: any): boolean {
  // Check if the tool invocation came from a slash command context
  // Pi sets ctx.inputSource when a command triggered the tool
  return ctx?.inputSource === "command" || ctx?.isCommand === true;
}
```

- [ ] **Step 3: Run tests, verify, commit**

---

### Task 5: Trace + Recovery

**Files:**
- Create: `waywiser/brain/extensions/brain/trace.ts`
- Create: `waywiser/brain/extensions/brain/recovery.ts`
- Test: `waywiser/brain/test/trace.test.ts`
- Test: `waywiser/brain/test/recovery.test.ts`

**Interfaces:**
- Consumes: `Observation`, `Experience`, `BrainConfig`, `RecallResult` from types/config; `classifyToolProvenance` from provenance
- Produces:
  - `ExperienceTrace` class:
    - `resetSession(sessionManager: ReadonlySessionManager): void`
    - `beginRun(): void`
    - `toolCall(event: ToolCallEvent): void`
    - `toolResult(event: ToolResultEvent): void`
    - `turnEnd(event: TurnEndEvent): void`
    - `noteRecall(recalled: RecallResult): void`
    - `finalize(ctx: { sessionManager: ReadonlySessionManager; cwd: string }): Experience`
  - `extractTargetKey(toolName: string, input: Record<string, unknown>, cwd: string): string`
  - `normalizePath(p: string, cwd: string): string`
  - `linkRecoveries(observations: Observation[]): Observation[]`

Key implementation:
- `extractTargetKey`: deterministic per-tool target extraction (spec §4.4 table)
- `normalizePath`: resolves `.`, `..`, `~`, relative paths
- `linkRecoveries`: deterministic recovery linking — success on same target_key as prior error
- `finalize` reads `ctx.sessionManager.getBranch()` (FIX: branch-aware)
- Generates unique IDs: `exp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`

- [ ] **Step 1: Write trace tests**

Tests cover:
- `extractTargetKey("read", { file_path: "/foo/bar.ts" }, "/cwd")` → `"/foo/bar.ts"`
- `extractTargetKey("bash", { command: "cat /foo/bar.ts" }, "/cwd")` → `"/foo/bar.ts"`
- `extractTargetKey("bash", { command: "npm install" }, "/cwd")` → `"npm install"`
- `extractTargetKey("grep", { pattern: "foo", path: "/src" }, "/cwd")` → `"foo@/src"`
- `normalizePath("./foo/../bar.ts", "/project")` → `"/project/bar.ts"`
- `normalizePath("~/foo.ts", "/project")` → `"/home/.../foo.ts"`
- Recovery linking: error on `/foo.ts` then success on `/foo.ts` → `recoveryOf` linked
- Recovery linking: error on `/foo.ts` then success on `/bar.ts` → no link
- `finalize` produces a complete Experience with observations, branch leaf, timestamps

- [ ] **Step 2: Write recovery tests**

Tests for ambiguous bash target extraction, multiple-failure disambiguation.

- [ ] **Step 3: Implement recovery.ts** (pure functions)
- [ ] **Step 4: Implement trace.ts** (ExperienceTrace class)
- [ ] **Step 5: Run all tests, commit**

---

### Task 6: Prompts

**Files:**
- Create: `waywiser/brain/extensions/brain/prompts.ts`

**Interfaces:**
- Consumes: `Experience`, `BrainMemory`, `Procedure`, `Observation`, `RecallResult` from types
- Produces:
  - `gatePrompt(experience: Experience): { system: string; user: string }`
  - `consolidatePrompt(cluster: BrainMemory[]): { system: string; user: string }`
  - `contradictionPrompt(a: BrainMemory, b: BrainMemory): { system: string; user: string }`
  - `compileSkillPrompt(proc: Procedure, evidence: any[]): { system: string; user: string }`
  - `judgePrompt(baseline: any, candidate: any): { system: string; user: string }`
  - `recoverySuggestionPrompt(obs: Observation[]): { system: string; user: string }`
  - `renderBrainContext(recalled: RecallResult): string`

No tests needed for prompts (they're string templates). But `renderBrainContext` gets a unit test since it's used in the recall injection path.

- [ ] **Step 1: Implement prompts.ts**

Key prompts:
- `gatePrompt` receives a structured ExperiencePacket (NOT prose snippets like current Waywiser). Asks: what lasting knowledge? procedural patterns? scope-specific facts? recalled memories wrong/unhelpful?
- `renderBrainContext` formats recalled memories and procedures in a `<waywiser-brain-context>` XML block for injection via custom message

- [ ] **Step 2: Commit**

---

### Task 7: Cognition Pool

**Files:**
- Create: `waywiser/brain/extensions/brain/cognition.ts`

**Interfaces:**
- Consumes: `BrainConfig` from config; `createPiRpcClient`, `createPiRpcPool` patterns from `waywiser/extensions/utils/rpc.ts`
- Produces:
  - `CognitionPool` class:
    - `constructor(config: BrainConfig)`
    - `runLearner(prompt: { system: string; user: string }, timeoutMs?: number): Promise<string>`
    - `runConsolidation(prompt: { system: string; user: string }, timeoutMs?: number): Promise<string>`
    - `runSkillCompiler(prompt: { system: string; user: string }, timeoutMs?: number): Promise<string>`
    - `runJudge(prompt: { system: string; user: string }, timeoutMs?: number): Promise<string>`
    - `shutdown(): void`

Key implementation:
- Wraps the existing `createPiRpcPool` from `waywiser/extensions/utils/rpc.ts`
- 4 lanes: `learn`, `consolidate`, `compile-skill`, `judge`
- All workers spawn with `--no-extensions --no-skills --no-context-files`
- Workers get `freshSession=true` before reuse
- Model and thinking level from `config.cognition`

- [ ] **Step 1: Implement cognition.ts**

```typescript
import { createPiRpcPool, createPiRpcClient, type PiRpcPool } from "../../extensions/utils/rpc.js";
// Note: cognition.ts imports from waywiser's utils/rpc.ts since brain lives in the same repo
```

Wait — brain is a separate package. It can't import waywiser's internal modules directly. Brain needs its own copy of the RPC infrastructure, or it needs to use Pi's public API.

**Resolution:** Brain re-implements a minimal RPC client using Pi's `--mode rpc` protocol. The implementation is simpler than waywiser's full pool — brain only needs prompt→response, not the full agent orchestration. We copy the core JSONL protocol from `utils/rpc.ts` into brain's own `cognition.ts` (it's ~100 lines of protocol code).

Alternatively, brain can use `pi` CLI with `--print` mode (non-interactive, single prompt→response) which is simpler for meta-workers.

**Decision:** Use `pi --print` mode for cognition workers. Spawn `pi --print --no-extensions --no-skills --no-context-files` with the system+user prompt on stdin. Parse the final assistant text from stdout. This avoids maintaining a second RPC implementation.

- [ ] **Step 2: Commit**

---

### Task 8: Recall

**Files:**
- Create: `waywiser/brain/extensions/brain/recall.ts`
- Test: `waywiser/brain/test/recall.test.ts`

**Interfaces:**
- Consumes: `BrainStore` from store, `BrainConfig` from config, `RecallResult`, `RecallItem` from types
- Produces:
  - `recall(opts: RecallOpts): RecallResult`
    - `opts: { prompt: string; cwd: string; branch: SessionEntry[]; activeGoals: any[]; config: BrainConfig["recall"]; store: BrainStore }`
  - `buildRecallQuery(text: string): string[]` — unicode-aware tokenizer (FIX: replaces ASCII-only `[a-z0-9_]`)
  - `reciprocalRankFusion(rankings: Map<number|string, number>[], weights: number[], k?: number): Array<{ id: number|string; score: number }>`

Key implementation:
- Unicode-aware tokenizer using `Intl.Segmenter` or regex `[\p{L}\p{N}_]{2,}` with unicode flag
- Reciprocal rank fusion: `score = Σ (weight_i / (k + rank_i))` where k=60
- Five ranking signals: lexical (FTS5 BM25), scope, usage, confidence, recency
- ALL recall paths bump `access_count` (FIX)
- `recall=off` returns empty immediately (FIX)
- Procedures recalled alongside memories

- [ ] **Step 1: Write recall tests**

```typescript
describe("recall", () => {
  it("tokenizes unicode text correctly", () => {
    const terms = buildRecallQuery("Проект использует PostgreSQL для данных");
    assert.ok(terms.includes("проект"));
    assert.ok(terms.includes("postgresql"));
  });

  it("tokenizes Romanian correctly", () => {
    const terms = buildRecallQuery("decizii importante despre proiect");
    assert.ok(terms.includes("decizii"));
    assert.ok(terms.includes("importante"));
  });

  it("recall=off returns empty immediately", () => {
    const result = recall({ ...opts, config: { ...opts.config, mode: "off" } });
    assert.equal(result.items.length, 0);
  });

  it("reciprocal rank fusion combines rankings correctly", () => {
    const rankings = [
      new Map([["a", 1], ["b", 2]]),  // lexical: a=rank1, b=rank2
      new Map([["b", 1], ["a", 3]]),  // scope: b=rank1, a=rank3
    ];
    const fused = reciprocalRankFusion(rankings, [1.0, 0.8], 60);
    // b should rank higher: 1.0/(60+2) + 0.8/(60+1) > 1.0/(60+1) + 0.8/(60+3)
    assert.equal(fused[0].id, "b");
  });
});
```

- [ ] **Step 2: Implement recall.ts**
- [ ] **Step 3: Run tests, commit**

---

### Task 9: Learner

**Files:**
- Create: `waywiser/brain/extensions/brain/learner.ts`
- Test: `waywiser/brain/test/learner.test.ts`

**Interfaces:**
- Consumes: `Experience`, `DeterministicPass1Result`, `LearningResult`, `BrainConfig` from types/config; `CognitionPool` from cognition; `gatePrompt` from prompts; `confidenceForSource` from provenance
- Produces:
  - `deterministicExtract(experience: Experience, config: BrainConfig): DeterministicPass1Result`
  - `reflectiveExtract(experience: Experience, pass1: DeterministicPass1Result, pool: CognitionPool, config: BrainConfig): Promise<LearningResult>`
  - `validateCandidates(candidates: LearningResult, experience: Experience, config: BrainConfig): LearningResult`
  - `recordMemoryUsage(experience: Experience, store: BrainStore): void`

Key implementation:
- Pass 1 (deterministic): scan for user corrections (regex patterns), direct statements, tool failures, recoveries, skill usage, external sources
- Pass 2 (reflective): send ExperiencePacket to cognition worker, parse structured response
- `validateCandidates`: override LLM-chosen source with deterministic provenance, bound confidence, infer scope

- [ ] **Step 1: Write learner tests**

Focus on deterministic extraction — no LLM needed for unit tests:
- User correction detected: "no, actually use PostgreSQL" → correction extracted
- Tool failure detected: observation with `result: "error"` → failure extracted
- Recovery detected: observation with `recoveryOf` set → recovery pair extracted
- Nothing durable: simple Q&A with no corrections/failures → `hasDurableSignals: false`
- Authority hierarchy enforced: LLM cannot override provenance

- [ ] **Step 2: Implement learner.ts**
- [ ] **Step 3: Run tests, commit**

---

### Task 10: Procedures

**Files:**
- Create: `waywiser/brain/extensions/brain/procedures.ts`
- Test: `waywiser/brain/test/procedures.test.ts`

**Interfaces:**
- Consumes: `Procedure`, `ProcedureStatus`, `LearningResult`, `BrainStore` from types/store
- Produces:
  - `updateProcedureEvidence(experience: Experience, learning: LearningResult, store: BrainStore): void`
  - `generateProcedureKey(trigger: string, avoid: string | null, prefer: string | null): string`
  - `updateProcedureConfidence(proc: Procedure, outcome: "success" | "failure"): number`
  - `checkMaturity(proc: Procedure, config: BrainConfig): boolean`

Key implementation:
- `generateProcedureKey`: normalize trigger+avoid+prefer → deterministic key for dedup
- Upsert: if key exists, reinforce; if not, create tentative
- Confidence: Bayesian-ish update — success increases, failure decreases, bounded [0, 1]
- Status transitions: tentative → reinforced (2+ experiences) → mature (meets thresholds) → contradicted (if evidence conflicts)

- [ ] **Step 1-3: Write tests, implement, commit**

---

### Task 11: Consolidate

**Files:**
- Create: `waywiser/brain/extensions/brain/consolidate.ts`
- Test: `waywiser/brain/test/consolidate.test.ts` (for deterministic operations only)

**Interfaces:**
- Consumes: `BrainStore`, `CognitionPool`, `BrainConfig`; `consolidatePrompt`, `contradictionPrompt` from prompts
- Produces:
  - `consolidate(store: BrainStore, pool: CognitionPool, config: BrainConfig): Promise<ConsolidationReport>`
  - `ConsolidationReport` type with counts of each operation

Key implementation:
- Phase 1 (deterministic): superseded cleanup, stale archival, procedure evidence merge, retire failed procedures
- Phase 2 (LLM): near-duplicate clusters via FTS5 similarity → cognition worker merge
- Phase 3 (LLM): high-confidence active pairs → cognition worker contradiction check → log (don't auto-apply)
- Phase 4: procedure maturity check → flag ready for evolution
- Report written to `brain_log` and optionally to markdown

- [ ] **Step 1-3: Write tests (deterministic phases), implement, commit**

---

### Task 12: Skills

**Files:**
- Create: `waywiser/brain/extensions/brain/skills.ts`
- Test: `waywiser/brain/test/skills.test.ts`

**Interfaces:**
- Consumes: `SkillVersion`, `SkillStatus`, `BrainStore`, `BrainConfig`
- Produces:
  - `ensureSkillDirs(config: BrainConfig): void` — creates active/candidates/retired dirs
  - `writeCandidate(name: string, skillMd: string, metadata: object, config: BrainConfig): SkillVersion`
  - `promoteCandidate(name: string, versionHash: string, config: BrainConfig, store: BrainStore): void`
  - `rejectCandidate(name: string, versionHash: string, config: BrainConfig, store: BrainStore): void`
  - `rollbackSkill(name: string, config: BrainConfig, store: BrainStore): SkillVersion | null`
  - `listActiveSkills(config: BrainConfig): SkillVersion[]`
  - `listCandidates(config: BrainConfig): SkillVersion[]`
  - `getSkillDiscoverPaths(config: BrainConfig): string[]` — returns `[skillsRoot + "/active"]`

Key implementation:
- Directories: `{skillsRoot}/active/{name}/SKILL.md`, `candidates/{name}/{hash}/SKILL.md`, `retired/...`
- `promoteCandidate`: atomic move/copy, old active → retired, candidate → active
- `rollbackSkill`: find parent version in `skill_versions` table, swap
- `versionHash`: SHA-256 of SKILL.md content
- `metadata.json` alongside each SKILL.md

- [ ] **Step 1-3: Write tests (filesystem operations in temp dirs), implement, commit**

---

### Task 13: Eval

**Files:**
- Create: `waywiser/brain/extensions/brain/eval.ts`
- Test: `waywiser/brain/test/eval.test.ts`

**Interfaces:**
- Consumes: `BrainStore`, `CognitionPool`, `BrainConfig`; `judgePrompt` from prompts
- Produces:
  - `runEvaluation(candidateVersion: SkillVersion, baselineVersion: SkillVersion | null, store: BrainStore, pool: CognitionPool, config: BrainConfig): Promise<EvalVerdict>`
  - `generateEvalCases(procedure: Procedure, store: BrainStore, pool: CognitionPool): Promise<EvalCase[]>`
  - `EvalVerdict`: `{ pass: boolean; hardCheckResults: HardCheck[]; qualitativeResult?: string; details: string }`

Key implementation:
- `generateEvalCases`: derive from source experiences → replay cases + synthetic variations + regression cases
- For each case, run baseline and candidate via Pi `--print` mode with the respective skill
- Hard oracle checks: task completed, tool errors, required output
- Qualitative judge via cognition worker (only if hard checks pass)
- Verdict: candidate must be strictly better or equal on all hard checks

- [ ] **Step 1-3: Write tests (mock RPC for unit testing), implement, commit**

---

### Task 14: Evolve

**Files:**
- Create: `waywiser/brain/extensions/brain/evolve.ts`
- Test: `waywiser/brain/test/evolve.test.ts`

**Interfaces:**
- Consumes: `BrainStore`, `CognitionPool`, `BrainConfig`; `compileSkillPrompt` from prompts; skills module; eval module
- Produces:
  - `checkEvolutionTriggers(store: BrainStore, config: BrainConfig): Promise<void>`
  - `compileSkillFromProcedure(proc: Procedure, store: BrainStore, pool: CognitionPool): Promise<{ skillMd: string; metadata: object }>`
  - `runEvolutionPipeline(proc: Procedure, store: BrainStore, pool: CognitionPool, config: BrainConfig): Promise<EvolutionRun>`
  - `promotePending(store: BrainStore, config: BrainConfig): void` — called at session boundary

Key implementation:
- `checkEvolutionTriggers`: find mature procedures not yet compiled → spawn evolution pipeline
- `compileSkillFromProcedure`: cognition worker generates SKILL.md from procedure + evidence
- Static validation: parseable, <10KB, no forbidden directives
- `promotePending`: at session boundary, check for passed candidates → promote per policy

- [ ] **Step 1-3: Write tests, implement, commit**

---

### Task 15: Vault

**Files:**
- Create: `waywiser/brain/extensions/brain/vault.ts`
- Test: `waywiser/brain/test/vault.test.ts`

**Interfaces:**
- Consumes: `BrainStore`, `BrainConfig`, `BrainMemory`, `Procedure`
- Produces:
  - `vaultSyncInbound(store: BrainStore, config: BrainConfig): Promise<void>` — vault → DB (detect human edits)
  - `vaultSyncOutbound(store: BrainStore, config: BrainConfig): Promise<void>` — DB → vault (write markdown)
  - `renderMemoryMarkdown(mem: BrainMemory, evidenceIds: string[]): string`
  - `renderProcedureMarkdown(proc: Procedure, evidenceIds: string[]): string`
  - `parseMemoryMarkdown(content: string): Partial<BrainMemory> | null`

Key implementation:
- Each memory → `{markdownRoot}/{structure.semantic}/{type}-{slug}.md` with YAML frontmatter
- Each procedure → `{markdownRoot}/{structure.procedures}/{key}.md`
- Inbound sync: hash comparison via `vault_sync` table; changed files imported as user-authoritative
- Outbound sync: write all memories/procedures changed since last sync
- Conflict resolution per `config.vault.conflictResolution`
- YAML frontmatter: id, kind, scope, confidence, status, revision, evidence, created, accessed

- [ ] **Step 1-3: Write tests (temp dirs for filesystem ops), implement, commit**

---

### Task 16: Policy

**Files:**
- Create: `waywiser/brain/extensions/brain/policy.ts`
- Test: `waywiser/brain/test/policy.test.ts`

**Interfaces:**
- Consumes: `BrainConfig`, `MemoryScope`
- Produces:
  - `inferScope(userText: string, cwd: string, config: BrainConfig): MemoryScope`
  - `detectProjectKey(cwd: string, config: BrainConfig): string | null`
  - `isPromotionEligible(proc: Procedure, evalResult: EvalVerdict, config: BrainConfig): boolean`
  - `SAFETY_BOUNDARIES: readonly string[]` — hardcoded rules that cannot be overridden

- [ ] **Step 1-3: Write tests, implement, commit**

---

### Task 17: Root Extension (index.ts) + Tool Registration

**Files:**
- Create: `waywiser/brain/extensions/brain/index.ts`

**Interfaces:**
- Consumes: ALL modules
- Produces: Pi extension default export `(pi: ExtensionAPI) => void`

Key implementation:
- The exact lifecycle code from spec §5
- Module composition with failure containment
- Pi event handlers: `resources_discover`, `session_start`, `before_agent_start`, `agent_start`, `tool_call`, `tool_result`, `turn_end`, `agent_settled`, `session_shutdown`
- Tool registrations: `evolve` tool (read-only actions)
- Command registrations: `/brain status`, `/brain sync`, `/brain consolidate`, `/brain evolve *`, `/brain experience`, `/brain procedure`, `/brain memory`, `/brain config`

- [ ] **Step 1: Implement index.ts**

Full lifecycle from spec §5 with all hooks wired. Module load order:
```
config → store → provenance → trace → cognition →
recall → learner → procedures → recovery →
consolidate → skills → evolve → eval → vault
```

- [ ] **Step 2: Implement tool registration** (`evolve` tool)
- [ ] **Step 3: Implement command registration** (`/brain *` commands)
- [ ] **Step 4: Commit**

---

### Task 18: Bug Fixes + Compatibility Facades

**Files:**
- Modify: `waywiser/extensions/memory.ts` — facade over brain
- Modify: `waywiser/extensions/skills-manage.ts` — facade over brain
- Modify: `waywiser/extensions/soul.ts` — narrow mode + session snapshot
- Modify: `waywiser/extensions/memrules.ts` — unicode tokenizer
- Modify: `waywiser/extensions/commands.ts` — `/waywiser status` reads SQLite not kanban.json
- Modify: `waywiser/extensions/utils/state.ts` — version sync
- Modify: `waywiser/package.json` — peer dep floor + brain dependency
- Modify: `waywiser/extensions/index.ts` — load brain first

**Bug fixes (all 7 from spec §7):**

1. **recall=off** — handled in brain's recall module; facade delegates to brain
2. **ASCII tokenizer** — brain's store.ts migrates FTS to unicode61; also fix waywiser's `memrules.ts` `tokens()` and `buildRecallQuery()` to use unicode regex `/[\p{L}\p{N}_]{2,}/gu`
3. **access_count** — handled in brain's recall module
4. **gateAccum** — handled in brain's index.ts (reset in session_start)
5. **WAYWISER_VERSION** — `config.ts` reads from `package.json`; update `utils/state.ts` to match
6. **kanban.json** — update `commands.ts` to read from SQLite `boards`/`cards` tables
7. **Peer dep** — update both `package.json` files to `>=0.84.2`

**Compatibility facades:**

`memory.ts` changes:
- `memAction("remember", ...)`: when brain is available, use `store.remember()` with provenance from `isCallFromUser(ctx)`
- `memAction("recall", ...)`: delegate to brain's `recall()`
- `memAction("forget", ...)`: archive (set `status: "archived"`) instead of delete

`skills-manage.ts` changes:
- `skill_manage("create", ...)`: if model-initiated → `candidates/`; if user command → `active/`
- `skill_manage("delete", ...)`: move to `retired/` instead of `rmSync`

`soul.ts` changes:
- When `config.soul.snapshotAtStart`: load SOUL once at `session_start`, cache it, use cached version in `before_agent_start`
- When `config.soul.narrowMode`: redirect `append_preference` and `append_lesson` to brain memory

- [ ] **Step 1: Fix waywiser/package.json** — add brain dep, bump peer floor
- [ ] **Step 2: Fix memrules.ts tokenizer** — `[\p{L}\p{N}_]{2,}` with `/gu` flag
- [ ] **Step 3: Fix commands.ts** — kanban reads from SQLite
- [ ] **Step 4: Fix utils/state.ts** — version from package.json
- [ ] **Step 5: Update memory.ts** — facade over brain
- [ ] **Step 6: Update skills-manage.ts** — facade over brain
- [ ] **Step 7: Update soul.ts** — narrow mode + snapshot
- [ ] **Step 8: Update index.ts** — load brain extension
- [ ] **Step 9: Commit**

---

### Task 19: Brain Skill + README

**Files:**
- Create: `waywiser/brain/skills/brain/SKILL.md`
- Create: `waywiser/brain/README.md`

**SKILL.md** — the operating instructions that Pi injects into context when the brain skill is relevant:

```markdown
---
name: brain
description: Self-learning brain with procedural memory, auto-evolution, and Obsidian-compatible vault
---

# Brain

Brain is Waywiser's self-learning system. It observes your work, extracts durable knowledge,
and evolves its own skills based on evidence.

## What Brain Does Automatically

- **Observes** tool calls and results during your session
- **Learns** at session boundaries (agent_settled) — not mid-turn
- **Recalls** relevant memories and procedures before each agent run
- **Evolves** mature procedures into native Pi skills after competitive evaluation

## Tools

- `evolve` — inspect the evolution system (status, candidates, history)
- `memory` — remember/recall/search memories (existing Waywiser tool)

## Commands

- `/brain status` — full observability dashboard
- `/brain sync` — sync vault with database
- `/brain consolidate` — run memory consolidation
- `/brain evolve status|promote|reject|rollback|evaluate`

## What You Should Know

- Memories have provenance: user, agent, external, environment
- External information enters frozen at low confidence until promoted
- Procedures accumulate evidence across sessions before becoming skills
- Skills are evaluated competitively before promotion
- Everything is traceable to the Pi session that created it
```

- [ ] **Step 1: Write SKILL.md**
- [ ] **Step 2: Write README.md**
- [ ] **Step 3: Commit**

---

### Task 20: Integration + Smoke Tests

**Files:**
- Create: `waywiser/brain/test/brain.test.ts` (integration)
- Create: `waywiser/brain/test/smoke.test.ts`

**Integration tests** (brain.test.ts):
- Full lifecycle: create store → trace events → finalize experience → learn → verify memories created
- Settled-run learning: verify learner fires at finalize, not at turn_end
- Branch awareness: observations only from active branch
- Memory usage tracking: injected memories tracked, useful/not-useful recorded
- Procedure lifecycle: tentative → reinforced → mature
- Skill lifecycle: candidate created → eval → promoted/rejected
- Vault sync: DB → markdown → edit markdown → inbound sync imports changes

**Smoke tests** (smoke.test.ts):
- All modules load without error
- Config validates and applies defaults
- Database migrations are idempotent (run twice, no error)
- FTS unicode search returns results for Romanian text

- [ ] **Step 1: Write integration tests**
- [ ] **Step 2: Write smoke tests**
- [ ] **Step 3: Run full test suite**

Run: `cd waywiser/brain && node --test test/*.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(brain): Waywiser Brain v1.0.0 — self-learning, auto-evolving brain extension"
```
