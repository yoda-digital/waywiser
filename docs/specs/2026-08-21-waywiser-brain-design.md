# Waywiser Brain — Full Design Specification

**Date:** 2026-08-21
**Status:** Draft
**Scope:** New Pi package `@yoda-digital/waywiser-brain` — self-learning, auto-evolving brain for the Waywiser agent. Ships as a sibling package inside the `pi-assistant` monorepo.

---

## 1. Philosophy

Pi sessions are what happened.
Brain is what was learned.
Pi Skills are what Brain learned to do differently.
Evaluation decides whether the new behavior deserves to survive.

Brain is a **separate Pi package** with **pluggable internal modules**. It works standalone or alongside Waywiser. When Waywiser is present, existing `memory` and `skill_manage` tools become compatibility facades over Brain services.

### 1.1 Non-Negotiable Principles

1. **Pi-native only.** Every lifecycle event, state persistence, and skill injection uses Pi's extension API directly. No second event bus, no middleware, no daemon.
2. **Everything is a plugin.** Brain is a Pi package. Its modules are composable units — each can be enabled/disabled via configuration. Waywiser depends on Brain, not the reverse.
3. **Evidence before belief.** No memory, procedure, or skill change without traceable provenance to a real Pi event.
4. **Prompt-cache stability.** The system prompt prefix never changes mid-session. Memory context is injected via `before_agent_start` custom messages, not system-prompt mutation.
5. **Kernel safety.** Brain can autonomously evolve memories, procedures, and skills. It cannot autonomously rewrite its own policy, provenance rules, or evaluation kernel.
6. **No premature complexity.** FTS5/BM25 for retrieval. SQLite for state. Markdown for human inspection. Embeddings, vectors, and graph databases are future adapters that must earn their place through Brain's own evaluation system.

### 1.2 What Brain Does NOT Introduce

- No LangGraph, Mem0, or external memory framework
- No vector database
- No MCP server between Brain and itself
- No Obsidian runtime dependency (Obsidian is optional UX)
- No hidden daemon or filesystem watcher
- No second skill format (Pi native only)
- No second agent runtime
- No full transcript duplication into SQLite
- No autonomous kernel self-modification

---

## 2. Package Architecture

```
waywiser/                              # git repo: github.com/yoda-digital/waywiser
├── package.json                       # existing Waywiser package (adds brain dep)
├── extensions/
│   ├── index.ts                       # load order: brain first, then capabilities
│   ├── memory.ts                      # → compatibility facade over brain
│   ├── skills-manage.ts               # → compatibility facade over brain
│   ├── soul.ts                        # → narrow mode + session snapshot
│   └── ...
├── skills/
├── config/
├── bin/
├── test/
│
├── brain/                             # NEW — @yoda-digital/waywiser-brain package
│   ├── package.json                   # name: "@yoda-digital/waywiser-brain"
│   ├── extensions/
│   │   └── brain/
│   │       ├── index.ts               # Root extension — lifecycle, module composition
│   │       ├── types.ts               # All shared types
│   │       ├── config.ts              # Configuration loading, defaults, validation
│   │       ├── trace.ts               # ExperienceTrace — structured event collection
│   │       ├── store.ts               # Brain database — schema, migrations, CRUD
│   │       ├── provenance.ts          # Deterministic source classification
│   │       ├── recall.ts              # Reciprocal-rank-fusion retrieval
│   │       ├── learner.ts             # Two-pass learning pipeline
│   │       ├── procedures.ts          # Procedural memory with evidence
│   │       ├── consolidate.ts         # Memory/procedure consolidation
│   │       ├── skills.ts              # Skill lifecycle (active/candidates/retired)
│   │       ├── evolve.ts              # Evolution pipeline (procedure → skill)
│   │       ├── eval.ts                # Competitive evaluation (baseline vs candidate)
│   │       ├── vault.ts               # Markdown projection + Obsidian-compatible sync
│   │       ├── policy.ts              # Configurable promotion/learning/scope rules
│   │       ├── cognition.ts           # Warm RPC pool for meta-workers
│   │       ├── prompts.ts             # All LLM prompts (gate, reflect, compile, judge)
│   │       └── recovery.ts            # Deterministic + reflective recovery linking
│   ├── skills/
│   │   └── brain/
│   │       └── SKILL.md               # Brain operating instructions for the agent
│   ├── test/
│   │   ├── brain.test.ts
│   │   ├── trace.test.ts
│   │   ├── provenance.test.ts
│   │   ├── recall.test.ts
│   │   ├── learner.test.ts
│   │   ├── procedures.test.ts
│   │   ├── recovery.test.ts
│   │   ├── skills.test.ts
│   │   ├── evolve.test.ts
│   │   ├── eval.test.ts
│   │   ├── vault.test.ts
│   │   ├── policy.test.ts
│   │   └── smoke.test.ts
│   └── README.md
│
└── docs/specs/
    └── 2026-08-21-waywiser-brain-design.md
```

**Note:** `pi-assistant/` is a local working directory only — no git, no remote. The `waywiser/` subdirectory is the git repo (`github.com/yoda-digital/waywiser`). Brain lives at `waywiser/brain/` so it's tracked in the same repo.

### 2.1 Package Manifest

```json
{
  "name": "@yoda-digital/waywiser-brain",
  "version": "1.0.0",
  "keywords": ["pi-package", "pi-extension", "brain", "self-learning", "evolution"],
  "type": "module",
  "pi": {
    "extensions": ["extensions"],
    "skills": ["skills"]
  },
  "engines": { "node": ">=22.5" },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.84.2"
  }
}
```

The peer floor is `>=0.84.2` — the minimum version with `agent_settled`, `resources_discover`, `getBranch()`, and typed tool events.

### 2.2 Waywiser Integration

Waywiser adds `@yoda-digital/waywiser-brain` as a dependency. Pi discovers both packages and loads their extensions. Load order: Brain first (Pi respects dependency order), then Waywiser.

Waywiser's existing `memory.ts` becomes a compatibility facade: tool registrations remain unchanged, but internal operations delegate to Brain's store and recall modules. `skills-manage.ts` delegates to Brain's skills module, routing model-initiated creates to `candidates/` instead of `active/`.

### 2.3 Module Composition

Brain's root `index.ts` composes modules like Waywiser's own root extension — independent submodules loaded in order, with individual failure containment:

```
Load order:
  config → store → provenance → trace → cognition →
  recall → learner → procedures → recovery →
  consolidate → skills → evolve → eval → vault
```

Each module can be disabled via config. A disabled module's hooks are simply not registered. Dependencies are checked at load time: if `evolve` is enabled but `eval` is disabled, Brain logs a warning and disables `evolve`.

---

## 3. Configuration Model

### 3.1 Config File

`~/.waywiser/brain.json` (or `$BRAIN_CONFIG` env var). Loaded once at extension init, reloaded at `session_start`.

### 3.2 Full Config Type

