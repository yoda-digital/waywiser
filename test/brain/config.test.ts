import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BRAIN_VERSION,
  DEFAULT_BRAIN_CONFIG,
  loadBrainConfig,
  reloadBrainConfig,
  brainConfig,
  brainHome,
  brainSkillsRoot,
  brainDbPath,
} from "../../extensions/brain/config.ts";

const NONEXISTENT_CONFIG_PATH = "/tmp/waywiser-brain-test-does-not-exist-12345.json";

const ENV_VARS = ["BRAIN_CONFIG", "BRAIN_MARKDOWN_ROOT", "BRAIN_DB_PATH", "BRAIN_SKILLS_ROOT"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_VARS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  reloadBrainConfig();
});

describe("config", () => {
  it("returns defaults when no config file exists", () => {
    const cfg = loadBrainConfig(NONEXISTENT_CONFIG_PATH);

    assert.equal(cfg.markdownRoot, path.join(os.homedir(), ".waywiser", "brain"));
    assert.equal(cfg.dbPath, path.join(os.homedir(), ".waywiser", "waywiser.db"));
    assert.equal(cfg.skillsRoot, path.join(os.homedir(), ".waywiser", "skills"));
    assert.equal(cfg.experienceRoot, null);

    assert.deepEqual(cfg.modules, {
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
    });

    assert.equal(cfg.learning.boundary, "agent_settled");
    assert.equal(cfg.learning.maxReflectionsPerSession, 10);
    assert.equal(cfg.learning.maxMemoriesPerRun, 3);
    assert.equal(cfg.learning.gateTimeoutMs, 12000);
    assert.equal(cfg.learning.minObservationsForReflection, 1);

    assert.equal(cfg.recall.mode, "selective");
    assert.equal(cfg.recall.maxItems, 8);
    assert.equal(cfg.recall.maxChars, 2000);
    assert.deepEqual(cfg.recall.fusionWeights, { lexical: 1.0, scope: 0.8, usage: 0.5, confidence: 0.3, recency: 0.2 });
    assert.equal(cfg.recall.useCustomMessage, true);

    assert.deepEqual(cfg.provenance, {
      externalConfidence: 0.3,
      userConfidence: 0.9,
      agentConfidence: 0.7,
      environmentConfidence: 0.6,
    });

    assert.deepEqual(cfg.scoping, { defaultScope: "infer", projectDetection: "git-root", scopeBoost: 2.0 });

    assert.deepEqual(cfg.evolution, {
      maturity: {
        minPositiveObservations: 3,
        minIndependentExperiences: 2,
        minSuccessRatio: 0.75,
        requireNoContradictions: true,
      },
      evalCasesPerCandidate: 5,
      promotionPolicy: "auto",
      promotionBoundary: "next-session",
    });

    assert.deepEqual(cfg.vault, {
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
    });

    assert.deepEqual(cfg.cognition, { poolSize: 2, model: null, thinkingLevel: null, idleTtlMs: 600000 });
    assert.deepEqual(cfg.soul, { narrowMode: true, snapshotAtStart: true });
    assert.deepEqual(cfg.consolidation, { batchSize: 50, runOnShutdown: true, dryRunByDefault: false });

    // Defaults themselves must be identical to the exported constant.
    assert.deepEqual(cfg, DEFAULT_BRAIN_CONFIG);
  });

  it("deep-merges partial config over defaults", () => {
    const cfg = loadBrainConfig(NONEXISTENT_CONFIG_PATH, { learning: { maxReflectionsPerSession: 5 } });

    assert.equal(cfg.learning.maxReflectionsPerSession, 5);
    // Untouched sibling fields must retain their defaults.
    assert.equal(cfg.learning.boundary, "agent_settled");
    assert.equal(cfg.learning.maxMemoriesPerRun, 3);
    assert.equal(cfg.learning.gateTimeoutMs, 12000);
    assert.equal(cfg.learning.minObservationsForReflection, 1);
    // Unrelated top-level sections untouched.
    assert.equal(cfg.recall.mode, "selective");
  });

  it("clamps confidence values to 0-1", () => {
    const cfg = loadBrainConfig(NONEXISTENT_CONFIG_PATH, {
      provenance: { userConfidence: 1.5, externalConfidence: -0.3 },
    });

    assert.equal(cfg.provenance.userConfidence, 1.0);
    assert.equal(cfg.provenance.externalConfidence, 0.0);
    // Untouched fields retain defaults.
    assert.equal(cfg.provenance.agentConfidence, 0.7);
    assert.equal(cfg.provenance.environmentConfidence, 0.6);
  });

  it("clamps gateTimeoutMs to valid range", () => {
    const low = loadBrainConfig(NONEXISTENT_CONFIG_PATH, { learning: { gateTimeoutMs: 500 } });
    assert.equal(low.learning.gateTimeoutMs, 1000);

    const high = loadBrainConfig(NONEXISTENT_CONFIG_PATH, { learning: { gateTimeoutMs: 99999 } });
    assert.equal(high.learning.gateTimeoutMs, 30000);
  });

  it("clamps poolSize and scopeBoost to valid ranges", () => {
    const cfg = loadBrainConfig(NONEXISTENT_CONFIG_PATH, {
      cognition: { poolSize: 20 },
      scoping: { scopeBoost: 50 },
    });
    assert.equal(cfg.cognition.poolSize, 8);
    assert.equal(cfg.scoping.scopeBoost, 10);

    const negative = loadBrainConfig(NONEXISTENT_CONFIG_PATH, {
      cognition: { poolSize: -5 },
      scoping: { scopeBoost: -5 },
    });
    assert.equal(negative.cognition.poolSize, 0);
    assert.equal(negative.scoping.scopeBoost, 0);
  });

  it("disables evolve when eval is disabled", () => {
    const cfg = loadBrainConfig(NONEXISTENT_CONFIG_PATH, { modules: { eval: false, evolve: true } });
    assert.equal(cfg.modules.evolve, false);
  });

  it("disables evolve when skills is disabled", () => {
    const cfg = loadBrainConfig(NONEXISTENT_CONFIG_PATH, { modules: { skills: false, evolve: true } });
    assert.equal(cfg.modules.evolve, false);
  });

  it("keeps evolve enabled when eval and skills are both enabled", () => {
    const cfg = loadBrainConfig(NONEXISTENT_CONFIG_PATH, { modules: { eval: true, skills: true, evolve: true } });
    assert.equal(cfg.modules.evolve, true);
  });

  it("applies env var overrides over file config", () => {
    process.env.BRAIN_MARKDOWN_ROOT = "/tmp/test-brain-markdown-root";
    process.env.BRAIN_DB_PATH = "/tmp/test-brain.db";
    process.env.BRAIN_SKILLS_ROOT = "/tmp/test-brain-skills";

    // Even with an override present in the "file merge" input, env vars win.
    const cfg = loadBrainConfig(NONEXISTENT_CONFIG_PATH, { markdownRoot: "/tmp/should-be-overridden" });

    assert.equal(cfg.markdownRoot, "/tmp/test-brain-markdown-root");
    assert.equal(cfg.dbPath, "/tmp/test-brain.db");
    assert.equal(cfg.skillsRoot, "/tmp/test-brain-skills");
  });

  it("BRAIN_VERSION reads from package.json", () => {
    assert.equal(BRAIN_VERSION, "1.0.0");
  });

  it("reloadBrainConfig clears cache", () => {
    process.env.BRAIN_CONFIG = NONEXISTENT_CONFIG_PATH;
    delete process.env.BRAIN_MARKDOWN_ROOT;
    reloadBrainConfig();

    const before = brainConfig();
    assert.equal(before.markdownRoot, path.join(os.homedir(), ".waywiser", "brain"));

    // Changing the env var after the config is cached must NOT affect the
    // cached value until reloadBrainConfig() is called.
    process.env.BRAIN_MARKDOWN_ROOT = "/tmp/test-reload-markdown-root";
    const stillCached = brainConfig();
    assert.equal(stillCached.markdownRoot, before.markdownRoot);

    const after = reloadBrainConfig();
    assert.equal(after.markdownRoot, "/tmp/test-reload-markdown-root");
    assert.equal(brainConfig().markdownRoot, "/tmp/test-reload-markdown-root");
  });

  it("brainHome creates directory", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-brain-home-"));
    const targetDir = path.join(tmpRoot, "brain-vault");
    assert.equal(fs.existsSync(targetDir), false);

    process.env.BRAIN_CONFIG = NONEXISTENT_CONFIG_PATH;
    process.env.BRAIN_MARKDOWN_ROOT = targetDir;
    reloadBrainConfig();

    const dir = brainHome();

    assert.equal(dir, targetDir);
    assert.equal(fs.existsSync(targetDir), true);
    assert.equal(fs.statSync(targetDir).isDirectory(), true);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("brainSkillsRoot creates directory", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-brain-skills-"));
    const targetDir = path.join(tmpRoot, "skills-vault");

    process.env.BRAIN_CONFIG = NONEXISTENT_CONFIG_PATH;
    process.env.BRAIN_SKILLS_ROOT = targetDir;
    reloadBrainConfig();

    const dir = brainSkillsRoot();

    assert.equal(dir, targetDir);
    assert.equal(fs.existsSync(targetDir), true);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("brainDbPath returns the configured db path", () => {
    process.env.BRAIN_CONFIG = NONEXISTENT_CONFIG_PATH;
    process.env.BRAIN_DB_PATH = "/tmp/test-brain-db-path.db";
    reloadBrainConfig();

    assert.equal(brainDbPath(), "/tmp/test-brain-db-path.db");
  });

  it("deep-merges a JSON config file over defaults", () => {
    const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-brain-file-")), "brain.json");
    fs.writeFileSync(tmpFile, JSON.stringify({ recall: { maxItems: 3 }, soul: { narrowMode: false } }));

    const cfg = loadBrainConfig(tmpFile);

    assert.equal(cfg.recall.maxItems, 3);
    assert.equal(cfg.recall.maxChars, 2000); // sibling default preserved
    assert.equal(cfg.soul.narrowMode, false);
    assert.equal(cfg.soul.snapshotAtStart, true); // sibling default preserved

    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it("missing config file falls back to defaults without throwing", () => {
    assert.doesNotThrow(() => loadBrainConfig(NONEXISTENT_CONFIG_PATH));
  });
});
