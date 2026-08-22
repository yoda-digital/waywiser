import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateEvalCases,
  computeHardChecks,
  scoreEvalPair,
  type EvalRunResult,
} from "../../extensions/brain/eval.ts";
import { BrainStore } from "../../extensions/brain/store.ts";
import type { EvalCase, Procedure } from "../../extensions/brain/types.ts";

describe("eval", () => {
  let store: BrainStore;

  beforeEach(() => {
    store = new BrainStore(":memory:");
  });

  describe("generateEvalCases", () => {
    it("generates cases from procedure evidence experiences", () => {
      // Create a procedure and experience with evidence.
      store.upsertProcedure({
        id: "proc_1",
        key: "test-proc",
        triggerText: "test trigger",
      });
      store.recordExperience({
        id: "exp_1",
        sessionId: "s1",
        sessionFile: "",
        branchLeaf: "abc",
        cwd: "/",
        projectKey: null,
        objective: "Fix the deployment bug",
        outcome: { status: "success", confidence: "verified", summary: "Fixed" },
        observations: [],
        recalledMemoryIds: [],
        recalledProcedureIds: [],
        skillsUsed: [],
        externalSources: [],
        startedAt: "2026-01-01T00:00:00Z",
        settledAt: "2026-01-01T00:01:00Z",
      });
      store.recordProcedureEvidence("proc_1", "exp_1", null, "success");

      const proc: Procedure = {
        id: "proc_1",
        key: "test-proc",
        triggerText: "test trigger",
        avoidText: null,
        preferText: null,
        confidence: 0.8,
        successCount: 1,
        failureCount: 0,
        status: "mature",
        scope: "global",
        projectKey: null,
        createdAt: "",
        updatedAt: "",
      };

      const cases = generateEvalCases(proc, store, 3);
      assert.ok(cases.length >= 1);
      assert.ok(cases[0].prompt.includes("Fix the deployment bug") || cases[0].prompt.includes("test trigger"));
    });

    it("stores generated cases in the DB, retrievable via getEvalCases", () => {
      store.upsertProcedure({ id: "proc_1", key: "test-proc", triggerText: "test trigger" });
      store.recordExperience({
        id: "exp_1",
        sessionId: "s1",
        sessionFile: "",
        branchLeaf: "abc",
        cwd: "/",
        projectKey: null,
        objective: "Fix the deployment bug",
        outcome: { status: "success", confidence: "verified", summary: "Fixed" },
        observations: [],
        recalledMemoryIds: [],
        recalledProcedureIds: [],
        skillsUsed: [],
        externalSources: [],
        startedAt: "2026-01-01T00:00:00Z",
        settledAt: "2026-01-01T00:01:00Z",
      });
      store.recordProcedureEvidence("proc_1", "exp_1", null, "success");

      const proc: Procedure = {
        id: "proc_1",
        key: "test-proc",
        triggerText: "test trigger",
        avoidText: null,
        preferText: null,
        confidence: 0.8,
        successCount: 1,
        failureCount: 0,
        status: "mature",
        scope: "global",
        projectKey: null,
        createdAt: "",
        updatedAt: "",
      };

      const cases = generateEvalCases(proc, store, 2);
      const stored = store.getEvalCases("test-proc");
      assert.equal(stored.length, cases.length);
      assert.deepEqual(
        stored.map((c) => c.id).sort(),
        cases.map((c) => c.id).sort(),
      );
    });

    it("fills with synthetic cases when not enough experiences", () => {
      store.upsertProcedure({ id: "proc_1", key: "test-proc", triggerText: "reading files" });
      const proc: Procedure = {
        id: "proc_1",
        key: "test-proc",
        triggerText: "reading files",
        avoidText: null,
        preferText: null,
        confidence: 0.8,
        successCount: 1,
        failureCount: 0,
        status: "mature",
        scope: "global",
        projectKey: null,
        createdAt: "",
        updatedAt: "",
      };
      const cases = generateEvalCases(proc, store, 3);
      assert.equal(cases.length, 3);
      // At least some should be synthetic.
      assert.ok(cases.some((c) => c.prompt.includes("reading files")));
      assert.ok(cases.every((c) => c.skillName === "test-proc"));
      assert.ok(cases.some((c) => c.sourceExperienceId === null));
    });

    it("skips experiences with no objective and falls back to synthetic cases", () => {
      store.upsertProcedure({ id: "proc_1", key: "test-proc", triggerText: "empty objective trigger" });
      store.recordExperience({
        id: "exp_1",
        sessionId: "s1",
        sessionFile: "",
        branchLeaf: "abc",
        cwd: "/",
        projectKey: null,
        objective: "",
        outcome: { status: "success", confidence: "verified", summary: "Fixed" },
        observations: [],
        recalledMemoryIds: [],
        recalledProcedureIds: [],
        skillsUsed: [],
        externalSources: [],
        startedAt: "2026-01-01T00:00:00Z",
        settledAt: "2026-01-01T00:01:00Z",
      });
      store.recordProcedureEvidence("proc_1", "exp_1", null, "success");

      const proc: Procedure = {
        id: "proc_1",
        key: "test-proc",
        triggerText: "empty objective trigger",
        avoidText: null,
        preferText: null,
        confidence: 0.8,
        successCount: 1,
        failureCount: 0,
        status: "mature",
        scope: "global",
        projectKey: null,
        createdAt: "",
        updatedAt: "",
      };

      const cases = generateEvalCases(proc, store, 2);
      assert.equal(cases.length, 2);
      assert.ok(cases.every((c) => c.prompt.includes("empty objective trigger")));
    });
  });

  describe("computeHardChecks", () => {
    it("passes all checks for successful result", () => {
      const result: EvalRunResult = { output: "Done!", toolCalls: 3, errors: 0, completed: true, durationMs: 1000 };
      const evalCase: EvalCase = {
        id: "ec_1",
        skillName: "test",
        prompt: "do thing",
        oracleJson: JSON.stringify({ mustComplete: true, maxErrors: 0 }),
        safetyClass: "safe",
        sourceExperienceId: null,
        createdAt: "",
      };
      const checks = computeHardChecks(result, evalCase);
      assert.ok(checks.every((c) => c.passed));
      assert.ok(checks.some((c) => c.check === "task-completed"));
      assert.ok(checks.some((c) => c.check === "error-count"));
      assert.ok(checks.some((c) => c.check === "has-output"));
    });

    it("fails task-completed check when not completed", () => {
      const result: EvalRunResult = { output: "", toolCalls: 0, errors: 1, completed: false, durationMs: 5000 };
      const evalCase: EvalCase = {
        id: "ec_1",
        skillName: "test",
        prompt: "do thing",
        oracleJson: JSON.stringify({ mustComplete: true, maxErrors: 0 }),
        safetyClass: "safe",
        sourceExperienceId: null,
        createdAt: "",
      };
      const checks = computeHardChecks(result, evalCase);
      const completedCheck = checks.find((c) => c.check === "task-completed");
      assert.equal(completedCheck?.passed, false);
    });

    it("skips task-completed check when oracle sets mustComplete to false", () => {
      const result: EvalRunResult = { output: "", toolCalls: 0, errors: 0, completed: false, durationMs: 100 };
      const evalCase: EvalCase = {
        id: "ec_1",
        skillName: "test",
        prompt: "do thing",
        oracleJson: JSON.stringify({ mustComplete: false, maxErrors: 0 }),
        safetyClass: "safe",
        sourceExperienceId: null,
        createdAt: "",
      };
      const checks = computeHardChecks(result, evalCase);
      assert.ok(!checks.some((c) => c.check === "task-completed"));
    });

    it("fails error-count check when too many errors", () => {
      const result: EvalRunResult = { output: "Done with errors", toolCalls: 5, errors: 3, completed: true, durationMs: 2000 };
      const evalCase: EvalCase = {
        id: "ec_1",
        skillName: "test",
        prompt: "do thing",
        oracleJson: JSON.stringify({ mustComplete: true, maxErrors: 1 }),
        safetyClass: "safe",
        sourceExperienceId: null,
        createdAt: "",
      };
      const checks = computeHardChecks(result, evalCase);
      const errorCheck = checks.find((c) => c.check === "error-count");
      assert.equal(errorCheck?.passed, false);
    });

    it("fails has-output check when output is blank", () => {
      const result: EvalRunResult = { output: "   ", toolCalls: 0, errors: 0, completed: true, durationMs: 100 };
      const evalCase: EvalCase = {
        id: "ec_1",
        skillName: "test",
        prompt: "do thing",
        oracleJson: null,
        safetyClass: "safe",
        sourceExperienceId: null,
        createdAt: "",
      };
      const checks = computeHardChecks(result, evalCase);
      const outputCheck = checks.find((c) => c.check === "has-output");
      assert.equal(outputCheck?.passed, false);
    });

    it("handles null oracleJson gracefully", () => {
      const result: EvalRunResult = { output: "Done", toolCalls: 1, errors: 0, completed: true, durationMs: 500 };
      const evalCase: EvalCase = {
        id: "ec_1",
        skillName: "test",
        prompt: "do thing",
        oracleJson: null,
        safetyClass: "safe",
        sourceExperienceId: null,
        createdAt: "",
      };
      const checks = computeHardChecks(result, evalCase);
      assert.ok(checks.length >= 2);
    });

    it("handles malformed oracleJson gracefully by using defaults", () => {
      const result: EvalRunResult = { output: "Done", toolCalls: 1, errors: 0, completed: true, durationMs: 500 };
      const evalCase: EvalCase = {
        id: "ec_1",
        skillName: "test",
        prompt: "do thing",
        oracleJson: "{not valid json",
        safetyClass: "safe",
        sourceExperienceId: null,
        createdAt: "",
      };
      const checks = computeHardChecks(result, evalCase);
      assert.ok(checks.every((c) => c.passed));
    });
  });

  describe("scoreEvalPair", () => {
    const goodResult: EvalRunResult = { output: "Done!", toolCalls: 3, errors: 0, completed: true, durationMs: 1000 };
    const badResult: EvalRunResult = { output: "", toolCalls: 5, errors: 2, completed: false, durationMs: 5000 };
    const evalCase: EvalCase = {
      id: "ec_1",
      skillName: "test",
      prompt: "do thing",
      oracleJson: JSON.stringify({ mustComplete: true, maxErrors: 0 }),
      safetyClass: "safe",
      sourceExperienceId: null,
      createdAt: "",
    };

    it("candidate wins when baseline fails and candidate passes", async () => {
      const score = await scoreEvalPair(badResult, goodResult, evalCase, null);
      assert.equal(score.candidateBetter, true);
      assert.equal(score.tie, false);
    });

    it("candidate loses when it fails and baseline passes", async () => {
      const score = await scoreEvalPair(goodResult, badResult, evalCase, null);
      assert.equal(score.candidateBetter, false);
      assert.equal(score.tie, false);
    });

    it("tie when both fail", async () => {
      const score = await scoreEvalPair(badResult, badResult, evalCase, null);
      assert.equal(score.tie, true);
      assert.equal(score.candidateBetter, false);
    });

    it("candidate wins with fewer errors", async () => {
      const baseline: EvalRunResult = { output: "Done", toolCalls: 5, errors: 2, completed: true, durationMs: 2000 };
      const candidate: EvalRunResult = { output: "Done", toolCalls: 5, errors: 0, completed: true, durationMs: 1500 };
      const score = await scoreEvalPair(baseline, candidate, evalCase, null);
      assert.equal(score.candidateBetter, true);
    });

    it("candidate loses with more errors", async () => {
      const baseline: EvalRunResult = { output: "Done", toolCalls: 5, errors: 0, completed: true, durationMs: 2000 };
      const candidate: EvalRunResult = { output: "Done", toolCalls: 5, errors: 1, completed: true, durationMs: 1500 };
      const score = await scoreEvalPair(baseline, candidate, evalCase, null);
      assert.equal(score.candidateBetter, false);
      assert.equal(score.tie, false);
    });

    it("candidate wins with significantly fewer tool calls at equal errors", async () => {
      const baseline: EvalRunResult = { output: "Done", toolCalls: 10, errors: 0, completed: true, durationMs: 2000 };
      const candidate: EvalRunResult = { output: "Done", toolCalls: 5, errors: 0, completed: true, durationMs: 1500 };
      const score = await scoreEvalPair(baseline, candidate, evalCase, null);
      assert.equal(score.candidateBetter, true);
      assert.equal(score.reason, "significantly fewer tool calls");
    });

    it("candidate loses with significantly more tool calls at equal errors", async () => {
      const baseline: EvalRunResult = { output: "Done", toolCalls: 5, errors: 0, completed: true, durationMs: 2000 };
      const candidate: EvalRunResult = { output: "Done", toolCalls: 10, errors: 0, completed: true, durationMs: 1500 };
      const score = await scoreEvalPair(baseline, candidate, evalCase, null);
      assert.equal(score.candidateBetter, false);
      assert.equal(score.tie, false);
      assert.equal(score.reason, "significantly more tool calls");
    });

    it("tie when similar performance and no judge", async () => {
      const baseline: EvalRunResult = { output: "Done A", toolCalls: 5, errors: 0, completed: true, durationMs: 1000 };
      const candidate: EvalRunResult = { output: "Done B", toolCalls: 5, errors: 0, completed: true, durationMs: 1100 };
      const score = await scoreEvalPair(baseline, candidate, evalCase, null);
      assert.equal(score.tie, true);
      assert.equal(score.reason, "no significant difference");
    });
  });
});
