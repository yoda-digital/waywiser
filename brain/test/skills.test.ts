import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureSkillDirs,
  writeCandidate,
  promoteCandidate,
  rejectCandidate,
  rollbackSkill,
  listActiveSkills,
  listCandidates,
  getSkillDiscoverPaths,
  computeVersionHash,
} from "../extensions/brain/skills.ts";
import { BrainStore } from "../extensions/brain/store.ts";
import { DEFAULT_BRAIN_CONFIG } from "../extensions/brain/config.ts";
import type { BrainConfig } from "../extensions/brain/types.ts";

describe("skills", () => {
  let tmpDir: string;
  let config: BrainConfig;
  let store: BrainStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-skills-test-"));
    config = { ...DEFAULT_BRAIN_CONFIG, skillsRoot: tmpDir };
    store = new BrainStore(":memory:");
    ensureSkillDirs(config);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ensureSkillDirs creates active/candidates/retired", () => {
    assert.ok(fs.existsSync(path.join(tmpDir, "active")));
    assert.ok(fs.existsSync(path.join(tmpDir, "candidates")));
    assert.ok(fs.existsSync(path.join(tmpDir, "retired")));
  });

  it("computeVersionHash produces deterministic hash", () => {
    const h1 = computeVersionHash("content A");
    const h2 = computeVersionHash("content A");
    const h3 = computeVersionHash("content B");
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.ok(h1.startsWith("sha256:"));
  });

  it("writeCandidate creates files and DB record", () => {
    const sv = writeCandidate("test-skill", "# Test Skill\nContent", ["proc_1"], config, store);
    assert.ok(sv.id.startsWith("sv_"));
    assert.equal(sv.name, "test-skill");
    assert.equal(sv.status, "candidate");
    assert.equal(sv.parentVersion, null);
    assert.ok(fs.existsSync(path.join(tmpDir, "candidates", "test-skill", sv.versionHash, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(tmpDir, "candidates", "test-skill", sv.versionHash, "metadata.json")));
    const dbSv = store.getSkillVersion(sv.id);
    assert.equal(dbSv?.name, "test-skill");
    assert.deepEqual(dbSv?.sourceProcedureIds, ["proc_1"]);
  });

  it("writeCandidate records the current active version as parent", () => {
    const v1 = writeCandidate("test-skill", "# V1", ["proc_1"], config, store);
    promoteCandidate("test-skill", v1.versionHash, config, store);
    const v2 = writeCandidate("test-skill", "# V2", ["proc_1"], config, store);
    assert.equal(v2.parentVersion, v1.versionHash);
  });

  it("promoteCandidate moves candidate to active", () => {
    const sv = writeCandidate("test-skill", "# Test", ["proc_1"], config, store);
    promoteCandidate("test-skill", sv.versionHash, config, store);
    assert.ok(fs.existsSync(path.join(tmpDir, "active", "test-skill", "SKILL.md")));
    assert.ok(!fs.existsSync(path.join(tmpDir, "candidates", "test-skill", sv.versionHash)));
    const dbSv = store.getSkillVersion(sv.id);
    assert.equal(dbSv?.status, "active");
    assert.ok(dbSv?.promotedAt);

    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, "active", "test-skill", "metadata.json"), "utf-8"));
    assert.ok(meta.promotedAt);
  });

  it("promoteCandidate throws when the candidate does not exist", () => {
    assert.throws(() => promoteCandidate("nope", "sha256:deadbeef", config, store));
  });

  it("promoteCandidate retires old active", () => {
    // Create and promote v1
    const v1 = writeCandidate("test-skill", "# V1", ["proc_1"], config, store);
    promoteCandidate("test-skill", v1.versionHash, config, store);
    // Create and promote v2
    const v2 = writeCandidate("test-skill", "# V2", ["proc_1"], config, store);
    promoteCandidate("test-skill", v2.versionHash, config, store);
    // v1 should be retired
    assert.ok(fs.existsSync(path.join(tmpDir, "retired", "test-skill", v1.versionHash, "SKILL.md")));
    const dbV1 = store.getSkillVersion(v1.id);
    assert.equal(dbV1?.status, "retired");
    // v2 is active, content matches
    const content = fs.readFileSync(path.join(tmpDir, "active", "test-skill", "SKILL.md"), "utf-8");
    assert.ok(content.includes("V2"));
  });

  it("rejectCandidate moves to retired with rejected status", () => {
    const sv = writeCandidate("test-skill", "# Bad", ["proc_1"], config, store);
    rejectCandidate("test-skill", sv.versionHash, config, store);
    assert.ok(fs.existsSync(path.join(tmpDir, "retired", "test-skill", sv.versionHash, "SKILL.md")));
    assert.ok(!fs.existsSync(path.join(tmpDir, "candidates", "test-skill", sv.versionHash)));
    const dbSv = store.getSkillVersion(sv.id);
    assert.equal(dbSv?.status, "rejected");
  });

  it("rejectCandidate throws when the candidate does not exist", () => {
    assert.throws(() => rejectCandidate("nope", "sha256:deadbeef", config, store));
  });

  it("rollbackSkill restores parent version", () => {
    const v1 = writeCandidate("test-skill", "# V1", ["proc_1"], config, store);
    promoteCandidate("test-skill", v1.versionHash, config, store);
    const v2 = writeCandidate("test-skill", "# V2", ["proc_1"], config, store);
    promoteCandidate("test-skill", v2.versionHash, config, store);
    // Rollback v2 → v1
    const restored = rollbackSkill("test-skill", config, store);
    assert.ok(restored);
    assert.equal(restored?.versionHash, v1.versionHash);
    assert.equal(restored?.status, "active");
    // Active dir should have v1 content
    const content = fs.readFileSync(path.join(tmpDir, "active", "test-skill", "SKILL.md"), "utf-8");
    assert.ok(content.includes("V1"));
    // v2 should now be retired
    const dbV2 = store.getSkillVersion(v2.id);
    assert.equal(dbV2?.status, "retired");
    assert.ok(fs.existsSync(path.join(tmpDir, "retired", "test-skill", v2.versionHash, "SKILL.md")));
  });

  it("rollbackSkill returns null when no parent", () => {
    const v1 = writeCandidate("test-skill", "# V1", ["proc_1"], config, store);
    promoteCandidate("test-skill", v1.versionHash, config, store);
    const result = rollbackSkill("test-skill", config, store);
    assert.equal(result, null);
  });

  it("rollbackSkill returns null when there is no active version", () => {
    const result = rollbackSkill("never-created", config, store);
    assert.equal(result, null);
  });

  it("listActiveSkills returns active skills", () => {
    const sv = writeCandidate("test-skill", "# Test", ["proc_1"], config, store);
    promoteCandidate("test-skill", sv.versionHash, config, store);
    const active = listActiveSkills(config);
    assert.equal(active.length, 1);
    assert.equal(active[0].name, "test-skill");
    assert.equal(active[0].path, path.join(tmpDir, "active", "test-skill"));
  });

  it("listActiveSkills returns empty array when active dir is empty", () => {
    assert.deepEqual(listActiveSkills(config), []);
  });

  it("listCandidates returns candidate skills", () => {
    writeCandidate("skill-a", "# A", ["proc_1"], config, store);
    writeCandidate("skill-b", "# B", ["proc_2"], config, store);
    const candidates = listCandidates(config);
    assert.equal(candidates.length, 2);
    const names = candidates.map((c) => c.name).sort();
    assert.deepEqual(names, ["skill-a", "skill-b"]);
  });

  it("listCandidates returns empty array when candidates dir is empty", () => {
    assert.deepEqual(listCandidates(config), []);
  });

  it("getSkillDiscoverPaths returns only active directory", () => {
    const paths = getSkillDiscoverPaths(config);
    assert.equal(paths.length, 1);
    assert.ok(paths[0].endsWith("/active"));
  });
});
