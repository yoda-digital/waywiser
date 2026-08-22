import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  updateProcedureConfidence,
  deriveProcedureStatus,
  checkMaturity,
  updateProcedureEvidence,
} from "../../extensions/brain/procedures.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../extensions/brain/config.ts";
import { BrainStore } from "../../extensions/brain/store.ts";
import type { Experience, LearningResult } from "../../extensions/brain/types.ts";

function makeExperience(id: string): Experience {
  return {
    id,
    sessionId: "s1",
    sessionFile: "",
    branchLeaf: "abc",
    cwd: "/",
    projectKey: "",
    objective: "",
    outcome: { status: "success", confidence: "inferred", summary: "" },
    observations: [],
    recalledMemoryIds: [],
    recalledProcedureIds: [],
    skillsUsed: [],
    externalSources: [],
    startedAt: "2026-01-01T00:00:00Z",
    settledAt: "2026-01-01T00:01:00Z",
  };
}

describe("procedures", () => {
  describe("updateProcedureConfidence", () => {
    it("increases confidence on success", () => {
      const conf = updateProcedureConfidence(0.5, "success");
      assert.ok(conf > 0.5);
    });

    it("decreases confidence on failure", () => {
      const conf = updateProcedureConfidence(0.5, "failure");
      assert.ok(conf < 0.5);
    });

    it("bounds confidence to [0.1, 0.99]", () => {
      // Many successes shouldn't exceed 0.99
      let conf = 0.9;
      for (let i = 0; i < 50; i++) conf = updateProcedureConfidence(conf, "success");
      assert.ok(conf <= 0.99);

      // Many failures shouldn't go below 0.1
      conf = 0.2;
      for (let i = 0; i < 50; i++) conf = updateProcedureConfidence(conf, "failure");
      assert.ok(conf >= 0.1);
    });
  });

  describe("deriveProcedureStatus", () => {
    it("returns tentative for new procedure", () => {
      const status = deriveProcedureStatus(
        { successCount: 1, failureCount: 0, status: "tentative" },
        1,
        DEFAULT_BRAIN_CONFIG,
      );
      assert.equal(status, "tentative");
    });

    it("returns reinforced after 2+ experiences with 2+ successes", () => {
      const status = deriveProcedureStatus(
        { successCount: 2, failureCount: 0, status: "tentative" },
        2,
        DEFAULT_BRAIN_CONFIG,
      );
      assert.equal(status, "reinforced");
    });

    it("returns mature when all thresholds met", () => {
      const status = deriveProcedureStatus(
        { successCount: 4, failureCount: 0, status: "reinforced" },
        3,
        DEFAULT_BRAIN_CONFIG,
      );
      assert.equal(status, "mature");
    });

    it("returns contradicted when failures > successes with enough data", () => {
      const status = deriveProcedureStatus(
        { successCount: 1, failureCount: 2, status: "reinforced" },
        3,
        DEFAULT_BRAIN_CONFIG,
      );
      assert.equal(status, "contradicted");
    });

    it("does not contradict with insufficient data", () => {
      const status = deriveProcedureStatus(
        { successCount: 0, failureCount: 1, status: "tentative" },
        1,
        DEFAULT_BRAIN_CONFIG,
      );
      assert.equal(status, "tentative"); // not enough data to contradict
    });

    it("returns retired when failures overwhelm successes with enough data", () => {
      const status = deriveProcedureStatus(
        { successCount: 1, failureCount: 3, status: "contradicted" },
        3,
        DEFAULT_BRAIN_CONFIG,
      );
      assert.equal(status, "retired");
    });

    it("respects custom maturity thresholds", () => {
      const customConfig = {
        ...DEFAULT_BRAIN_CONFIG,
        evolution: {
          ...DEFAULT_BRAIN_CONFIG.evolution,
          maturity: { minPositiveObservations: 5, minIndependentExperiences: 3, minSuccessRatio: 0.8, requireNoContradictions: true },
        },
      };
      // 3 successes, 0 failures, 3 experiences — not mature (needs 5 positive)
      const status = deriveProcedureStatus(
        { successCount: 3, failureCount: 0, status: "reinforced" },
        3,
        customConfig,
      );
      assert.notEqual(status, "mature");
    });
  });

  describe("checkMaturity", () => {
    it("returns true for mature procedure", () => {
      const proc = {
        id: "p1", key: "k", triggerText: "t", avoidText: null, preferText: null,
        confidence: 0.8, successCount: 4, failureCount: 0, status: "reinforced" as const,
        scope: "global" as const, projectKey: null,
        createdAt: "", updatedAt: "",
      };
      assert.equal(checkMaturity(proc, 3, DEFAULT_BRAIN_CONFIG), true);
    });

    it("returns false for immature procedure", () => {
      const proc = {
        id: "p1", key: "k", triggerText: "t", avoidText: null, preferText: null,
        confidence: 0.5, successCount: 1, failureCount: 0, status: "tentative" as const,
        scope: "global" as const, projectKey: null,
        createdAt: "", updatedAt: "",
      };
      assert.equal(checkMaturity(proc, 1, DEFAULT_BRAIN_CONFIG), false);
    });
  });

  describe("updateProcedureEvidence", () => {
    it("creates a new procedure from learning result", () => {
      const store = new BrainStore(":memory:");
      const exp = makeExperience("exp_1");
      const learning: LearningResult = {
        memories: [],
        procedureUpdates: [{
          key: "large-file-read",
          triggerText: "reading large file",
          avoidText: "bash cat",
          preferText: "native read",
          outcome: "success",
          experienceId: "exp_1",
          observationId: null,
        }],
        usageRecords: [],
      };
      updateProcedureEvidence(exp, learning, store, DEFAULT_BRAIN_CONFIG);
      const proc = store.getProcedure("large-file-read");
      assert.ok(proc);
      assert.equal(proc!.triggerText, "reading large file");
      assert.equal(proc!.avoidText, "bash cat");
      assert.equal(proc!.preferText, "native read");
      assert.equal(proc!.status, "tentative");
      assert.equal(proc!.successCount, 1);
      assert.equal(proc!.failureCount, 0);
      assert.ok(proc!.confidence > 0.5);
      store.close();
    });

    it("reinforces existing procedure with second experience", () => {
      const store = new BrainStore(":memory:");
      const makeLearning = (expId: string): LearningResult => ({
        memories: [],
        procedureUpdates: [{
          key: "large-file-read", triggerText: "reading large file",
          avoidText: "bash cat", preferText: "native read",
          outcome: "success", experienceId: expId, observationId: null,
        }],
        usageRecords: [],
      });

      updateProcedureEvidence(makeExperience("exp_1"), makeLearning("exp_1"), store, DEFAULT_BRAIN_CONFIG);
      updateProcedureEvidence(makeExperience("exp_2"), makeLearning("exp_2"), store, DEFAULT_BRAIN_CONFIG);

      const proc = store.getProcedure("large-file-read");
      assert.ok(proc);
      assert.equal(proc!.successCount, 2);
      assert.ok(proc!.confidence > 0.5);
      assert.equal(proc!.status, "reinforced");
      store.close();
    });

    it("moves a procedure toward contradicted when failures dominate", () => {
      const store = new BrainStore(":memory:");
      const makeLearning = (expId: string, outcome: "success" | "failure"): LearningResult => ({
        memories: [],
        procedureUpdates: [{
          key: "flaky-approach", triggerText: "trigger",
          avoidText: "avoid", preferText: "prefer",
          outcome, experienceId: expId, observationId: null,
        }],
        usageRecords: [],
      });

      updateProcedureEvidence(makeExperience("exp_1"), makeLearning("exp_1", "success"), store, DEFAULT_BRAIN_CONFIG);
      updateProcedureEvidence(makeExperience("exp_2"), makeLearning("exp_2", "failure"), store, DEFAULT_BRAIN_CONFIG);
      updateProcedureEvidence(makeExperience("exp_3"), makeLearning("exp_3", "failure"), store, DEFAULT_BRAIN_CONFIG);

      const proc = store.getProcedure("flaky-approach");
      assert.ok(proc);
      assert.equal(proc!.successCount, 1);
      assert.equal(proc!.failureCount, 2);
      assert.equal(proc!.status, "contradicted");
      assert.ok(proc!.confidence < 0.5);
      store.close();
    });

    it("falls back to generateProcedureKey when the update has no key", () => {
      const store = new BrainStore(":memory:");
      const exp = makeExperience("exp_1");
      const learning: LearningResult = {
        memories: [],
        procedureUpdates: [{
          key: "",
          triggerText: "some trigger text",
          avoidText: "old way",
          preferText: "new way",
          outcome: "success",
          experienceId: "exp_1",
          observationId: null,
        }],
        usageRecords: [],
      };
      updateProcedureEvidence(exp, learning, store, DEFAULT_BRAIN_CONFIG);
      const proc = store.getProcedure("some-trigger-text--old-way--new-way");
      assert.ok(proc);
      store.close();
    });
  });
});
