import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBrainContext } from "../extensions/brain/prompts.ts";
import type { RecallResult } from "../extensions/brain/types.ts";

describe("prompts", () => {
  describe("renderBrainContext", () => {
    it("returns empty string for no items", () => {
      const result = renderBrainContext({ items: [], memoryIds: [], procedureIds: [], revision: 0 });
      assert.equal(result, "");
    });

    it("renders memories and procedures in XML block", () => {
      const recalled: RecallResult = {
        items: [
          { type: "memory", id: 1, content: "Use PostgreSQL", score: 0.9, scope: "project",
            fusionBreakdown: { lexical: 0.5, scope: 0.3, usage: 0.1, confidence: 0, recency: 0 } },
          { type: "procedure", id: "proc_1", content: "When reading large files, use native read instead of cat", score: 0.8, scope: "global",
            fusionBreakdown: { lexical: 0.4, scope: 0.2, usage: 0.1, confidence: 0.1, recency: 0 } },
        ],
        memoryIds: [1],
        procedureIds: ["proc_1"],
        revision: 1,
      };
      const result = renderBrainContext(recalled);
      assert.ok(result.includes("<waywiser-brain-context>"));
      assert.ok(result.includes("</waywiser-brain-context>"));
      assert.ok(result.includes("Use PostgreSQL"));
      assert.ok(result.includes("[project]"));
      assert.ok(result.includes("native read instead of cat"));
    });

    it("renders only memories when no procedures", () => {
      const recalled: RecallResult = {
        items: [
          { type: "memory", id: 1, content: "Fact", score: 0.9, scope: "global",
            fusionBreakdown: { lexical: 0.5, scope: 0, usage: 0, confidence: 0, recency: 0 } },
        ],
        memoryIds: [1], procedureIds: [], revision: 1,
      };
      const result = renderBrainContext(recalled);
      assert.ok(result.includes("Relevant Memories"));
      assert.ok(!result.includes("Relevant Procedures"));
    });
  });
});
