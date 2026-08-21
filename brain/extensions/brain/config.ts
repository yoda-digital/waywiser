/**
 * waywiser-brain — configuration.
 *
 * Loads, validates, and caches the BrainConfig. Config sources are layered
 * lowest to highest priority:
 *
 *   1. DEFAULT_BRAIN_CONFIG (built-in defaults, spec §3.2)
 *   2. JSON config file (BRAIN_CONFIG env var, or an explicit path, or
 *      ~/.waywiser/brain.json) — deep-merged over the defaults
 *   3. Programmatic `overrides` passed to loadBrainConfig() — deep-merged
 *      over the file-merged config (mainly for tests and callers that need
 *      to inject config without touching disk)
 *   4. BRAIN_MARKDOWN_ROOT / BRAIN_DB_PATH / BRAIN_SKILLS_ROOT env vars —
 *      always win, applied last
 *
 * The result is then validated (numeric fields clamped to sane ranges,
 * module dependency rules enforced) before being cached or returned.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrainConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const here = path.dirname(new URL(import.meta.url).pathname);
const PKG = JSON.parse(fs.readFileSync(path.resolve(here, "../../package.json"), "utf-8"));

export const BRAIN_VERSION: string = PKG.version;

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merges `patch` over `base`: plain objects are merged key by
 * key (recursively); arrays and primitives in `patch` fully overwrite the
 * corresponding value in `base`. Returns a new object — neither input is
 * mutated, so this is safe to use against frozen defaults.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch as T;
  }
  const result: PlainObject = { ...(base as PlainObject) };
  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = (base as PlainObject)[key];
    result[key] = isPlainObject(baseValue) && isPlainObject(patchValue) ? deepMerge(baseValue, patchValue) : patchValue;
  }
  return result as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  Object.freeze(value);
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
    }
  }
  return value as Readonly<T>;
}

// ---------------------------------------------------------------------------
// Defaults (spec §3.2)
// ---------------------------------------------------------------------------

const HOME = os.homedir();

export const DEFAULT_BRAIN_CONFIG: Readonly<BrainConfig> = deepFreeze({
  markdownRoot: path.join(HOME, ".waywiser", "brain"),
  dbPath: path.join(HOME, ".waywiser", "waywiser.db"),
  skillsRoot: path.join(HOME, ".waywiser", "skills"),
  experienceRoot: null,

  modules: {
    trace: true,
    learner: true,
    procedures: true,
    recovery: true,
    consolidate: true,
    skills: true,
    evolve: true,
    eval: true,
    vault: true,
    cognition: true,
  },

  learning: {
    boundary: "agent_settled",
    maxReflectionsPerSession: 10,
    maxMemoriesPerRun: 3,
    gateTimeoutMs: 12000,
    minObservationsForReflection: 1,
  },

  recall: {
    mode: "selective",
    maxItems: 8,
    maxChars: 2000,
    fusionWeights: {
      lexical: 1.0,
      scope: 0.8,
      usage: 0.5,
      confidence: 0.3,
      recency: 0.2,
    },
    useCustomMessage: true,
  },

  provenance: {
    externalConfidence: 0.3,
    userConfidence: 0.9,
    agentConfidence: 0.7,
    environmentConfidence: 0.6,
  },

  scoping: {
    defaultScope: "infer",
    projectDetection: "git-root",
    scopeBoost: 2.0,
  },

  evolution: {
    maturity: {
      minPositiveObservations: 3,
      minIndependentExperiences: 2,
      minSuccessRatio: 0.75,
      requireNoContradictions: true,
    },
    evalCasesPerCandidate: 5,
    promotionPolicy: "auto",
    promotionBoundary: "next-session",
  },

  vault: {
    syncOnStart: true,
    syncOnShutdown: true,
    conflictResolution: "human-wins",
    structure: {
      semantic: "semantic",
      procedures: "procedures",
      projects: "projects",
      entities: "entities",
      hypotheses: "hypotheses",
      archive: "archive",
      skills: "skills",
    },
  },

  cognition: {
    poolSize: 2,
    model: null,
    thinkingLevel: null,
    idleTtlMs: 600000,
  },

  soul: {
    narrowMode: true,
    snapshotAtStart: true,
  },

  consolidation: {
    batchSize: 50,
    runOnShutdown: true,
    dryRunByDefault: false,
  },
} satisfies BrainConfig);

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

function resolveConfigPath(configPath?: string): string {
  return configPath ?? process.env.BRAIN_CONFIG ?? path.join(HOME, ".waywiser", "brain.json");
}

/** Reads the config file. Missing file is not an error — returns {}. */
function readConfigFile(configPath?: string): Record<string, unknown> {
  const file = resolveConfigPath(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return {}; // ENOENT / permission — expected when no config file exists yet
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    process.stderr.write(`waywiser-brain: ${file} contains invalid JSON, using defaults: ${e instanceof Error ? e.message : String(e)}\n`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Env var overrides (highest priority)
// ---------------------------------------------------------------------------

function applyEnvOverrides(cfg: BrainConfig): BrainConfig {
  const out: BrainConfig = { ...cfg };
  if (process.env.BRAIN_MARKDOWN_ROOT) out.markdownRoot = process.env.BRAIN_MARKDOWN_ROOT;
  if (process.env.BRAIN_DB_PATH) out.dbPath = process.env.BRAIN_DB_PATH;
  if (process.env.BRAIN_SKILLS_ROOT) out.skillsRoot = process.env.BRAIN_SKILLS_ROOT;
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Expand leading `~/` or `~\` to the user's home directory. */
function expandTilde(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

function validateConfig(cfg: BrainConfig): BrainConfig {
  const out: BrainConfig = { ...cfg };

  // Expand ~ in all path fields
  out.markdownRoot = expandTilde(out.markdownRoot);
  out.dbPath = expandTilde(out.dbPath);
  out.skillsRoot = expandTilde(out.skillsRoot);
  if (out.experienceRoot) out.experienceRoot = expandTilde(out.experienceRoot);

  out.provenance = {
    ...out.provenance,
    externalConfidence: clamp(out.provenance.externalConfidence, 0, 1),
    userConfidence: clamp(out.provenance.userConfidence, 0, 1),
    agentConfidence: clamp(out.provenance.agentConfidence, 0, 1),
    environmentConfidence: clamp(out.provenance.environmentConfidence, 0, 1),
  };

  out.learning = {
    ...out.learning,
    gateTimeoutMs: clamp(out.learning.gateTimeoutMs, 1000, 30000),
  };

  out.cognition = {
    ...out.cognition,
    poolSize: clamp(out.cognition.poolSize, 0, 8),
  };

  out.scoping = {
    ...out.scoping,
    scopeBoost: clamp(out.scoping.scopeBoost, 0, 10),
  };

  out.modules = { ...out.modules };
  if (out.modules.evolve && !out.modules.eval) out.modules.evolve = false;
  if (out.modules.evolve && !out.modules.skills) out.modules.evolve = false;

  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads a BrainConfig from defaults + config file + overrides + env vars,
 * then validates it. This is a pure function — it never touches the
 * module-level cache; use `brainConfig()` / `reloadBrainConfig()` for that.
 */
export function loadBrainConfig(configPath?: string, overrides?: Record<string, unknown>): BrainConfig {
  const fileConfig = readConfigFile(configPath);
  let cfg = deepMerge(DEFAULT_BRAIN_CONFIG, fileConfig) as BrainConfig;
  if (overrides) cfg = deepMerge(cfg, overrides) as BrainConfig;
  cfg = applyEnvOverrides(cfg);
  return validateConfig(cfg);
}

let cached: BrainConfig | null = null;

/** Returns the cached config, loading it (from defaults + the default file path) if needed. */
export function brainConfig(): BrainConfig {
  if (!cached) cached = loadBrainConfig();
  return cached;
}

/** Clears the cache and re-reads the config file, returning the fresh config. */
export function reloadBrainConfig(): BrainConfig {
  cached = null;
  cached = loadBrainConfig();
  return cached;
}

/** The brain's markdown vault root. Creates the directory if missing. */
export function brainHome(): string {
  const dir = brainConfig().markdownRoot;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path to the brain's SQLite database file. */
export function brainDbPath(): string {
  return brainConfig().dbPath;
}

/** The brain's skills root directory. Creates the directory if missing. */
export function brainSkillsRoot(): string {
  const dir = brainConfig().skillsRoot;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