```typescript
interface BrainConfig {
  // ── Paths (independently configurable) ──────────────────────
  /** Root for markdown projection. Default: ~/.waywiser/brain/ */
  markdownRoot: string;
  /** SQLite database file. Default: ~/.waywiser/waywiser.db (shared with Waywiser) */
  dbPath: string;
  /** Root for skill directories. Default: ~/.waywiser/skills/ */
  skillsRoot: string;
  /** Root for experience custom entry anchors. Default: null (uses Pi session files) */
  experienceRoot: string | null;

  // ── Module toggles ──────────────────────────────────────────
  modules: {
    trace: boolean;        // default: true
    learner: boolean;      // default: true
    procedures: boolean;   // default: true
    recovery: boolean;     // default: true
    consolidate: boolean;  // default: true
    skills: boolean;       // default: true
    evolve: boolean;       // default: true — requires skills + eval
    eval: boolean;         // default: true — requires skills
    vault: boolean;        // default: true
    cognition: boolean;    // default: true
  };

  // ── Learning ────────────────────────────────────────────────
  learning: {
    /** Event boundary for learning. Default: agent_settled */
    boundary: "agent_settled" | "turn_end";
    /** Max reflective LLM calls per session. Default: 10 */
    maxReflectionsPerSession: number;
    /** Max memories created per settled run. Default: 3 */
    maxMemoriesPerRun: number;
    /** Gate timeout for the reflective pass. Default: 12000 */
    gateTimeoutMs: number;
    /** Minimum observations before triggering reflection. Default: 1 */
    minObservationsForReflection: number;
  };

  // ── Recall ──────────────────────────────────────────────────
  recall: {
    /** Recall mode. Default: selective */
    mode: "selective" | "top8" | "off";
    /** Max items injected. Default: 8 */
    maxItems: number;
    /** Max chars for context. Default: 2000 */
    maxChars: number;
    /** Reciprocal rank fusion weights. Sum doesn't need to equal 1. */
    fusionWeights: {
      lexical: number;     // default: 1.0
      scope: number;       // default: 0.8
      usage: number;       // default: 0.5
      confidence: number;  // default: 0.3
      recency: number;     // default: 0.2
    };
    /** Inject via custom message (true) or system prompt (false). Default: true */
    useCustomMessage: boolean;
  };

  // ── Provenance ──────────────────────────────────────────────
  provenance: {
    /** Confidence for external/tool-derived info. Default: 0.3 */
    externalConfidence: number;
    /** Confidence for user-stated info. Default: 0.9 */
    userConfidence: number;
    /** Confidence for agent-inferred info. Default: 0.7 */
    agentConfidence: number;
    /** Confidence for environment observations. Default: 0.6 */
    environmentConfidence: number;
  };

  // ── Scoping ─────────────────────────────────────────────────
  scoping: {
    /** Default scope for new memories. Default: infer */
    defaultScope: "global" | "project" | "infer";
    /** How to detect project boundaries. Default: git-root */
    projectDetection: "git-root" | "cwd" | "package-json" | "explicit";
    /** Boost factor for in-scope memories during recall. Default: 2.0 */
    scopeBoost: number;
  };

  // ── Evolution ───────────────────────────────────────────────
  evolution: {
    /** Maturity requirements before procedure → candidate skill. */
    maturity: {
      /** Min positive observations. Default: 3 */
      minPositiveObservations: number;
      /** Min independent settled experiences. Default: 2 */
      minIndependentExperiences: number;
      /** Min success ratio. Default: 0.75 */
      minSuccessRatio: number;
      /** Must have no unresolved contradictions. Default: true */
      requireNoContradictions: boolean;
    };
    /** Number of eval cases per candidate. Default: 5 */
    evalCasesPerCandidate: number;
    /** Promotion policy. Default: auto */
    promotionPolicy: "auto" | "manual" | "confirm";
    /** When to apply promoted skills. Default: next-session */
    promotionBoundary: "next-session" | "reload" | "immediate";
  };

  // ── Vault ───────────────────────────────────────────────────
  vault: {
    /** Sync vault on session start. Default: true */
    syncOnStart: boolean;
    /** Sync vault on session shutdown. Default: true */
    syncOnShutdown: boolean;
    /** Conflict resolution when human edits conflict. Default: human-wins */
    conflictResolution: "human-wins" | "merge" | "prompt";
    /** Subfolder names within markdownRoot. */
    structure: {
      semantic: string;     // default: "semantic"
      procedures: string;   // default: "procedures"
      projects: string;     // default: "projects"
      entities: string;     // default: "entities"
      hypotheses: string;   // default: "hypotheses"
      archive: string;      // default: "archive"
      skills: string;       // default: "skills"
    };
  };

  // ── Cognition pool ──────────────────────────────────────────
  cognition: {
    /** Max idle workers in the pool. Default: 2 */
    poolSize: number;
    /** Model for meta-workers. Default: null (inherit from Pi) */
    model: string | null;
    /** Thinking level for meta-workers. Default: null (inherit) */
    thinkingLevel: string | null;
    /** Idle TTL in ms. Default: 600000 (10 min) */
    idleTtlMs: number;
  };

  // ── SOUL integration ────────────────────────────────────────
  soul: {
    /** Narrow mode: SOUL = identity + constitution only. Default: true */
    narrowMode: boolean;
    /** Snapshot SOUL at session_start, immutable until next session. Default: true */
    snapshotAtStart: boolean;
  };

  // ── Consolidation ───────────────────────────────────────────
  consolidation: {
    /** Max memories processed per consolidation run. Default: 50 */
    batchSize: number;
    /** Run consolidation on session_shutdown. Default: true */
    runOnShutdown: boolean;
    /** Dry-run by default (propose changes, don't apply). Default: false */
    dryRunByDefault: boolean;
  };
}
```

### 3.3 Obsidian Vault Scenarios

The structured config enables all vault scenarios:

| Scenario | markdownRoot | dbPath | skillsRoot |
|----------|-------------|--------|------------|
| **Standalone** (default) | `~/.waywiser/brain/` | `~/.waywiser/waywiser.db` | `~/.waywiser/skills/` |
| **Subfolder in vault** | `~/MyVault/Brain/` | `~/.waywiser/waywiser.db` | `~/.waywiser/skills/` |
| **Brain IS the vault** | `~/BrainVault/` | `~/BrainVault/.brain.db` | `~/BrainVault/skills/` |
| **Fully distributed** | `~/MyVault/Brain/` | `~/data/brain.db` | `~/MyVault/Brain/skills/` |
| **Shared vault, own DB** | `~/TeamVault/MyBrain/` | `~/.waywiser/brain.db` | `~/.waywiser/skills/` |

### 3.4 Environment Variable Overrides

Every path config has an env var override (highest priority):

```
BRAIN_MARKDOWN_ROOT  → markdownRoot
BRAIN_DB_PATH        → dbPath
BRAIN_SKILLS_ROOT    → skillsRoot
BRAIN_CONFIG         → config file location
```

---

## 4. Module Specifications

### 4.1 Types (`types.ts`)

Core types shared across all modules:

