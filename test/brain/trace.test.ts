import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExperienceTrace, observationForLlm } from "../../extensions/brain/trace.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../extensions/brain/config.ts";
import type { Observation } from "../../extensions/brain/types.ts";

describe("ExperienceTrace", () => {
  function makeTrace() {
    return new ExperienceTrace(DEFAULT_BRAIN_CONFIG);
  }

  function mockSessionManager() {
    return {
      getBranch: () => [{ id: "leaf_abc" }],
      getSessionId: () => "session_123",
    };
  }

  it("produces an Experience from tool events", () => {
    const trace = makeTrace();
    trace.beginRun();

    trace.toolCall({ toolCallId: "tc_1", toolName: "read", input: { file_path: "/foo.ts" } });
    trace.toolResult({
      toolCallId: "tc_1", toolName: "read", input: { file_path: "/foo.ts" },
      content: "file content", isError: false,
    });

    trace.turnEnd({ role: "user", content: "Read the file" });
    trace.turnEnd({ role: "assistant", content: "Here is the file content" });

    const exp = trace.finalize({ sessionManager: mockSessionManager(), cwd: "/project" });

    assert.ok(exp.id.startsWith("exp_"));
    assert.equal(exp.sessionId, "session_123");
    assert.equal(exp.observations.length, 1);
    assert.equal(exp.observations[0].tool, "read");
    assert.equal(exp.observations[0].result, "success");
    assert.equal(exp.observations[0].targetKey, "/foo.ts");
    assert.ok(exp.objective.includes("Read the file"));
  });

  it("links recoveries in finalized experience", () => {
    const trace = makeTrace();
    trace.beginRun();

    trace.toolCall({ toolCallId: "tc_1", toolName: "bash", input: { command: "cat /big.json" } });
    trace.toolResult({
      toolCallId: "tc_1", toolName: "bash", input: { command: "cat /big.json" },
      content: "output too large", isError: true,
    });

    trace.toolCall({ toolCallId: "tc_2", toolName: "read", input: { file_path: "/big.json" } });
    trace.toolResult({
      toolCallId: "tc_2", toolName: "read", input: { file_path: "/big.json" },
      content: "file content", isError: false,
    });

    const exp = trace.finalize({ sessionManager: mockSessionManager(), cwd: "/" });
    assert.equal(exp.observations.length, 2);
    assert.equal(exp.observations[1].recoveryOf, exp.observations[0].id);
  });

  it("infers outcome as success when all errors recovered", () => {
    const trace = makeTrace();
    trace.beginRun();

    trace.toolCall({ toolCallId: "tc_1", toolName: "bash", input: { command: "cat /f.ts" } });
    trace.toolResult({ toolCallId: "tc_1", toolName: "bash", input: { command: "cat /f.ts" }, content: "err", isError: true });

    trace.toolCall({ toolCallId: "tc_2", toolName: "read", input: { file_path: "/f.ts" } });
    trace.toolResult({ toolCallId: "tc_2", toolName: "read", input: { file_path: "/f.ts" }, content: "ok", isError: false });

    const exp = trace.finalize({ sessionManager: mockSessionManager(), cwd: "/" });
    assert.equal(exp.outcome.status, "success");
  });

  it("infers outcome as partial when unrecovered errors exist", () => {
    const trace = makeTrace();
    trace.beginRun();

    trace.toolCall({ toolCallId: "tc_1", toolName: "bash", input: { command: "deploy.sh" } });
    trace.toolResult({ toolCallId: "tc_1", toolName: "bash", input: { command: "deploy.sh" }, content: "failed", isError: true });

    trace.toolCall({ toolCallId: "tc_2", toolName: "read", input: { file_path: "/other.ts" } });
    trace.toolResult({ toolCallId: "tc_2", toolName: "read", input: { file_path: "/other.ts" }, content: "ok", isError: false });

    const exp = trace.finalize({ sessionManager: mockSessionManager(), cwd: "/" });
    assert.equal(exp.outcome.status, "partial");
  });

  it("infers unknown outcome when no observations", () => {
    const trace = makeTrace();
    trace.beginRun();
    const exp = trace.finalize({ sessionManager: mockSessionManager(), cwd: "/" });
    assert.equal(exp.outcome.status, "unknown");
  });

  it("tracks recalled memory/procedure IDs", () => {
    const trace = makeTrace();
    trace.beginRun();
    trace.noteRecall({ items: [], memoryIds: [1, 2], procedureIds: ["proc_1"], revision: 1 });

    const exp = trace.finalize({ sessionManager: mockSessionManager(), cwd: "/" });
    assert.deepEqual(exp.recalledMemoryIds, [1, 2]);
    assert.deepEqual(exp.recalledProcedureIds, ["proc_1"]);
  });

  it("uses getBranch for branch leaf", () => {
    const trace = makeTrace();
    trace.beginRun();
    const sm = { getBranch: () => [{ id: "entry_1" }, { id: "entry_2" }, { id: "leaf_xyz" }], getSessionId: () => "s1" };
    const exp = trace.finalize({ sessionManager: sm, cwd: "/" });
    assert.equal(exp.branchLeaf, "leaf_xyz");
  });

  it("clears observations on beginRun", () => {
    const trace = makeTrace();
    trace.beginRun();
    trace.toolCall({ toolCallId: "tc_1", toolName: "read", input: { file_path: "/a.ts" } });
    trace.toolResult({ toolCallId: "tc_1", toolName: "read", input: { file_path: "/a.ts" }, content: "", isError: false });

    trace.beginRun(); // second run
    const exp = trace.finalize({ sessionManager: mockSessionManager(), cwd: "/" });
    assert.equal(exp.observations.length, 0);
  });
});

