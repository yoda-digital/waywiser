import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-cal-idemp-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

// The actual API exports: generateEventId, hashPayload, initIdempotencyTable,
// findExistingOperation, logOperation, updateOperationState
const {
  generateEventId,
  hashPayload,
  initIdempotencyTable,
  findExistingOperation,
  logOperation,
  updateOperationState,
} = jiti("../../plugins/google-workspace/extensions/calendar/idempotency.ts") as {
  generateEventId: () => string;
  hashPayload: (payload: Record<string, unknown>) => string;
  initIdempotencyTable: () => void;
  findExistingOperation: (action: string, account: string, calendarId: string, payloadHash: string) =>
    { operation_id: string; action: string; account: string; calendar_id: string; event_id: string | null; payload_hash: string; state: string; result_event_id: string | null; ambiguous_success: number; created_at: string } | undefined;
  logOperation: (record: {
    operationId: string; action: string; account: string; calendarId: string;
    eventId: string | null; payloadHash: string; state: string;
    resultEventId?: string | null; ambiguousSuccess?: boolean;
  }) => void;
  updateOperationState: (operationId: string, state: string, resultEventId?: string | null, ambiguousSuccess?: boolean) => void;
};

// Initialize the idempotency table (uses the shared db_() from state.ts)
initIdempotencyTable();

describe("generateEventId", () => {
  test("produces a base32hex string of >= 5 characters", () => {
    const id = generateEventId();
    assert.ok(id.length >= 5, `Expected >= 5 chars, got ${id.length}: "${id}"`);
    assert.ok(/^[0-9a-v]+$/.test(id), `Not valid base32hex: "${id}"`);
  });

  test("produces unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateEventId());
    assert.equal(ids.size, 100, "100 event IDs should all be unique");
  });

  test("ID length is within Google limits (5-1024)", () => {
    const id = generateEventId();
    assert.ok(id.length >= 5 && id.length <= 1024, `Length ${id.length} outside 5-1024`);
  });
});

describe("hashPayload", () => {
  test("same payload → same hash", () => {
    const a = hashPayload({ summary: "Test", from: "2026-08-25" });
    const b = hashPayload({ summary: "Test", from: "2026-08-25" });
    assert.equal(a, b);
  });

  test("different payload → different hash", () => {
    const a = hashPayload({ summary: "Test A" });
    const b = hashPayload({ summary: "Test B" });
    assert.notEqual(a, b);
  });

  test("key order doesn't matter (stable sorting)", () => {
    const a = hashPayload({ summary: "Test", from: "2026-08-25" });
    const b = hashPayload({ from: "2026-08-25", summary: "Test" });
    assert.equal(a, b);
  });

  test("returns a hex string", () => {
    const h = hashPayload({ x: 1 });
    assert.ok(/^[0-9a-f]+$/.test(h));
    assert.equal(h.length, 32);
  });
});

describe("operation journal", () => {
  test("logOperation + findExistingOperation round-trip", () => {
    const opId = `testop_${Date.now()}`;
    const ph = hashPayload({ summary: "Meeting" });

    logOperation({
      operationId: opId,
      action: "create",
      account: "me@example.com",
      calendarId: "primary",
      eventId: null,
      payloadHash: ph,
      state: "pending",
    });

    const found = findExistingOperation("create", "me@example.com", "primary", ph);
    assert.ok(found);
    assert.equal(found.operation_id, opId);
    assert.equal(found.action, "create");
    assert.equal(found.account, "me@example.com");
    assert.equal(found.calendar_id, "primary");
    assert.equal(found.payload_hash, ph);
    assert.equal(found.state, "pending");
    assert.ok(found.created_at);
  });

  test("updateOperationState changes state", () => {
    const opId = `testop_upd_${Date.now()}`;
    const ph = hashPayload({ summary: "Update test" });

    logOperation({
      operationId: opId,
      action: "create",
      account: "me@example.com",
      calendarId: "primary",
      eventId: null,
      payloadHash: ph,
      state: "pending",
    });

    updateOperationState(opId, "success", "google_evt_abc");

    const found = findExistingOperation("create", "me@example.com", "primary", ph);
    assert.ok(found);
    assert.equal(found.state, "success");
    assert.equal(found.result_event_id, "google_evt_abc");
  });

  test("updateOperationState can mark failed", () => {
    const opId = `testop_fail_${Date.now()}`;
    const ph = hashPayload({ summary: "Fail test" });

    logOperation({
      operationId: opId,
      action: "create",
      account: "me@example.com",
      calendarId: "primary",
      eventId: null,
      payloadHash: ph,
      state: "pending",
    });

    updateOperationState(opId, "failed");

    const found = findExistingOperation("create", "me@example.com", "primary", ph);
    assert.ok(found);
    assert.equal(found.state, "failed");
  });

  test("findExistingOperation returns undefined for no match", () => {
    const found = findExistingOperation("create", "nobody@example.com", "primary", "nonexistenthash");
    assert.equal(found, undefined);
  });

  test("retry detection — same payload hash finds existing operation", () => {
    const ph = hashPayload({ summary: "Retry detect" });
    const opId = `testop_retry_${Date.now()}`;

    logOperation({
      operationId: opId,
      action: "create",
      account: "retry@example.com",
      calendarId: "primary",
      eventId: null,
      payloadHash: ph,
      state: "pending",
    });

    // A retry attempt with same payload should find the existing pending op
    const existing = findExistingOperation("create", "retry@example.com", "primary", ph);
    assert.ok(existing, "retry should find the existing pending operation");
    assert.equal(existing.state, "pending");
    assert.equal(existing.operation_id, opId);
  });

  test("ambiguous_success flag is stored", () => {
    const opId = `testop_ambig_${Date.now()}`;
    const ph = hashPayload({ summary: "Ambiguous" });

    logOperation({
      operationId: opId,
      action: "create",
      account: "me@example.com",
      calendarId: "primary",
      eventId: null,
      payloadHash: ph,
      state: "pending",
    });

    updateOperationState(opId, "success", "evt_xyz", true);

    const found = findExistingOperation("create", "me@example.com", "primary", ph);
    assert.ok(found);
    assert.equal(found.ambiguous_success, 1);
  });
});