```typescript
// ── Provenance ────────────────────────────────────────────────
type ProvenanceSource = "user" | "agent" | "external" | "environment" | "existing-memory";

interface ProvenanceRecord {
  source: ProvenanceSource;
  confidence: number;
  /** The Pi event that originated this data */
  originEvent: "user_message" | "assistant_message" | "tool_result" | "memory_recall" | "filesystem" | "web" | "mcp";
  /** Tool name if tool-derived */
  toolName?: string;
  /** Session context */
  sessionId: string;
  branchLeaf: string;
}

// ── Observations ──────────────────────────────────────────────
interface Observation {
  id: string;
  toolCallId: string;
  tool: string;
  /** Canonical target extracted from tool args (file path, URL, etc.) */
  targetKey: string;
  input: Record<string, unknown>;
  result: "success" | "error";
  errorClass?: string;
  /** If this observation recovered from a prior failure */
  recoveryOf?: string;
  provenance: ProvenanceSource;
  /** Compact details (NOT full tool output — that lives in the Pi session) */
  detailsJson?: string;
  timestamp: string;
}

// ── Experience ────────────────────────────────────────────────
interface Experience {
  id: string;
  sessionId: string;
  sessionFile: string;
  branchLeaf: string;
  cwd: string;
  projectKey: string;
  objective: string;
  outcome: ExperienceOutcome;
  observations: Observation[];
  recalledMemoryIds: number[];
  recalledProcedureIds: string[];
  skillsUsed: Array<{ name: string; versionHash: string }>;
  externalSources: string[];  // observation IDs with external provenance
  startedAt: string;
  settledAt: string;
}

interface ExperienceOutcome {
  status: "success" | "failure" | "partial" | "unknown";
  confidence: "verified" | "inferred" | "unknown";
  summary: string;
}

// ── Memory ────────────────────────────────────────────────────
type MemoryType = "fact" | "preference" | "decision" | "lesson";
type MemoryScope = "global" | "project" | "session";
type MemoryStatus = "active" | "frozen" | "archived" | "superseded";

interface BrainMemory {
  id: number;
  type: MemoryType;
  content: string;
  confidence: number;
  source: ProvenanceSource;
  scope: MemoryScope;
  projectKey: string | null;
  status: MemoryStatus;
  verbatim: string | null;
  tags: string;
  supersedesId: number | null;
  sourceSession: string;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  usefulCount: number;
  notUsefulCount: number;
}

// ── Procedure ─────────────────────────────────────────────────
type ProcedureStatus = "tentative" | "reinforced" | "mature" | "contradicted" | "retired";

interface Procedure {
  id: string;
  key: string;
  triggerText: string;
  avoidText: string | null;
  preferText: string | null;
  confidence: number;
  successCount: number;
  failureCount: number;
  status: ProcedureStatus;
  scope: MemoryScope;
  projectKey: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Skill Versions ────────────────────────────────────────────
type SkillStatus = "candidate" | "evaluating" | "active" | "retired" | "rejected";

interface SkillVersion {
  id: string;
  name: string;
  versionHash: string;
  parentVersion: string | null;
  status: SkillStatus;
  sourceProcedureIds: string[];
  path: string;
  evalRunId: string | null;
  createdAt: string;
  promotedAt: string | null;
}

// ── Evolution ─────────────────────────────────────────────────
type EvolutionStatus = "pending" | "running" | "passed" | "failed" | "cancelled";

interface EvolutionRun {
  id: string;
  skillVersionId: string;
  baselineVersionId: string | null;
  status: EvolutionStatus;
  resultJson: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ── Recall Result ─────────────────────────────────────────────
interface RecallResult {
  items: RecallItem[];
  memoryIds: number[];
  procedureIds: string[];
  revision: number;
}

interface RecallItem {
  type: "memory" | "procedure";
  id: number | string;
  content: string;
  score: number;
  scope: MemoryScope;
  fusionBreakdown: {
    lexical: number;
    scope: number;
    usage: number;
    confidence: number;
    recency: number;
  };
}
```

### 4.2 Config (`config.ts`)

- Loads `brain.json` from `BRAIN_CONFIG` env var or `~/.waywiser/brain.json`
- Deep-merges with defaults
- Validates ranges (confidence 0-1, timeouts clamped, etc.)
- Exports `brainConfig(): BrainConfig` — cached, reloaded on `session_start`
- Exports `brainHome(): string` — the markdownRoot
- Env var overrides applied after file load

### 4.3 Store (`store.ts`)

Opens or creates the Brain SQLite database. If `dbPath` points to an existing Waywiser database, Brain adds its tables alongside the existing schema. If it points to a new file, Brain creates a standalone database.

**Schema (all tables added via idempotent migration):**

```sql
-- ── Experiences ───────────────────────────────────────────────
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

-- ── Observations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS experience_observations (
    id TEXT PRIMARY KEY,
    experience_id TEXT NOT NULL REFERENCES experiences(id),
    tool_call_id TEXT,
    tool TEXT NOT NULL,
    target_key TEXT,
    input_json TEXT,
    result TEXT NOT NULL,  -- 'success' | 'error'
    error_class TEXT,
    recovery_of TEXT,      -- observation ID this recovered from
    provenance TEXT NOT NULL,
    details_json TEXT,
    timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_exp ON experience_observations(experience_id);
CREATE INDEX IF NOT EXISTS idx_obs_target ON experience_observations(target_key);
CREATE INDEX IF NOT EXISTS idx_obs_recovery ON experience_observations(recovery_of);

-- ── Memory Evidence ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_evidence (
    memory_id INTEGER NOT NULL,
    experience_id TEXT NOT NULL,
    observation_id TEXT,
    relation TEXT NOT NULL,  -- 'created_from' | 'reinforced_by' | 'contradicted_by'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(memory_id, experience_id, COALESCE(observation_id, ''))
);

-- ── Memory Usage Tracking ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL,
    experience_id TEXT NOT NULL,
    injected INTEGER NOT NULL DEFAULT 1,
    useful INTEGER,          -- null = unknown, 1 = useful, 0 = not useful
    contradicted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_musage_mem ON memory_usage(memory_id);

-- ── Procedures ────────────────────────────────────────────────
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

-- FTS for procedure recall
CREATE VIRTUAL TABLE IF NOT EXISTS procedures_fts USING fts5(
    trigger_text, avoid_text, prefer_text,
    content='procedures', content_rowid='rowid',
    tokenize='unicode61'
);

-- ── Procedure Evidence ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS procedure_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    procedure_id TEXT NOT NULL REFERENCES procedures(id),
    experience_id TEXT NOT NULL,
    observation_id TEXT,
    outcome TEXT NOT NULL,  -- 'success' | 'failure' | 'neutral'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pevid_proc ON procedure_evidence(procedure_id);

-- ── Skill Versions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_versions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version_hash TEXT NOT NULL,
    parent_version TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    source_procedure_ids TEXT,  -- JSON array
    path TEXT NOT NULL,
    eval_run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    promoted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sv_name ON skill_versions(name);
CREATE INDEX IF NOT EXISTS idx_sv_status ON skill_versions(status);

-- ── Evolution Runs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS evolution_runs (
    id TEXT PRIMARY KEY,
    skill_version_id TEXT NOT NULL REFERENCES skill_versions(id),
    baseline_version_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

-- ── Eval Cases ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_cases (
    id TEXT PRIMARY KEY,
    skill_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    oracle_json TEXT,        -- deterministic check criteria
    safety_class TEXT NOT NULL DEFAULT 'safe',
    source_experience_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ec_skill ON eval_cases(skill_name);

-- ── Eval Runs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    evolution_run_id TEXT NOT NULL REFERENCES evolution_runs(id),
    case_id TEXT NOT NULL REFERENCES eval_cases(id),
    treatment TEXT NOT NULL,  -- 'baseline' | 'candidate'
    outcome_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Vault Sync State ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vault_sync (
    file_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    memory_id INTEGER,
    procedure_id TEXT,
    last_synced TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Brain Audit Log ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brain_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    details TEXT NOT NULL,
    experience_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Existing table modifications** (when sharing waywiser.db):

```sql
-- Add scope + usage columns to memories (idempotent ALTERs)
ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE memories ADD COLUMN project_key TEXT;
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memories ADD COLUMN useful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN not_useful_count INTEGER NOT NULL DEFAULT 0;

