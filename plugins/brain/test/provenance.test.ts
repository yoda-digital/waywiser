import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyToolProvenance,
  classifyEventProvenance,
  confidenceForSource,
  isCallFromUser,
} from "../extensions/brain/provenance.ts";
import { DEFAULT_BRAIN_CONFIG } from "../extensions/brain/config.ts";

describe("provenance", () => {
  describe("classifyToolProvenance", () => {
    it("classifies native file tools as environment", () => {
      for (const tool of ["read", "edit", "write", "grep", "find", "ls", "bash"]) {
        assert.equal(classifyToolProvenance(tool), "environment", tool);
      }
    });

    it("classifies web tools as external", () => {
      assert.equal(classifyToolProvenance("web_search"), "external");
      assert.equal(classifyToolProvenance("web_fetch"), "external");
    });

    it("classifies MCP tools as external", () => {
      assert.equal(classifyToolProvenance("mcp__some_server__some_tool"), "external");
      assert.equal(classifyToolProvenance("mcp__chrome__navigate"), "external");
    });

    it("classifies unknown tools as agent", () => {
      assert.equal(classifyToolProvenance("custom_tool"), "agent");
      assert.equal(classifyToolProvenance("memory"), "agent");
      assert.equal(classifyToolProvenance("delegate_task"), "agent");
    });
  });

  describe("classifyEventProvenance", () => {
    it("classifies user turn_end as user", () => {
      assert.equal(classifyEventProvenance("turn_end", "user"), "user");
    });

    it("classifies assistant turn_end as agent", () => {
      assert.equal(classifyEventProvenance("turn_end", "assistant"), "agent");
    });

    it("classifies tool_result as environment", () => {
      assert.equal(classifyEventProvenance("tool_result"), "environment");
    });

    it("classifies unknown events as agent", () => {
      assert.equal(classifyEventProvenance("agent_start"), "agent");
      assert.equal(classifyEventProvenance("session_start"), "agent");
    });
  });

  describe("confidenceForSource", () => {
    it("returns correct confidence for each source type", () => {
      const cfg = DEFAULT_BRAIN_CONFIG;
      assert.equal(confidenceForSource("user", cfg), 0.9);
      assert.equal(confidenceForSource("agent", cfg), 0.7);
      assert.equal(confidenceForSource("external", cfg), 0.3);
      assert.equal(confidenceForSource("environment", cfg), 0.6);
      assert.equal(confidenceForSource("existing-memory", cfg), 0.5);
    });

    it("uses custom config values", () => {
      const cfg = { ...DEFAULT_BRAIN_CONFIG, provenance: {
        userConfidence: 0.95, agentConfidence: 0.5,
        externalConfidence: 0.1, environmentConfidence: 0.4,
      }};
      assert.equal(confidenceForSource("user", cfg), 0.95);
      assert.equal(confidenceForSource("external", cfg), 0.1);
    });
  });

  describe("isCallFromUser", () => {
    it("returns true for command inputSource", () => {
      assert.equal(isCallFromUser({ inputSource: "command" }), true);
    });

    it("returns true for isCommand flag", () => {
      assert.equal(isCallFromUser({ isCommand: true }), true);
    });

    it("returns false for model-initiated calls", () => {
      assert.equal(isCallFromUser({}), false);
      assert.equal(isCallFromUser({ inputSource: "model" }), false);
      assert.equal(isCallFromUser({ isCommand: false }), false);
    });

    it("handles null/undefined ctx gracefully", () => {
      assert.equal(isCallFromUser(null as any), false);
      assert.equal(isCallFromUser(undefined as any), false);
    });
  });
});