describe("observationForLlm", () => {
  function makeObs(overrides: Partial<Observation> = {}): Observation {
    return {
      id: "obs_test001",
      toolCallId: "tc_test",
      tool: "read",
      targetKey: "/some/file.ts",
      input: {},
      result: "success",
      provenance: "local_fs",
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it("returns wallClock matching HH:MM or Mon DD, HH:MM", () => {
    const obs = makeObs();
    const row = observationForLlm(obs);
    assert.match(row.wallClock, /^\d{2}:\d{2}$|^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/);
  });

  it("preserves ISO timestamp verbatim", () => {
    const ts = "2026-08-25T10:30:00.000Z";
    const obs = makeObs({ timestamp: ts });
    const row = observationForLlm(obs);
    assert.equal(row.timestamp, ts);
  });

  it("maps id, tool, target, result correctly", () => {
    const obs = makeObs({ id: "obs_abc123", tool: "bash", targetKey: "/proj/run.sh", result: "error" });
    const row = observationForLlm(obs);
    assert.equal(row.id, "obs_abc123");
    assert.equal(row.tool, "bash");
    assert.equal(row.target, "/proj/run.sh");
    assert.equal(row.result, "error");
  });

  it("error and recoveredFrom are undefined when observation has no errorClass/recoveryOf", () => {
    const obs = makeObs();
    const row = observationForLlm(obs);
    assert.equal(row.error, undefined);
    assert.equal(row.recoveredFrom, undefined);
  });

  it("error is present when observation has errorClass", () => {
    const obs = makeObs({ result: "error", errorClass: "not_found" });
    const row = observationForLlm(obs);
    assert.equal(row.error, "not_found");
  });

  it("recoveredFrom is present when observation has recoveryOf", () => {
    const obs = makeObs({ recoveryOf: "obs_earlier001" });
    const row = observationForLlm(obs);
    assert.equal(row.recoveredFrom, "obs_earlier001");
  });

  it("wallClock for a past-day timestamp has date portion", () => {
    // Force a cross-day timestamp: 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const obs = makeObs({ timestamp: twoDaysAgo });
    const row = observationForLlm(obs);
    // Cross-day format: "Mon DD, HH:MM"
    assert.match(row.wallClock, /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/);
  });
});