-- Fix ASCII tokenizer: recreate FTS with unicode61
-- (migration detects existing tokenizer and rebuilds if needed)
```

**FTS5 Unicode migration:** The existing `memories_fts` uses the default tokenizer (ASCII `[a-z0-9_]`). Brain detects this and recreates the FTS table with `tokenize='unicode61'`, preserving all indexed data. This fixes Romanian, Russian, and all non-Latin recall.

### 4.4 Trace (`trace.ts`)

Collects structured execution events during a run. Produces an `Experience` record when finalized at `agent_settled`.

**Pi events consumed:**

| Event | Action |
|-------|--------|
| `agent_start` | `trace.beginRun()` — reset observation buffer |
| `tool_call` | `trace.toolCall(event)` — record tool name, args, extract target key |
| `tool_result` | `trace.toolResult(event)` — record result/error, link recovery |
| `turn_end` | `trace.turnEnd(event)` — capture assistant text for objective inference |
| `agent_settled` | `trace.finalize(ctx)` — produce the complete Experience |

**Target key extraction** (deterministic, per tool):

| Tool | Target Key |
|------|-----------|
| `read` | file path |
| `edit` | file path |
| `write` | file path |
| `grep` | `pattern@path` |
| `find` | path |
| `ls` | path |
| `bash` | conservative parse: first non-flag argument if the command is a known file-oriented command (`cat`, `rm`, `cp`, `mv`, `mkdir`, `chmod`, etc.); otherwise the full command truncated to 200 chars |
| `web_search` | query |
| `web_fetch` | URL |
| custom/MCP | `toolName:firstStringArg` |

**Recovery linking** (deterministic where possible):

When a `tool_result` with `result: "success"` arrives and there exists a prior observation with `result: "error"` on the **same target key** within the current run, the successful observation is tagged with `recoveryOf: <failed_observation_id>`.

For ambiguous cases (bash commands with unclear targets, multiple potential failure sources), recovery linking is deferred to the reflective pass in the learner.

**Branch safety:** `finalize()` reads `ctx.sessionManager.getBranch()` (not `getEntries()`) to extract the current branch leaf and ensure all observations belong to the active branch.

### 4.5 Provenance (`provenance.ts`)

Deterministic source classification. The LLM never chooses its own provenance — it proposes meaning, but provenance is computed from the Pi event type.

**Classification rules:**

```
User message (turn_end.role === "user")
    → source: "user", confidence: config.provenance.userConfidence

Assistant message (turn_end.role === "assistant")
    → source: "agent", confidence: config.provenance.agentConfidence

Tool result from web_search, web_fetch, MCP tool
    → source: "external", confidence: config.provenance.externalConfidence

Tool result from read, ls, find, grep, bash
    → source: "environment", confidence: config.provenance.environmentConfidence

