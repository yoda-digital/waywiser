import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-perm-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { classifyToolCall, loadPolicy } = jiti("../extensions/permissions.ts") as {
  classifyToolCall: (toolName: string, input: Record<string, unknown>) => string;
  loadPolicy: () => { defaults: Record<string, string>; overrides: Record<string, string>; allowlist: string[] };
};
const { registry_ } = jiti("../extensions/utils/state.ts") as {
  registry_: () => { budget: { maxToolCalls: number; maxSubagentSpawns: number; toolCallCount: number; subagentSpawnCount: number } };
};

describe("classifyToolCall", () => {
  // memory
  test("memory recall → read_only", () => assert.equal(classifyToolCall("memory", { action: "recall" }), "read_only"));
  test("memory list → read_only", () => assert.equal(classifyToolCall("memory", { action: "list" }), "read_only"));
  test("memory stats → read_only", () => assert.equal(classifyToolCall("memory", { action: "stats" }), "read_only"));
  test("memory remember → write_local", () => assert.equal(classifyToolCall("memory", { action: "remember" }), "write_local"));
  test("memory forget → write_local", () => assert.equal(classifyToolCall("memory", { action: "forget" }), "write_local"));
  test("memory no action → read_only", () => assert.equal(classifyToolCall("memory", {}), "read_only"));

  // kanban
  test("kanban list → read_only", () => assert.equal(classifyToolCall("kanban", { action: "list" }), "read_only"));
  test("kanban show → read_only", () => assert.equal(classifyToolCall("kanban", { action: "show" }), "read_only"));
  test("kanban new → write_local", () => assert.equal(classifyToolCall("kanban", { action: "new" }), "write_local"));
  test("kanban assign subagent → process_exec", () => assert.equal(classifyToolCall("kanban", { action: "assign", who: "subagent" }), "process_exec"));
  test("kanban assign human → write_local", () => assert.equal(classifyToolCall("kanban", { action: "assign", who: "alice" }), "write_local"));
  test("kanban wait → read_only", () => assert.equal(classifyToolCall("kanban", { action: "wait" }), "read_only"));

  // soul
  test("soul read → read_only", () => assert.equal(classifyToolCall("soul", { action: "read" }), "read_only"));
  test("soul append → write_local", () => assert.equal(classifyToolCall("soul", { action: "append_preference" }), "write_local"));

  // single-action tools
  test("delegate_task → process_exec", () => assert.equal(classifyToolCall("delegate_task", {}), "process_exec"));
  test("execute_code → process_exec", () => assert.equal(classifyToolCall("execute_code", {}), "process_exec"));
  test("notify → communication", () => assert.equal(classifyToolCall("notify", {}), "communication"));
  test("web_search → network", () => assert.equal(classifyToolCall("web_search", {}), "network"));
  test("web_extract → network", () => assert.equal(classifyToolCall("web_extract", {}), "network"));
  test("skills_list → read_only", () => assert.equal(classifyToolCall("skills_list", {}), "read_only"));
  test("skill_view → read_only", () => assert.equal(classifyToolCall("skill_view", {}), "read_only"));
  test("skill_manage → write_local", () => assert.equal(classifyToolCall("skill_manage", {}), "write_local"));
  test("evolve → read_only", () => assert.equal(classifyToolCall("evolve", {}), "read_only"));
  test("clarify → read_only", () => assert.equal(classifyToolCall("clarify", {}), "read_only"));

  // cronjob
  test("cronjob list → read_only", () => assert.equal(classifyToolCall("cronjob", { action: "list" }), "read_only"));
  test("cronjob quiet → read_only", () => assert.equal(classifyToolCall("cronjob", { action: "quiet" }), "read_only"));
  test("cronjob schedule → scheduling", () => assert.equal(classifyToolCall("cronjob", { action: "schedule" }), "scheduling"));

  // MCP
  test("gmail__list_labels → mcp_read", () => assert.equal(classifyToolCall("gmail__list_labels", {}), "mcp_read"));
  test("gmail__send_message → mcp_write", () => assert.equal(classifyToolCall("gmail__send_message", {}), "mcp_write"));
  test("cal__get_event → mcp_read", () => assert.equal(classifyToolCall("cal__get_event", {}), "mcp_read"));
  test("cal__create_event → mcp_write", () => assert.equal(classifyToolCall("cal__create_event", {}), "mcp_write"));

  // Pi built-ins
  test("bash → read_only", () => assert.equal(classifyToolCall("bash", {}), "read_only"));
  test("read → read_only", () => assert.equal(classifyToolCall("read", {}), "read_only"));
  test("write → write_local", () => assert.equal(classifyToolCall("write", {}), "write_local"));
  test("edit → write_local", () => assert.equal(classifyToolCall("edit", {}), "write_local"));

  // unknown
  test("unknown_tool → write_local", () => assert.equal(classifyToolCall("unknown_tool", {}), "write_local"));
});

describe("loadPolicy", () => {
  test("returns defaults when no file exists", () => {
    const policy = loadPolicy();
    assert.equal(policy.defaults.read_only, "allow");
    assert.equal(policy.defaults.process_exec, "ask_user");
    assert.equal(policy.defaults.communication, "ask_user");
    assert.equal(policy.defaults.write_local, "log_only");
    assert.deepEqual(policy.overrides, {});
    assert.deepEqual(policy.allowlist, []);
  });

  test("merges file overrides with defaults", () => {
    const file = path.join(tmp, "permissions.json");
    fs.writeFileSync(file, JSON.stringify({
      overrides: { notify: "block" },
      allowlist: ["delegate_task"],
    }));
    const policy = loadPolicy();
    assert.equal(policy.overrides.notify, "block");
    assert.ok(policy.allowlist.includes("delegate_task"));
    assert.equal(policy.defaults.read_only, "allow"); // defaults preserved
    fs.unlinkSync(file); // cleanup
  });
});

describe("session budget", () => {
  test("budget exists on registry", () => {
    const b = registry_().budget;
    assert.equal(typeof b.maxToolCalls, "number");
    assert.equal(typeof b.maxSubagentSpawns, "number");
    assert.equal(typeof b.toolCallCount, "number");
    assert.equal(typeof b.subagentSpawnCount, "number");
  });

  test("budget defaults are reasonable", () => {
    const b = registry_().budget;
    assert.ok(b.maxToolCalls >= 100, "maxToolCalls should be >= 100");
    assert.ok(b.maxSubagentSpawns >= 5, "maxSubagentSpawns should be >= 5");
  });
});

describe("planning mode classification", () => {
  test("read_only actions pass in planning mode", () => {
    const readActions = [
      ["memory", { action: "recall" }],
      ["kanban", { action: "list" }],
      ["soul", { action: "read" }],
      ["skills_list", {}],
      ["skill_view", {}],
    ] as const;
    for (const [tool, input] of readActions) {
      const risk = classifyToolCall(tool, input as Record<string, unknown>);
      assert.equal(risk, "read_only", `${tool} should be read_only but got ${risk}`);
    }
  });

  test("write actions would be blocked in planning mode", () => {
    const writeActions = [
      ["memory", { action: "remember" }],
      ["kanban", { action: "new" }],
      ["delegate_task", {}],
      ["notify", {}],
      ["cronjob", { action: "schedule" }],
    ] as const;
    for (const [tool, input] of writeActions) {
      const risk = classifyToolCall(tool, input as Record<string, unknown>);
      assert.notEqual(risk, "read_only", `${tool} should NOT be read_only in planning mode`);
    }
  });
});
