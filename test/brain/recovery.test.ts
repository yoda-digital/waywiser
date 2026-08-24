import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTargetKey, normalizePath, linkRecoveries } from "../../extensions/brain/recovery.ts";
import type { Observation } from "../../extensions/brain/types.ts";

describe("recovery", () => {
  describe("normalizePath", () => {
    it("resolves relative paths against cwd", () => {
      assert.equal(normalizePath("./foo.ts", "/project"), "/project/foo.ts");
      assert.equal(normalizePath("foo.ts", "/project"), "/project/foo.ts");
    });

    it("resolves .. segments", () => {
      assert.equal(normalizePath("./src/../bar.ts", "/project"), "/project/bar.ts");
    });

    it("expands ~ to HOME", () => {
      const home = process.env.HOME || "/home/user";
      assert.equal(normalizePath("~/foo.ts", "/project"), home + "/foo.ts");
    });

    it("leaves absolute paths as-is (but normalizes)", () => {
      assert.equal(normalizePath("/abs/./path/../file.ts", "/cwd"), "/abs/file.ts");
    });
  });

  describe("extractTargetKey", () => {
    it("extracts file path for read tool", () => {
      assert.equal(
        extractTargetKey("read", { path: "/foo/bar.ts" }, "/cwd"),
        "/foo/bar.ts"
      );
    });

    it("extracts file path for edit tool (pi `path` param)", () => {
      assert.equal(
        extractTargetKey("edit", { path: "/foo/bar.ts" }, "/cwd"),
        "/foo/bar.ts"
      );
      // legacy `file_path` still accepted
      assert.equal(
        extractTargetKey("edit", { file_path: "/foo/bar.ts" }, "/cwd"),
        "/foo/bar.ts"
      );
    });

    it("does not collapse a pathless edit to cwd", () => {
      // Regression: input lacked `path`, so normalizePath("") resolved to
      // cwd and the failure's target key was the repo directory itself.
      assert.equal(
        extractTargetKey("edit", { edits: [{ oldText: "a", newText: "b" }] }, "/repo"),
        "edit:?"
      );
    });

    it("extracts pattern@path for grep", () => {
      assert.equal(
        extractTargetKey("grep", { pattern: "TODO", path: "/src" }, "/cwd"),
        "TODO@/src"
      );
    });

    it("extracts path for ls", () => {
      assert.equal(
        extractTargetKey("ls", { path: "/project/src" }, "/cwd"),
        "/project/src"
      );
    });

    it("extracts file target from bash cat", () => {
      const key = extractTargetKey("bash", { command: "cat /foo/bar.ts" }, "/cwd");
      assert.equal(key, "/foo/bar.ts");
    });

    it("extracts file target from bash rm -f", () => {
      const key = extractTargetKey("bash", { command: "rm -f /tmp/junk" }, "/cwd");
      assert.equal(key, "/tmp/junk");
    });

    it("uses truncated command for non-file bash", () => {
      const key = extractTargetKey("bash", { command: "npm install" }, "/cwd");
      assert.equal(key, "npm install");
    });

    it("extracts query for web_search", () => {
      assert.equal(
        extractTargetKey("web_search", { query: "how to fix bug" }, "/cwd"),
        "how to fix bug"
      );
    });

    it("extracts url for web_fetch", () => {
      assert.equal(
        extractTargetKey("web_fetch", { url: "https://example.com" }, "/cwd"),
        "https://example.com"
      );
    });

    it("handles MCP/custom tools", () => {
      assert.equal(
        extractTargetKey("mcp__server__tool", { arg1: "value" }, "/cwd"),
        "mcp__server__tool:value"
      );
    });
  });

  describe("linkRecoveries", () => {
    function makeObs(overrides: Partial<Observation>): Observation {
      return {
        id: "obs_1", toolCallId: "tc_1", tool: "read", targetKey: "/foo.ts",
        input: {}, result: "success", provenance: "environment", timestamp: new Date().toISOString(),
        ...overrides,
      };
    }

    it("links success to prior error on same target", () => {
      const obs = [
        makeObs({ id: "obs_1", result: "error", targetKey: "/foo.ts" }),
        makeObs({ id: "obs_2", result: "success", targetKey: "/foo.ts" }),
      ];
      const linked = linkRecoveries(obs);
      assert.equal(linked[1].recoveryOf, "obs_1");
    });

    it("does not link when targets differ", () => {
      const obs = [
        makeObs({ id: "obs_1", result: "error", targetKey: "/foo.ts" }),
        makeObs({ id: "obs_2", result: "success", targetKey: "/bar.ts" }),
      ];
      const linked = linkRecoveries(obs);
      assert.equal(linked[1].recoveryOf, undefined);
    });

    it("links to most recent matching failure", () => {
      const obs = [
        makeObs({ id: "obs_1", result: "error", targetKey: "/foo.ts" }),
        makeObs({ id: "obs_2", result: "error", targetKey: "/foo.ts" }),
        makeObs({ id: "obs_3", result: "success", targetKey: "/foo.ts" }),
      ];
      const linked = linkRecoveries(obs);
      assert.equal(linked[2].recoveryOf, "obs_2");
    });

    it("does not link error to error", () => {
      const obs = [
        makeObs({ id: "obs_1", result: "error", targetKey: "/foo.ts" }),
        makeObs({ id: "obs_2", result: "error", targetKey: "/foo.ts" }),
      ];
      const linked = linkRecoveries(obs);
      assert.equal(linked[1].recoveryOf, undefined);
    });

    it("does not mutate input array", () => {
      const obs = [
        makeObs({ id: "obs_1", result: "error", targetKey: "/foo.ts" }),
        makeObs({ id: "obs_2", result: "success", targetKey: "/foo.ts" }),
      ];
      const linked = linkRecoveries(obs);
      assert.equal(obs[1].recoveryOf, undefined); // original unchanged
      assert.equal(linked[1].recoveryOf, "obs_1"); // copy has link
    });
  });
});