Memory recalled from Brain
    → source: "existing-memory", confidence: (original memory's confidence)
```

**Kernel invariant:** The `remember` tool (compatibility facade) determines source from the **call context**, not from the caller's declared parameter:

```
Explicit user /memory remember command → source: "user"
Model-initiated memory.remember tool call → source: "agent"
Tool-derived information → source: "external" or "environment"
```

This closes the privilege escalation where an agent could self-promote its inferences to user-grade truth.

### 4.6 Recall (`recall.ts`)

Memory retrieval using reciprocal rank fusion across multiple signals.

**Retrieval pipeline:**

```
Query (prompt + cwd + branch + active goals)
    │
    ├── FTS5/BM25 lexical relevance (unicode61 tokenizer)
    ├── Scope relevance (project match → boost)
    ├── Usage history (useful_count - not_useful_count)
    ├── Confidence (memory confidence value)
    └── Recency (days since last accessed, logarithmic decay)
    │
    ▼
Reciprocal rank fusion:
    score = Σ (weight_i / (k + rank_i))  where k = 60

    │
    ▼
Bounded result (config.recall.maxItems, config.recall.maxChars)
```

**Key behaviors:**
- **ALL recall paths bump `access_count`** — both automatic and explicit. This fixes the current asymmetry where automatic recall doesn't update access statistics.
- **`recall=off` truly means off** — no digest injection, no FTS query, no access bumps. Returns empty result immediately.
- **Unicode-aware tokenization** — FTS5 with `unicode61` tokenizer. Romanian "decizii" and Russian "решения" produce proper tokens.
- **Procedure recall** — Procedures are recalled alongside memories. A procedure's trigger text is matched against the query. Mature procedures rank higher.

**Injection method:**

When `config.recall.useCustomMessage` is true (default), recalled context is injected via `before_agent_start` as a custom message:

```typescript
return {
  message: {
    customType: "waywiser/brain-context",
    content: renderBrainContext(recalled),
    display: false,
    details: {
      memoryIds: recalled.memoryIds,
      procedureIds: recalled.procedureIds,
      brainRevision: recalled.revision,
    },
  },
};
```

This preserves prompt-cache stability — the system prompt never changes. Memory IDs are in `details` (not model-visible) for provenance tracking.

### 4.7 Learner (`learner.ts`)

Two-pass learning from ExperiencePackets. Runs at `agent_settled`.

**Pass 1: Deterministic extraction** (no LLM, always runs)

Scans the Experience for:

1. **Explicit user corrections** — user messages containing "no, actually", "wrong", "instead", "correction" patterns → candidate memory with `source: "user"`
2. **Direct user statements** — declarative user messages about preferences, facts, decisions → candidate memory with `source: "user"`
3. **Tool failures** — observations with `result: "error"` → candidate procedure evidence (negative)
4. **Successful recoveries** — observations with `recoveryOf` set → candidate procedure evidence (positive) + avoid/prefer pair
5. **Skill usage** — which skills were active during this experience → usage record
6. **External sources** — which observations have external provenance → tagged for evidence

If pass 1 finds **nothing potentially durable** (no user statements, no failures, no recoveries, no corrections), learning stops here. No LLM call.

**Pass 2: Reflective extraction** (LLM via cognition pool, conditional)

Only runs when pass 1 found at least `config.learning.minObservationsForReflection` durable signals.

Sends the ExperiencePacket (structured, not prose) to a cognition worker with a learner prompt that asks:

1. What lasting knowledge should be preserved from this experience?
2. Are there procedural patterns (when X, prefer Y over Z)?
3. Are there scope-specific facts (this project uses X)?
4. Were any recalled memories **wrong** or **unhelpful**?

The reflective worker returns structured candidates. Each candidate is validated:

- Must have grounding in the ExperiencePacket (verbatim or paraphrase match)
- Source classification is **overridden** by deterministic provenance (the LLM cannot choose its own authority)
- Confidence is bounded by the provenance source's configured confidence
- Scope is inferred conservatively from cwd/git-root/explicit wording

**Authority hierarchy (immutable):**

```
Level 0: Raw observations          — immutable
Level 1: Semantic memories         — created automatically if evidence validates
Level 2: Procedures                — reinforced automatically
Level 3: Skill candidates          — generated automatically
Level 4: Active behavior           — requires passing evaluation
Level 5: Brain kernel / SOUL / policy — never autonomously rewritten
```

**Gate accumulator fix:** `gateAccum` (the episode builder) is reset in `session_start`, not carried across sessions. An episode can only span observations within a single session.

### 4.8 Procedures (`procedures.ts`)

Procedural knowledge: "when X happens, doing Y is more effective than Z."

Separate from semantic memory. Requires observational evidence.

**Lifecycle:**

```
First observation (1 success or failure)
    → status: tentative, confidence: 0.5

Reinforced by independent experience
    → status: reinforced, confidence increases

Meets maturity thresholds
    → status: mature, eligible for skill candidacy

Contradicted by evidence
    → status: contradicted, confidence decreases
    → if contradictions > reinforcements: retired

Procedure becomes active skill
    → keeps accumulating evidence
    → skill may be rolled back if procedure regresses
```

**Evidence tracking:**

Every observation that matches a procedure's trigger/avoid/prefer pattern is linked via `procedure_evidence`. The procedure's `success_count`, `failure_count`, and `confidence` are updated accordingly.

**Procedure key:** A deterministic key derived from the trigger + avoid + prefer triple, normalized. Used for deduplication — a second experience producing the same procedural pattern reinforces the existing procedure rather than creating a duplicate.

### 4.9 Recovery (`recovery.ts`)

Deterministic + reflective recovery linking.

**Deterministic rules** (per tool):

For native Pi tools, target extraction is deterministic (see §4.4). When a success observation shares a target key with a prior error observation in the same run, recovery is linked automatically.

**Canonical target normalization:**

```
/home/user/project/./src/../src/foo.ts  →  /home/user/project/src/foo.ts
~/project/foo.ts                        →  /home/user/project/foo.ts
./foo.ts (with cwd=/project)            →  /project/foo.ts
```

**Reflective fallback:**

For bash commands with ambiguous targets, or when multiple failures could be the source, a cognition worker is asked to identify the most likely recovery relationship. This runs only when deterministic linking fails and the learner's pass 2 is already active (no extra LLM call just for recovery).

### 4.10 Consolidate (`consolidate.ts`)

Evolved from Waywiser's existing `mem-dream.ts`. Operates over the full Brain state.

**Operations (in order):**

1. **Deterministic cleanup** (no LLM):
   - Remove memories superseded by newer versions
   - Archive memories not accessed in 90+ days (configurable)
   - Merge procedure evidence pointing to the same pattern
   - Retire procedures with `failure_count > success_count * 2` and age > 7 days

2. **Near-duplicate detection** (LLM via cognition pool):
   - Cluster memories by FTS5 similarity
   - For each cluster, ask a cognition worker: "Are these saying the same thing? If so, which is more precise?"
   - Merge or supersede as recommended

3. **Contradiction detection** (LLM):
   - Find memory pairs where both are active and high-confidence
   - Ask cognition worker to identify genuine contradictions
   - Propose resolution (don't apply automatically — log as pending contradiction)

4. **Procedure promotion check**:
   - Find procedures meeting maturity thresholds
   - Flag as ready for skill candidacy (consumed by evolve module)

**Timing:** Runs on `session_shutdown` (if configured) and on explicit `/brain consolidate` command. Never mid-session.

**Report:** Every consolidation run produces a human-readable report stored in `brain_log` and optionally written to `markdownRoot/consolidation-reports/`.

### 4.11 Skills (`skills.ts`)

Skill lifecycle management with Pi-native discovery.

**Directory structure:**

```
{skillsRoot}/
├── active/
│   └── {name}/
│       ├── SKILL.md
│       └── metadata.json
├── candidates/
│   └── {name}/
│       └── {version-hash}/
│           ├── SKILL.md
│           └── metadata.json
└── retired/
    └── {name}/
        └── {version-hash}/
            ├── SKILL.md
            └── metadata.json
```

**Pi-native discovery:**

```typescript
pi.on("resources_discover", () => ({
  skillPaths: [path.join(config.skillsRoot, "active")],
}));
```

Only `active/` skills become native Pi behavior. Candidates are invisible to the working agent. This is the evolutionary membrane.

**metadata.json:**

```json
{
  "versionHash": "sha256:abc123...",
  "parentVersion": "sha256:def456...",
  "sourceProcedureIds": ["proc_large-file-read", "proc_json-parse-safe"],
  "evalRunId": "eval_019...",
  "promotedAt": "2026-08-21T10:00:00Z",
  "createdAt": "2026-08-20T15:30:00Z"
}
```

**Compatibility facade:** Waywiser's `skill_manage` tool gains new internal routing:

| Caller | Action | Destination |
|--------|--------|-------------|
| Model-initiated | create | `candidates/` |
| Model-initiated | update | `candidates/` (new version) |
| Model-initiated | delete | rejected (log warning) |
| User `/skill create` | create | `active/` (bypass evaluation) |
| User `/skill delete` | delete | `retired/` (moved, not deleted) |

### 4.12 Evolve (`evolve.ts`)

Evolution pipeline: mature procedure → candidate skill → evaluation → promotion.

**Pipeline:**

```
Procedure meets maturity thresholds
    ↓
Skill compilation (cognition worker)
    ↓
candidate SKILL.md + metadata.json
    written to candidates/{name}/{version-hash}/
    ↓
Static validation
    - SKILL.md parseable
    - No forbidden directives (no kernel modification instructions)
    - Reasonable size (< 10KB)
    ↓
Evaluation (eval module)
    ↓
Promotion decision (per config.evolution.promotionPolicy):
    - "auto": promote if evaluation passes
    - "confirm": prompt user at next session start
    - "manual": log as ready, wait for explicit command
    ↓
Promotion (at session boundary):
    candidate → active (atomic move/copy)
    old active → retired
    ↓
Takes effect: next session start or explicit /reload
```

**Maturity thresholds** (from config, defaults):

```
>= 3 positive observations
>= 2 independent settled experiences
success ratio >= 0.75
no unresolved contradiction
reusable beyond one exact task (heuristic: trigger text doesn't contain session-specific IDs)
```

**Version lineage:**

Every skill version tracks its parent. This enables:
- Rollback to any previous version
- Branch visualization (v1 → v2 → v4, v1 → v3)
- Regression detection (v4 performs worse than v3 → rollback to v3)

### 4.13 Eval (`eval.ts`)

Competitive evaluation: baseline vs candidate.

**Eval case sources:**

1. **Historical replay cases** — derived from the experiences that created the procedure. The experience's objective and key observations become a test prompt.
2. **Synthetic variations** — cognition worker generates variations of the replay cases (different file names, slightly different scenarios).
3. **Regression cases** — every failed promotion attempt contributes a permanent regression case for that skill.

**Evaluation execution:**

Uses the existing `utils/rpc.ts` pool infrastructure. For each eval case:

```
BASELINE: Pi + active/ skills (current behavior)
CANDIDATE: Pi + candidates/{name}/{version-hash}/ as skill

Same: model, provider, thinking level, tool permissions
```

Each run captures:
- Assistant messages
- Tool calls and results
- Errors
- Usage/tokens
- Turn count
- Latency

**Scoring (deterministic first, then qualitative):**

1. **Hard oracle checks** (deterministic):
   - Task completed? (exit status, required output present)
   - Tool errors? (count and severity)
   - Required files produced?
   - Forbidden files untouched?
   - Regression cases pass?

2. **Qualitative judge** (cognition worker, only if hard checks pass for both):
   - Correctness comparison
   - Efficiency comparison (fewer tool calls = better)
   - Output quality

**Verdict:** Candidate must be **strictly better or equal** on all hard checks and at least neutral on qualitative. A single regression case failure blocks promotion.

### 4.14 Vault (`vault.ts`)

Markdown projection + Obsidian-compatible sync. No filesystem watcher.

**Projection structure** (within `markdownRoot`):

```
{markdownRoot}/
├── semantic/
│   ├── fact-postgresql-project-alpha.md
│   ├── preference-dark-mode.md
│   └── ...
├── procedures/
│   ├── large-file-read.md
│   ├── json-parse-safe.md
│   └── ...
├── projects/
│   ├── waywiser.md
│   └── ...
├── entities/
│   └── ...
├── hypotheses/
│   └── ...
├── archive/
│   └── ...
├── skills/
│   ├── active/
│   │   └── ...
│   └── candidates/
│       └── ...
└── consolidation-reports/
    └── 2026-08-21.md
```

**Markdown format:**

```markdown
---
id: mem_928
kind: decision
scope: project:waywiser
confidence: 0.91
status: active
revision: 7
evidence:
  - exp_83
  - exp_91
created: 2026-08-15T10:30:00Z
accessed: 2026-08-21T09:00:00Z
---

The project uses PostgreSQL 15 with pgvector for embeddings.

## Evidence Chain

- Experience exp_83 (2026-08-15): User stated during database setup
- Experience exp_91 (2026-08-18): Confirmed in docker-compose review
```

**Sync protocol:**

| Timing | Direction | Action |
|--------|-----------|--------|
| `session_start` | Vault → DB | Detect human edits (hash comparison). Import as user-authoritative. |
| `session_shutdown` | DB → Vault | Write all changed memories/procedures to markdown. |
| `/brain sync` | Both | Full bidirectional sync. |

**Conflict resolution** (when human edits conflict with agent learning):

| Policy | Behavior |
|--------|----------|
| `human-wins` | Human edit overwrites. Agent change logged as superseded. |
| `merge` | If edits are to different fields (e.g., human changed content, agent changed confidence), merge. If both changed content, human wins. |
| `prompt` | Log conflict, present to user at next `/brain status`. |

**Obsidian compatibility:**
- All files are standard Markdown with YAML frontmatter
- Obsidian can open `markdownRoot` directly as a vault
- No Obsidian plugins required
- Wikilinks (`[[procedure-name]]`) used for cross-references
- Brain works perfectly with Obsidian closed

### 4.15 Policy (`policy.ts`)

Configurable rules for promotion, learning, scope inference. Never autonomously rewritten.

**Scope inference rules:**

```
User message contains project-specific terms (detected via git repo name, package.json name)
    → scope: project

User message contains "always", "everywhere", "in general"
    → scope: global

User message is about current working directory specifically
    → scope: project

Default: config.scoping.defaultScope (default: "infer" → conservative project)
```

**Promotion policy:**

```
Candidate passes all eval cases
AND success ratio >= config.evolution.maturity.minSuccessRatio
AND no active contradiction on source procedures
AND candidate SKILL.md passes static validation
    → eligible for promotion (per config.evolution.promotionPolicy)
```

**Safety boundaries (hardcoded, not configurable):**

- Brain kernel files cannot be modified by the agent
- SOUL constitutional rules cannot be modified by the agent
- Evaluation policy cannot be modified by the agent
- Provenance classification cannot be overridden by LLM output
- Active skills cannot be hot-swapped mid-session

### 4.16 Cognition (`cognition.ts`)

Warm RPC pool for meta-workers (learner, consolidation, skill compilation, evaluation judging).

Built on the existing `utils/rpc.ts` infrastructure. Each lane gets dedicated workers:

| Lane | Purpose | Pi flags |
|------|---------|----------|
| `learn` | Gate reflection, memory extraction | `--no-extensions --no-skills --no-context-files` |
| `consolidate` | Near-duplicate detection, contradiction | `--no-extensions --no-skills --no-context-files` |
| `compile-skill` | Procedure → SKILL.md generation | `--no-extensions --no-skills --no-context-files` |
| `judge` | Qualitative eval comparison | `--no-extensions --no-skills --no-context-files` |

**Key properties:**
- Workers get `freshSession=true` before reuse (no context leaks)
- Workers have NO Waywiser extensions loaded (the learner is not a fully equipped Waywiser)
- Model and thinking level configurable via `config.cognition`
- Pool size configurable (default 2 idle per lane)

### 4.17 Prompts (`prompts.ts`)

All LLM prompts in one file. Each prompt is a function that takes structured input and returns a system+user prompt pair.

**Key prompts:**

1. `gatePrompt(experience: Experience)` — for reflective extraction (pass 2 of learner)
2. `consolidatePrompt(cluster: BrainMemory[])` — for near-duplicate detection
3. `contradictionPrompt(memA: BrainMemory, memB: BrainMemory)` — for contradiction detection
4. `compileSkillPrompt(procedure: Procedure, evidence: ProcedureEvidence[])` — for SKILL.md generation
5. `judgePrompt(baseline: EvalResult, candidate: EvalResult)` — for qualitative eval comparison
6. `recoverySuggestionPrompt(ambiguousObservations: Observation[])` — for reflective recovery linking

---

## 5. Pi Event Lifecycle

The exact lifecycle implementation:

```typescript
export default function brain(pi: ExtensionAPI) {
  const config = loadBrainConfig();
  const store = openBrainStore(config);
  const trace = new ExperienceTrace(config);
  const cognitionPool = createCognitionPool(config);

  let sessionReflectionCount = 0;
  let gateAccum: string[] = [];

  // ── Skill discovery ─────────────────────────────────────────
  if (config.modules.skills) {
    pi.on("resources_discover", async () => ({
      skillPaths: [path.join(config.skillsRoot, "active")],
    }));
  }

  // ── Session start ───────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    reloadBrainConfig();  // pick up config changes
    sessionReflectionCount = 0;
    gateAccum = [];  // FIX: reset across sessions
    trace.resetSession(ctx.sessionManager);

    if (config.modules.vault && config.vault.syncOnStart) {
      await vaultSyncInbound(store, config);
    }

    store.beginSession(ctx.sessionManager.getSessionId?.() ?? "unknown");
  });

  // ── Before agent start (recall injection) ───────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (config.recall.mode === "off") return;  // FIX: truly off

    const recalled = await recall({
      prompt: event.prompt,
      cwd: ctx.cwd,
      branch: ctx.sessionManager.getBranch(),  // FIX: branch-aware
      activeGoals: loadGoals(store),
      config: config.recall,
      store,
    });

    trace.noteRecall(recalled);

    if (!recalled.items.length) return;

    if (config.recall.useCustomMessage) {
      return {
        message: {
          customType: "waywiser/brain-context",
          content: renderBrainContext(recalled),
          display: false,
          details: {
            memoryIds: recalled.memoryIds,
            procedureIds: recalled.procedureIds,
            brainRevision: recalled.revision,
          },
        },
      };
    } else {
      return { systemPrompt: event.systemPrompt + renderBrainContext(recalled) };
    }
  });

  // ── Event observation ───────────────────────────────────────
  if (config.modules.trace) {
    pi.on("agent_start", () => {
      trace.beginRun();
    });

    pi.on("tool_call", (event) => {
      trace.toolCall(event);
    });

    pi.on("tool_result", (event) => {
      trace.toolResult(event);
    });

    pi.on("turn_end", (event) => {
      trace.turnEnd(event);
    });
  }

  // ── Learning boundary ───────────────────────────────────────
  const learnBoundary = config.learning.boundary;  // default: agent_settled

  pi.on(learnBoundary, async (_event, ctx) => {
    if (!config.modules.learner) return;
    if (sessionReflectionCount >= config.learning.maxReflectionsPerSession) return;

    const experience = await trace.finalize({
      sessionManager: ctx.sessionManager,
      cwd: ctx.cwd,
    });

    // Persist provenance anchor as Pi custom entry
    pi.appendEntry("waywiser/experience", {
      experienceId: experience.id,
      outcome: experience.outcome,
      observationCount: experience.observations.length,
      memoryIdsRecalled: experience.recalledMemoryIds,
    });

    // Persist experience in Brain DB
    await store.recordExperience(experience);

    // Two-pass learning
    const pass1 = deterministicExtract(experience, config);

    if (pass1.hasDurableSignals) {
      sessionReflectionCount++;

      const candidates = await reflectiveExtract(
        experience,
        pass1,
        cognitionPool,
        config,
      );

      // Validate and store
      const validated = validateCandidates(candidates, experience, config);
      await store.storeLearningResults(validated);

      // Update procedure evidence
      if (config.modules.procedures) {
        await updateProcedureEvidence(experience, validated, store);
      }

      // Record memory usage (which recalled memories were useful?)
      await recordMemoryUsage(experience, store);

      // Check for evolution triggers
      if (config.modules.evolve) {
        await checkEvolutionTriggers(store, config);
      }

      // Episode accumulation
      gateAccum.push(...validated.memories.map(m => m.content));
      if (gateAccum.length >= 5) {
        await store.appendEpisode(experience.sessionId, gateAccum.join("\n---\n"));
        gateAccum = [];
      }
    }
  });

  // ── Session shutdown ────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (config.modules.consolidate && config.consolidation.runOnShutdown) {
      await consolidate(store, cognitionPool, config);
    }

    if (config.modules.vault && config.vault.syncOnShutdown) {
      await vaultSyncOutbound(store, config);
    }

    cognitionPool.shutdown();
  });

  // ── Tool registrations ──────────────────────────────────────
  registerBrainTools(pi, store, config, cognitionPool);
}
```

---

## 6. SOUL Changes

### 6.1 Narrow SOUL Mode (default: enabled)

When `config.soul.narrowMode` is true:

**SOUL contains only:**
- Identity (who is Waywiser)
- Constitutional principles (ethical boundaries)
- Non-negotiable policy (safety rules)
- Explicit user-authorized durable identity changes

**SOUL does NOT contain:**
- Preferences (→ Brain memories with `type: "preference"`)
- Lessons (→ Brain memories with `type: "lesson"` or procedures)
- Project knowledge (→ Brain memories with `scope: "project"`)

### 6.2 Session Snapshot (default: enabled)

When `config.soul.snapshotAtStart` is true:
- SOUL.md is read once at `session_start` and cached
- The `soul` tool's `append_preference` and `append_lesson` actions are redirected to Brain memory creation
- SOUL changes from `append_identity` or `append_principle` take effect in the **next session**, not mid-session
- This preserves prompt-cache stability

### 6.3 Backward Compatibility

When both narrow mode and snapshot are disabled, SOUL behaves exactly as current Waywiser — mutable mid-session, stores preferences and lessons.

---

## 7. Bug Fixes

All seven bugs identified in the review, fixed as part of Brain's implementation:

| # | Bug | Fix | Module |
|---|-----|-----|--------|
| 1 | `recall=off` still injects static digest | `if (mode === "off") return;` before any recall logic | `recall.ts` |
| 2 | ASCII tokenizer `[a-z0-9_]` cripples non-Latin recall | FTS5 recreated with `tokenize='unicode61'` | `store.ts` migration |
| 3 | Automatic recall doesn't update `access_count` | All recall paths bump access_count | `recall.ts` |
| 4 | `gateAccum` survives session replacement | Reset in `session_start` handler | `index.ts` |
| 5 | `WAYWISER_VERSION` mismatch (0.1.0 vs 1.0.0) | Centralized version from `package.json` | `config.ts` |
| 6 | `/waywiser status` reads legacy `kanban.json` | Read from SQLite `boards`/`cards` tables | Waywiser's `commands.ts` |
| 7 | Peer dependency `>=0.80.0` too permissive | Floor raised to `>=0.84.2` | Both `package.json` files |

---

## 8. Tool & Command Surface

### 8.1 Existing Tools (compatibility facades)

**`memory`** — unchanged external API, internal routing changed:

| Action | Current behavior | Brain behavior |
|--------|-----------------|----------------|
| `remember` | Direct insert, `source: "user"` always | Source determined by call context (user command vs model call) |
| `recall` | FTS5 search | Reciprocal rank fusion |
| `search` | FTS5 search | Same, now unicode-aware |
| `recent` | Last N memories | Same |
| `forget` | Delete | Archive (moved to `status: "archived"`) |
| `settings` | Read/write mem.json | Delegates to brain config |

**`skill_manage`** — internal routing changed:

| Caller | create | update | delete |
|--------|--------|--------|--------|
| Model | → `candidates/` | → `candidates/` (new version) | Rejected with warning |
| User | → `active/` (bypass eval) | → `active/` (bypass eval) | → `retired/` |

### 8.2 New Tool: `evolve`

Single new user-facing tool for the evolution system:

```typescript
pi.registerTool({
  name: "evolve",
  description: "Inspect and manage Brain's self-evolution system",
  schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "candidates", "inspect", "history", "policy"],
        description: "Read-only operations on the evolution system"
      },
      target: { type: "string", description: "Skill name or version ID for inspect" },
    },
    required: ["action"],
  },
  handler: async (params) => { ... },
});
```

**Mutating operations (promote/reject/rollback/evaluate) are slash commands only**, not model-callable:

- `/brain evolve promote <skill>` — manually promote a candidate
- `/brain evolve reject <skill>` — reject a candidate
- `/brain evolve rollback <skill>` — roll back to previous version
- `/brain evolve evaluate <skill>` — trigger evaluation manually

### 8.3 New Commands

All under `/brain` namespace (registered via `pi.registerCommand`):

| Command | Description |
|---------|-------------|
| `/brain status` | Full observability dashboard |
| `/brain sync` | Manual vault sync |
| `/brain consolidate` | Trigger consolidation |
| `/brain evolve status` | Evolution status |
| `/brain evolve promote <skill>` | Manual promote |
| `/brain evolve reject <skill>` | Manual reject |
| `/brain evolve rollback <skill>` | Rollback to previous |
| `/brain evolve evaluate <skill>` | Trigger evaluation |
| `/brain experience <id>` | Inspect an experience |
| `/brain procedure <key>` | Inspect a procedure |
| `/brain memory <id>` | Inspect a memory with full evidence chain |
| `/brain config` | Show/edit brain config |

### 8.4 Extended `/waywiser status`

The existing status command gains Brain sections:

```
Brain
  Memories: 142 active, 7 frozen, 23 archived
  Procedures: 8 tentative, 3 reinforced, 2 mature
  Last experience: exp_019... (12 min ago, success)
  Last learning: 2 memories created, 1 procedure reinforced
  Pending contradictions: 1

