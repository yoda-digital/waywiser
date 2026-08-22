import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferScope, detectProjectKey, isPromotionEligible, SAFETY_BOUNDARIES,
} from "../../extensions/brain/policy.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../extensions/brain/config.ts";
import type { Procedure, EvalVerdict, BrainConfig } from "../../extensions/brain/types.ts";

describe("policy", () => {
  describe("SAFETY_BOUNDARIES", () => {
    it("is frozen and non-empty", () => {
      assert.ok(SAFETY_BOUNDARIES.length >= 5);
      assert.throws(() => { (SAFETY_BOUNDARIES as any).push("hack"); });
    });
  });

  describe("inferScope", () => {
    it("returns global for 'always' keyword", () => {
      assert.equal(inferScope("always use tabs", "/project", DEFAULT_BRAIN_CONFIG), "global");
    });

    it("returns global for 'everywhere' keyword", () => {
      assert.equal(inferScope("use dark mode everywhere", "/p", DEFAULT_BRAIN_CONFIG), "global");
    });

    it("returns global for 'in general' keyword", () => {
      assert.equal(inferScope("in general prefer TypeScript", "/p", DEFAULT_BRAIN_CONFIG), "global");
    });

    it("returns project for 'this project' keyword", () => {
      assert.equal(inferScope("in this project use PostgreSQL", "/p", DEFAULT_BRAIN_CONFIG), "project");
    });

    it("returns project for 'this repo' keyword", () => {
      assert.equal(inferScope("this repo uses ESLint", "/p", DEFAULT_BRAIN_CONFIG), "project");
    });

    it("defaults to project when project detected and scope is infer", () => {
      // Use cwd detection mode for test simplicity
      const cfg = { ...DEFAULT_BRAIN_CONFIG, scoping: { ...DEFAULT_BRAIN_CONFIG.scoping, projectDetection: "cwd" as const } };
      assert.equal(inferScope("some neutral statement", "/project", cfg), "project");
    });

    it("defaults to global when no project detected and scope is infer", () => {
      const cfg = { ...DEFAULT_BRAIN_CONFIG, scoping: { ...DEFAULT_BRAIN_CONFIG.scoping, projectDetection: "explicit" as const } };
      assert.equal(inferScope("some neutral statement", "/project", cfg), "global");
    });

    it("uses configured default scope when not infer", () => {
      const cfg = { ...DEFAULT_BRAIN_CONFIG, scoping: { ...DEFAULT_BRAIN_CONFIG.scoping, defaultScope: "global" as const } };
      assert.equal(inferScope("some statement", "/project", cfg), "global");
    });
  });

  describe("detectProjectKey", () => {
    it("returns cwd when detection is cwd", () => {
      const cfg = { ...DEFAULT_BRAIN_CONFIG, scoping: { ...DEFAULT_BRAIN_CONFIG.scoping, projectDetection: "cwd" as const } };
      assert.equal(detectProjectKey("/my/project", cfg), "/my/project");
    });

    it("returns null when detection is explicit", () => {
      const cfg = { ...DEFAULT_BRAIN_CONFIG, scoping: { ...DEFAULT_BRAIN_CONFIG.scoping, projectDetection: "explicit" as const } };
      assert.equal(detectProjectKey("/my/project", cfg), null);
    });

    it("finds git root from subdirectory", () => {
      // Use the waywiser repo itself as a known git root
      const result = detectProjectKey("/home/nalyk/gits/pi-assistant/waywiser/brain", DEFAULT_BRAIN_CONFIG);
      assert.equal(result, "/home/nalyk/gits/pi-assistant/waywiser");
    });
  });

  describe("isPromotionEligible", () => {
    const goodProc: Procedure = {
      id: "p1", key: "k", triggerText: "t", avoidText: null, preferText: null,
      confidence: 0.8, successCount: 5, failureCount: 0, status: "mature",
      scope: "global", projectKey: null, createdAt: "", updatedAt: "",
    };
    const passingVerdict: EvalVerdict = {
      pass: true,
      hardCheckResults: [{ check: "test", passed: true, detail: "ok" }],
      details: "passed",
    };
    const failingVerdict: EvalVerdict = {
      pass: false,
      hardCheckResults: [{ check: "test", passed: false, detail: "fail" }],
      details: "failed",
    };

    it("returns true for passing eval and good procedure", () => {
      assert.equal(isPromotionEligible(goodProc, passingVerdict, DEFAULT_BRAIN_CONFIG), true);
    });

    it("returns false for failing eval", () => {
      assert.equal(isPromotionEligible(goodProc, failingVerdict, DEFAULT_BRAIN_CONFIG), false);
    });

    it("returns false for contradicted procedure when requireNoContradictions", () => {
      const contradicted = { ...goodProc, status: "contradicted" as const };
      assert.equal(isPromotionEligible(contradicted, passingVerdict, DEFAULT_BRAIN_CONFIG), false);
    });

    it("returns false for low success ratio", () => {
      const lowSuccess = { ...goodProc, successCount: 1, failureCount: 3 };
      assert.equal(isPromotionEligible(lowSuccess, passingVerdict, DEFAULT_BRAIN_CONFIG), false);
    });

    it("allows contradicted when requireNoContradictions is false", () => {
      const cfg = {
        ...DEFAULT_BRAIN_CONFIG,
        evolution: {
          ...DEFAULT_BRAIN_CONFIG.evolution,
          maturity: { ...DEFAULT_BRAIN_CONFIG.evolution.maturity, requireNoContradictions: false },
        },
      };
      const contradicted = { ...goodProc, status: "contradicted" as const };
      assert.equal(isPromotionEligible(contradicted, passingVerdict, cfg), true);
    });
  });
});
