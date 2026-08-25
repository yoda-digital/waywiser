import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BrainStore } from "../../extensions/brain/store.ts";
import type { Experience } from "../../extensions/brain/types.ts";
import { handleMemoryInspect, handleExperienceInspect } from "../../extensions/brain/index.ts";

describe("inspect handlers", () => {
  let store: BrainStore;

  beforeEach(() => {
    store = new BrainStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("handleMemoryInspect", () => {
    it("returns usage message when id is undefined", () => {
      const result = handleMemoryInspect(undefined, store);
      assert.equal(result, "Usage: /brain memory <id>");
    });

    it("returns not-found message for missing memory", () => {
      const result = handleMemoryInspect("999", store);
      assert.equal(result, "Memory #999 not found");
    });

    it("adds human-readable fields alongside ISO timestamps", () => {
      const createdAt = "2026-01-15T10:00:00Z";
      const lastAccessed = "2026-01-20T14:30:00Z";
      store.db
        .prepare(
          "INSERT INTO memories (id, type, content, created_at, last_accessed) VALUES (1, 'fact', 'test memory', ?, ?)"
        )
        .run(createdAt, lastAccessed);

      const result = handleMemoryInspect("1", store);
      const parsed = JSON.parse(result);

      // Original ISO fields must be preserved
      assert.equal(parsed.createdAt, createdAt);
      assert.equal(parsed.lastAccessed, lastAccessed);

      // Human fields must be present and non-empty
      assert.ok(typeof parsed.createdAtHuman === "string" && parsed.createdAtHuman.length > 0,
        "createdAtHuman should be a non-empty string");
      assert.ok(typeof parsed.lastAccessedHuman === "string" && parsed.lastAccessedHuman.length > 0,
        "lastAccessedHuman should be a non-empty string");

      // Age field must match the expected pattern
      assert.ok(/\d+(s|m|h|d)(\s\d+(s|m|h))? ago/.test(parsed.age),
        `age "${parsed.age}" should match age pattern`);

      // evidence field must be present (preserve existing shape)
      assert.ok(Array.isArray(parsed.evidence), "evidence should be an array");
    });

    it("includes evidence array in output", () => {
      store.db
        .prepare("INSERT INTO memories (id, type, content) VALUES (2, 'fact', 'another memory')")
        .run();

      const result = handleMemoryInspect("2", store);
      const parsed = JSON.parse(result);
      assert.ok(Array.isArray(parsed.evidence));
    });
  });

  describe("handleExperienceInspect", () => {
    it("returns usage message when id is undefined", () => {
      const result = handleExperienceInspect(undefined, store);
      assert.equal(result, "Usage: /brain experience <id>");
    });

    it("returns not-found message for missing experience", () => {
      const result = handleExperienceInspect("exp_nonexistent", store);
      assert.equal(result, 'Experience "exp_nonexistent" not found');
    });

    it("adds human-readable fields alongside ISO timestamps", () => {
      const exp: Experience = {
        id: "exp_inspect1",
        sessionId: "s1",
        sessionFile: "",
        branchLeaf: "abc",
        cwd: "/project",
        projectKey: "test",
        objective: "Test inspect",
        outcome: { status: "success", confidence: "verified", summary: "Done" },
        observations: [],
        recalledMemoryIds: [],
        recalledProcedureIds: [],
        skillsUsed: [],
        externalSources: [],
        startedAt: "2026-03-10T08:00:00Z",
        settledAt: "2026-03-10T08:05:00Z",
      };
      store.recordExperience(exp);

      const result = handleExperienceInspect("exp_inspect1", store);
      const parsed = JSON.parse(result);

      // Original ISO fields must be preserved
      assert.equal(parsed.startedAt, exp.startedAt);
      assert.equal(parsed.settledAt, exp.settledAt);

      // Human fields must be present and non-empty
      assert.ok(typeof parsed.startedAtHuman === "string" && parsed.startedAtHuman.length > 0,
        "startedAtHuman should be a non-empty string");
      assert.ok(typeof parsed.settledAtHuman === "string" && parsed.settledAtHuman.length > 0,
        "settledAtHuman should be a non-empty string");

      // Age field must match the expected pattern
      assert.ok(/\d+(s|m|h|d)(\s\d+(s|m|h))? ago/.test(parsed.age),
        `age "${parsed.age}" should match age pattern`);
    });
  });
});