Evolution
  Active learned skills: 3 (file-read-strategy, error-recovery, test-structure)
  Candidate skills: 1 (json-parse-safe, awaiting evaluation)
  Last eval: eval_019... (passed, promoted file-read-strategy v3)
  Rejected versions: 2
  Current generation: 4

Vault
  Location: ~/MyVault/Brain/
  Last sync: 2026-08-21T09:15:00Z
  Pending human edits: 0
  Files: 178

Cognition
  Pool: 2 idle workers (learn, consolidate)
  Session reflections: 3/10
```

---

## 9. Test Strategy

### 9.1 Unit Tests (pure logic, no LLM)

| Test file | Coverage |
|-----------|----------|
| `trace.test.ts` | Target key extraction, recovery linking, branch isolation |
| `provenance.test.ts` | Deterministic classification for every event type, privilege escalation prevention |
| `recall.test.ts` | Reciprocal rank fusion scoring, unicode tokenization, recall=off truly off, access_count bumps |
| `learner.test.ts` | Deterministic extraction patterns, authority hierarchy enforcement |
| `procedures.test.ts` | Evidence accumulation, maturity threshold, contradiction handling |
| `recovery.test.ts` | Deterministic recovery for all tool types, target normalization |
| `skills.test.ts` | Directory lifecycle (candidate→active→retired), resources_discover output |
| `evolve.test.ts` | Maturity check, version lineage, rollback |
| `policy.test.ts` | Scope inference, promotion rules, safety boundaries |
| `vault.test.ts` | Markdown generation/parsing, sync direction, conflict resolution |
| `store.test.ts` | Schema migration idempotency, CRUD operations, FTS unicode |

### 9.2 Integration Tests

| Test | What it verifies |
|------|-----------------|
| `brain.test.ts` | Full lifecycle: session_start → tool events → agent_settled → learning → shutdown |
| Settled-run learning | Learning fires only at agent_settled, not turn_end |
| Branch isolation | Observations from different branches don't cross-contaminate |
| SOUL session snapshot | SOUL changes mid-session don't affect current session |
| Custom entry provenance | `waywiser/experience` entries round-trip through session reload |
| Unicode recall | Romanian/Russian text recalled correctly |

### 9.3 Smoke Tests

```typescript
// All extensions load without error
// All tools register successfully
// Brain + Waywiser coexist without name collisions
// Config validates and applies defaults correctly
// Database migrations are idempotent
```

### 9.4 Model-Backed Evaluation Tests (separate from unit tests)

These test **behavior**, not mechanisms:

- Does the learner extract the right memories from a sample experience?
- Does the skill compiler produce a valid SKILL.md from a mature procedure?
- Does the qualitative judge correctly identify the better of two eval runs?

Run separately, with cost tracking, not on every commit.

---

## 10. Waywiser Compatibility

### 10.1 Preserved APIs

All existing Waywiser user-facing tools and commands continue to work:

- `memory` tool (remember, recall, search, recent, forget, settings)
- `skill_manage` tool (create, update, delete, list)
- `/memory` commands
- `/waywiser status`

### 10.2 Migration Path

On first Brain load with an existing Waywiser database:

1. Brain adds its tables (idempotent `CREATE TABLE IF NOT EXISTS`)
2. Brain adds columns to `memories` (idempotent `ALTER TABLE`)
3. Brain rebuilds FTS with unicode61 tokenizer
4. Existing memories are assigned `scope: "global"`, `status: "active"`
5. Existing episodes are preserved in `episodes` table
6. No data is deleted or moved

### 10.3 Rollback

If Brain is removed, Waywiser continues to work with the original tables. Brain's additional tables and columns are inert — Waywiser's code doesn't reference them.

---

## 11. Implementation Sequence

**Not phased. All modules built together, tested together, shipped together.**

Implementation order (dependency-driven, not phased):

1. `types.ts` + `config.ts` — foundation types and configuration
2. `store.ts` — database schema, migrations, CRUD
3. `provenance.ts` — deterministic classification (pure functions)
4. `trace.ts` — event collection and experience finalization
5. `recovery.ts` — deterministic + reflective recovery linking
6. `prompts.ts` — all LLM prompt templates
7. `cognition.ts` — warm RPC pool (extends existing rpc.ts)
8. `recall.ts` — reciprocal rank fusion retrieval
9. `learner.ts` — two-pass learning pipeline
10. `procedures.ts` — procedural memory with evidence
11. `consolidate.ts` — evolved mem-dream
12. `skills.ts` — candidate/active/retired lifecycle
13. `eval.ts` — competitive evaluation
14. `evolve.ts` — evolution pipeline
15. `vault.ts` — markdown projection + sync
16. `policy.ts` — configurable rules
17. `index.ts` — root extension, Pi event lifecycle, tool registration
18. Bug fixes in Waywiser's existing code
19. Compatibility facades in Waywiser's `memory.ts` and `skills-manage.ts`
20. Tests (unit + integration + smoke)

---

## 12. Success Criteria

Brain is complete when:

1. **Learning is evidence-based:** Every memory has traceable provenance to a Pi event. No LLM-chosen authority.
2. **Learning happens at the right boundary:** `agent_settled`, not `turn_end`.
3. **Recall is useful:** Unicode-aware, rank-fused, usage-tracked, truly off when off.
4. **Procedures accumulate evidence:** Tool failures and recoveries produce procedural knowledge automatically.
5. **Skills evolve:** Mature procedures become candidate skills, evaluated competitively, promoted at session boundaries.
6. **Everything is observable:** `/brain status` shows the full system state. Evidence chains are traceable.
7. **Human cortex works:** Obsidian can open the brain directory. Human edits are imported. No runtime dependency.
8. **Existing users unaffected:** All Waywiser tools and commands work unchanged.
9. **All 7 bugs are fixed.**
10. **No new middleware, no new daemons, no new databases.** Pi-native only.
