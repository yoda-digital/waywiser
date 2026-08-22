/**
 * waywiser-brain — shared types.
 *
 * Every type used across the brain package's modules (trace, learner,
 * procedures, recovery, consolidate, skills, evolve, eval, vault, cognition)
 * lives here so those modules share one vocabulary instead of redeclaring
 * shapes. This file has no runtime code and no imports — it is erased
 * entirely at build/run time (types only).
 */

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type ProvenanceSource = "user" | "agent" | "external" | "environment" | "existing-memory";

export interface ProvenanceRecord {
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

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export interface Observation {
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

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

export interface ExperienceOutcome {
  status: "success" | "failure" | "partial" | "unknown";
  confidence: "verified" | "inferred" | "unknown";
  summary: string;
}

export interface Experience {
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
  externalSources: string[];
  startedAt: string;
  settledAt: string;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryType = "fact" | "preference" | "decision" | "lesson";
export type MemoryScope = "global" | "project" | "session";
export type MemoryStatus = "active" | "frozen" | "archived" | "superseded";

export interface BrainMemory {
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

// ---------------------------------------------------------------------------
// Procedure
// ---------------------------------------------------------------------------

export type ProcedureStatus = "tentative" | "reinforced" | "mature" | "contradicted" | "retired";

export interface Procedure {
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

// ---------------------------------------------------------------------------
// Skill Versions
// ---------------------------------------------------------------------------

export type SkillStatus = "candidate" | "evaluating" | "active" | "retired" | "rejected";

export interface SkillVersion {
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

// ---------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------

export type EvolutionStatus = "pending" | "running" | "passed" | "failed" | "cancelled";

export interface EvolutionRun {
  id: string;
  skillVersionId: string;
  baselineVersionId: string | null;
  status: EvolutionStatus;
  resultJson: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

export interface RecallResult {
  items: RecallItem[];
  memoryIds: number[];
  procedureIds: string[];
  revision: number;
}

export interface RecallItem {
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
    semantic?: number;
  };
}

// ---------------------------------------------------------------------------
// Learning Pipeline
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// BrainConfig
// ---------------------------------------------------------------------------

export interface BrainConfig {
  markdownRoot: string;
  dbPath: string;
  skillsRoot: string;
  experienceRoot: string | null;

  modules: {
    trace: boolean;
    learner: boolean;
    procedures: boolean;
    recovery: boolean;
    consolidate: boolean;
    skills: boolean;
    evolve: boolean;
    eval: boolean;
    vault: boolean;
    cognition: boolean;
  };

  learning: {
    boundary: "agent_settled" | "turn_end";
    maxReflectionsPerSession: number;
    maxMemoriesPerRun: number;
    gateTimeoutMs: number;
    minObservationsForReflection: number;
  };

  recall: {
    mode: "selective" | "top8" | "off";
    maxItems: number;
    maxChars: number;
    fusionWeights: {
      lexical: number;
      scope: number;
      usage: number;
      confidence: number;
      recency: number;
    };
    useCustomMessage: boolean;
  };

  provenance: {
    externalConfidence: number;
    userConfidence: number;
    agentConfidence: number;
    environmentConfidence: number;
  };

  scoping: {
    defaultScope: "global" | "project" | "infer";
    projectDetection: "git-root" | "cwd" | "package-json" | "explicit";
    scopeBoost: number;
  };

  evolution: {
    maturity: {
      minPositiveObservations: number;
      minIndependentExperiences: number;
      minSuccessRatio: number;
      requireNoContradictions: boolean;
    };
    evalCasesPerCandidate: number;
    promotionPolicy: "auto" | "manual" | "confirm";
    promotionBoundary: "next-session" | "reload" | "immediate";
  };

  vault: {
    syncOnStart: boolean;
    syncOnShutdown: boolean;
    conflictResolution: "human-wins" | "merge" | "prompt";
    structure: {
      semantic: string;
      procedures: string;
      projects: string;
      entities: string;
      hypotheses: string;
      archive: string;
      skills: string;
    };
  };

  cognition: {
    poolSize: number;
    model: string | null;
    thinkingLevel: string | null;
    idleTtlMs: number;
  };

  soul: {
    narrowMode: boolean;
    snapshotAtStart: boolean;
  };

  consolidation: {
    batchSize: number;
    runOnShutdown: boolean;
    dryRunByDefault: boolean;
  };

  embeddings?: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    similarityThreshold: number;
    weight: number;
  };
}

// ---------------------------------------------------------------------------
// Eval types
// ---------------------------------------------------------------------------

export interface EvalCase {
  id: string;
  skillName: string;
  prompt: string;
  oracleJson: string | null;
  safetyClass: string;
  sourceExperienceId: string | null;
  createdAt: string;
}

export interface EvalVerdict {
  pass: boolean;
  hardCheckResults: Array<{ check: string; passed: boolean; detail: string }>;
  qualitativeResult?: string;
  details: string;
}

export interface VaultSyncRow {
  filePath: string;
  contentHash: string;
  memoryId: number | null;
  procedureId: string | null;
  lastSynced: string;
}

export interface ConsolidationReport {
  supersededRemoved: number;
  staleArchived: number;
  nearDuplicatesMerged: number;
  contradictionsFound: number;
  proceduresRetired: number;
  proceduresFlaggedMature: number;
  report: string;
}
