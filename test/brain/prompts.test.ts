import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBrainContext } from "../../extensions/brain/prompts.ts";
import type { RecallResult } from "../../extensions/brain/types.ts";

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
      assert.ok(result.includes("Memories"));
      assert.ok(!result.includes("Procedures"));
    });
  });
});

describe("renderBrainContext age suffix", () => {
  it("appends (last used …) to each memory line", () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const out = renderBrainContext({
      items: [
        { type: "memory", id: 1, scope: "user" as never, content: "prefers Romanian",
          score: 0.9, fusionBreakdown: { lexical: 0.5, scope: 0.3, usage: 0.1, confidence: 0, recency: 0 },
          last_accessed: yesterday, created_at: yesterday },
      ],
      memoryIds: [1], procedureIds: [], revision: 1,
    });
    assert.match(out, /prefers Romanian.*\(last used .+\)/);
  });

  it("appends (N uses, last …) to each procedure line", () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const out = renderBrainContext({
      items: [
        { type: "procedure", id: "proc_1", scope: "global", content: "always test after refactor",
          score: 0.8, fusionBreakdown: { lexical: 0.4, scope: 0.2, usage: 0.1, confidence: 0.1, recency: 0 },
          uses: 5, last_used: yesterday, created_at: yesterday },
      ],
      memoryIds: [], procedureIds: ["proc_1"], revision: 1,
    });
    assert.match(out, /always test after refactor.*\(5 uses, last .+\)/);
  });

  it("falls back to created_at when last_accessed absent", () => {
    const created = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const out = renderBrainContext({
      items: [
        { type: "memory", id: 2, scope: "global", content: "some fact",
          score: 0.7, fusionBreakdown: { lexical: 0.5, scope: 0, usage: 0, confidence: 0, recency: 0 },
          created_at: created },
      ],
      memoryIds: [2], procedureIds: [], revision: 1,
    });
    assert.match(out, /some fact.*\(last used .+\)/);
  });

  it("omits age suffix when both last_accessed and created_at are absent (memory)", () => {
    const out = renderBrainContext({
      items: [
        { type: "memory", id: 3, scope: "global", content: "bare fact",
          score: 0.6, fusionBreakdown: { lexical: 0.5, scope: 0, usage: 0, confidence: 0, recency: 0 } },
      ],
      memoryIds: [3], procedureIds: [], revision: 1,
    });
    assert.ok(!out.includes("(last used"), "should not have age suffix when no timestamp");
  });
});
