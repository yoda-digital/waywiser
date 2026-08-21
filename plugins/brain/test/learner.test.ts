import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deterministicExtract, validateCandidates, generateProcedureKey } from "../extensions/brain/learner.ts";
import { DEFAULT_BRAIN_CONFIG } from "../extensions/brain/config.ts";
import type { Experience, Observation, LearningResult } from "../extensions/brain/types.ts";

function makeExperience(overrides: Partial<Experience> = {}): Experience {
  return {
    id: "exp_test", sessionId: "s1", sessionFile: "", branchLeaf: "abc",
    cwd: "/project", projectKey: "test", objective: "",
    outcome: { status: "success", confidence: "inferred", summary: "" },
    observations: [], recalledMemoryIds: [], recalledProcedureIds: [],
    skillsUsed: [], externalSources: [], startedAt: "2026-01-01T00:00:00Z",
    settledAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1", toolCallId: "tc_1", tool: "read", targetKey: "/foo.ts",
    input: {}, result: "success", provenance: "environment",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("learner", () => {
  describe("deterministicExtract", () => {
    it("detects user corrections", () => {
      const exp = makeExperience({ objective: "No, actually use PostgreSQL instead" });
      const pass1 = deterministicExtract(exp, DEFAULT_BRAIN_CONFIG);
      assert.ok(pass1.hasDurableSignals);
      assert.ok(pass1.userCorrections.length > 0);
    });

    it("detects user preference statements", () => {
      const exp = makeExperience({ objective: "I prefer dark mode in all editors" });
      const pass1 = deterministicExtract(exp, DEFAULT_BRAIN_CONFIG);
      assert.ok(pass1.hasDurableSignals);
      assert.ok(pass1.userStatements.length > 0);
    });

    it("detects 'remember that' statements", () => {
      const exp = makeExperience({ objective: "Remember that we use TypeScript strict mode" });
      const pass1 = deterministicExtract(exp, DEFAULT_BRAIN_CONFIG);
      assert.ok(pass1.userStatements.length > 0);
    });

    it("detects tool failures", () => {
      const exp = makeExperience({
        observations: [makeObs({ result: "error", errorClass: "command-failed" })],
      });
      const pass1 = deterministicExtract(exp, DEFAULT_BRAIN_CONFIG);
      assert.ok(pass1.hasDurableSignals);
      assert.equal(pass1.toolFailures.length, 1);
    });

    it("detects recoveries", () => {
      const exp = makeExperience({
        observations: [
          makeObs({ id: "obs_1", result: "error", tool: "bash", targetKey: "/big.json" }),
          makeObs({ id: "obs_2", result: "success", tool: "read", targetKey: "/big.json", recoveryOf: "obs_1" }),
        ],
      });
      const pass1 = deterministicExtract(exp, DEFAULT_BRAIN_CONFIG);
      assert.ok(pass1.hasDurableSignals);
      assert.equal(pass1.recoveries.length, 1);
      assert.equal(pass1.recoveries[0].failed.id, "obs_1");
      assert.equal(pass1.recoveries[0].succeeded.id, "obs_2");
    });

    it("returns hasDurableSignals=false for plain Q&A", () => {
      const exp = makeExperience({
        objective: "What time is it",
        observations: [makeObs({ result: "success" })],
      });
      const pass1 = deterministicExtract(exp, DEFAULT_BRAIN_CONFIG);
      assert.equal(pass1.hasDurableSignals, false);
    });

    it("tracks external observations", () => {
      const exp = makeExperience({
        observations: [makeObs({ provenance: "external" })],
      });
      const pass1 = deterministicExtract(exp, DEFAULT_BRAIN_CONFIG);
      assert.equal(pass1.externalObservations.length, 1);
    });

    it("carries skillsUsed from experience", () => {
      const exp = makeExperience({
        skillsUsed: [{ name: "test-skill", versionHash: "abc" }],
      });
      const pass1 = deterministicExtract(exp, DEFAULT_BRAIN_CONFIG);
      assert.equal(pass1.skillsUsed.length, 1);
    });
  });

  describe("validateCandidates", () => {
    it("overrides LLM source with agent when no user verbatim match", () => {
      const candidates: LearningResult = {
        memories: [{
          type: "fact", content: "Project uses PostgreSQL",
          source: "user", // LLM claimed user
          confidence: 0.9, scope: "project", projectKey: "test",
          verbatim: "some text not in objective", supersedesId: null,
        }],
        procedureUpdates: [],
        usageRecords: [],
      };
      const exp = makeExperience({ objective: "Different objective text" });
      const validated = validateCandidates(candidates, exp, DEFAULT_BRAIN_CONFIG);
      assert.equal(validated.memories[0].source, "agent");
    });

    it("promotes to user source when verbatim matches the objective", () => {
      const candidates: LearningResult = {
        memories: [{
          type: "preference", content: "User wants dark mode",
          source: "agent",
          confidence: 0.5, scope: "global", projectKey: null,
          verbatim: "I prefer dark mode", supersedesId: null,
        }],
        procedureUpdates: [],
        usageRecords: [],
      };
      const exp = makeExperience({ objective: "I prefer dark mode in all editors" });
      const validated = validateCandidates(candidates, exp, DEFAULT_BRAIN_CONFIG);
      assert.equal(validated.memories[0].source, "user");
    });

    it("bounds confidence by source type", () => {
      const candidates: LearningResult = {
        memories: [{
          type: "fact", content: "Something",
          source: "agent", confidence: 0.99,
          scope: "global", projectKey: null,
          verbatim: null, supersedesId: null,
        }],
        procedureUpdates: [],
        usageRecords: [],
      };
      const exp = makeExperience();
      const validated = validateCandidates(candidates, exp, DEFAULT_BRAIN_CONFIG);
      // Agent confidence default is 0.7, so 0.99 should be clamped
      assert.ok(validated.memories[0].confidence <= 0.7);
    });

    it("preserves procedure updates and usage records", () => {
      const candidates: LearningResult = {
        memories: [],
        procedureUpdates: [{ key: "k", triggerText: "t", avoidText: null, preferText: null, outcome: "success", experienceId: "e", observationId: null }],
        usageRecords: [{ memoryId: 1, useful: true, contradicted: false }],
      };
      const validated = validateCandidates(candidates, makeExperience(), DEFAULT_BRAIN_CONFIG);
      assert.equal(validated.procedureUpdates.length, 1);
      assert.equal(validated.usageRecords.length, 1);
    });
  });

  describe("generateProcedureKey", () => {
    it("produces a stable, slug-like key from trigger/avoid/prefer", () => {
      const key = generateProcedureKey("bash fails on /big.json", "bash", "read");
      assert.equal(key, generateProcedureKey("bash fails on /big.json", "bash", "read"));
      assert.ok(/^[a-z0-9-]+$/.test(key));
    });

    it("omits empty avoid/prefer segments", () => {
      const key = generateProcedureKey("Some Trigger!", null, null);
      assert.equal(key, "some-trigger");
    });

    it("caps key length at 100 chars", () => {
      const longTrigger = "x".repeat(200);
      const key = generateProcedureKey(longTrigger, null, null);
      assert.ok(key.length <= 100);
    });
  });
});
