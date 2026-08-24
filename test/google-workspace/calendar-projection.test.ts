import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-cal-proj-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

// The projection module uses db_() from waywiser state, which is initialized
// by importing anything from state.ts with WAYWISER_HOME set.
const {
  initProjectionTables,
  getProjectionState,
} = jiti("../../plugins/google-workspace/extensions/calendar/projection.ts") as {
  initProjectionTables: () => void;
  getProjectionState: (account: string) => { lastSuccessAt: string | null; stale: boolean; lastError: string | null } | undefined;
};

const { db_ } = jiti("../../extensions/utils/state.ts") as {
  db_: () => { prepare: (sql: string) => any; exec: (sql: string) => void };
};

// Initialize the projection tables
initProjectionTables();

function insertProjectionRow(overrides?: Record<string, unknown>): void {
  const d = db_();
  const defaults = {
    provider: "google",
    account: "me@example.com",
    calendar_id: "primary",
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    summary: "Test event",
    start_at: "2026-08-25T09:00:00Z",
    end_at: "2026-08-25T10:00:00Z",
    all_day: 0,
    status: "confirmed",
    event_type: "default",
    transparency: "opaque",
    snapshot_id: "snap_test",
    projected_at: new Date().toISOString(),
  };
  const row = { ...defaults, ...overrides };
  d.prepare(
    `INSERT OR REPLACE INTO calendar_projection
     (provider, account, calendar_id, event_id, summary, start_at, end_at,
      all_day, status, event_type, transparency, snapshot_id, projected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.provider, row.account, row.calendar_id, row.event_id, row.summary,
    row.start_at, row.end_at, row.all_day, row.status, row.event_type,
    row.transparency, row.snapshot_id, row.projected_at,
  );
}

function insertProjectionState(account: string, overrides?: Record<string, unknown>): void {
  const d = db_();
  const defaults = {
    provider: "google",
    account,
    last_success_at: new Date().toISOString(),
    last_attempt_at: new Date().toISOString(),
    snapshot_id: "snap_test",
    stale: 0,
    last_error: null,
  };
  const row = { ...defaults, ...overrides };
  d.prepare(
    `INSERT OR REPLACE INTO calendar_projection_state
     (provider, account, last_success_at, last_attempt_at, snapshot_id, stale, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.provider, row.account, row.last_success_at, row.last_attempt_at,
    row.snapshot_id, row.stale, row.last_error);
}

function clearProjection(): void {
  const d = db_();
  d.exec("DELETE FROM calendar_projection; DELETE FROM calendar_projection_state;");
}

function countRows(account: string): number {
  const d = db_();
  const r = d.prepare("SELECT COUNT(*) as c FROM calendar_projection WHERE account = ?").get(account) as { c: number };
  return r.c;
}

function getEventIds(account: string): string[] {
  const d = db_();
  const rows = d.prepare("SELECT event_id FROM calendar_projection WHERE account = ? ORDER BY event_id").all(account) as Array<{ event_id: string }>;
  return rows.map(r => r.event_id);
}

describe("projection schema", () => {
  test("initProjectionTables creates tables (idempotent)", () => {
    // Should not throw on second call
    initProjectionTables();
    const d = db_();
    const rows = d.prepare("SELECT COUNT(*) as c FROM calendar_projection").get() as { c: number };
    assert.equal(typeof rows.c, "number");
    const stateRows = d.prepare("SELECT COUNT(*) as c FROM calendar_projection_state").get() as { c: number };
    assert.equal(typeof stateRows.c, "number");
  });
});

describe("transactional replacement", () => {
  test("inserting events populates projection", () => {
    clearProjection();
    insertProjectionRow({ event_id: "evt1", account: "me@example.com" });
    insertProjectionRow({ event_id: "evt2", account: "me@example.com" });
    assert.equal(countRows("me@example.com"), 2);
  });

  test("replacing snapshot removes old events", () => {
    clearProjection();
    insertProjectionRow({ event_id: "old1", account: "me@example.com", snapshot_id: "snap_old" });
    insertProjectionRow({ event_id: "old2", account: "me@example.com", snapshot_id: "snap_old" });

    // Simulate transactional replacement: delete old, insert new
    const d = db_();
    d.exec("BEGIN");
    d.prepare("DELETE FROM calendar_projection WHERE account = ?").run("me@example.com");
    insertProjectionRow({ event_id: "new1", account: "me@example.com", snapshot_id: "snap_new" });
    d.exec("COMMIT");

    assert.equal(countRows("me@example.com"), 1);
    assert.deepEqual(getEventIds("me@example.com"), ["new1"]);
  });

  test("event disappeared → removed from projection", () => {
    clearProjection();
    insertProjectionRow({ event_id: "evt_a", account: "me@example.com" });
    insertProjectionRow({ event_id: "evt_b", account: "me@example.com" });

    // Next snapshot only has evt_a
    const d = db_();
    d.exec("BEGIN");
    d.prepare("DELETE FROM calendar_projection WHERE account = ?").run("me@example.com");
    insertProjectionRow({ event_id: "evt_a", account: "me@example.com", snapshot_id: "snap_2" });
    d.exec("COMMIT");

    const ids = getEventIds("me@example.com");
    assert.equal(ids.length, 1);
    assert.ok(ids.includes("evt_a"));
    assert.ok(!ids.includes("evt_b"));
  });
});

describe("failure handling", () => {
  test("failure retains last-good snapshot (no delete without new data)", () => {
    clearProjection();
    insertProjectionRow({ event_id: "good_evt", account: "me@example.com" });
    insertProjectionState("me@example.com", { stale: 0 });

    // Simulate failure: just mark stale, don't touch events
    const d = db_();
    d.prepare("UPDATE calendar_projection_state SET stale = 1, last_error = ? WHERE account = ?")
      .run("timeout after 30s", "me@example.com");

    // Events still there
    assert.equal(countRows("me@example.com"), 1);
    assert.deepEqual(getEventIds("me@example.com"), ["good_evt"]);
  });

  test("failure marks stale", () => {
    clearProjection();
    insertProjectionRow({ event_id: "evt1", account: "me@example.com" });
    insertProjectionState("me@example.com", { stale: 0 });

    const d = db_();
    d.prepare("UPDATE calendar_projection_state SET stale = 1, last_error = ? WHERE account = ?")
      .run("network error", "me@example.com");

    const state = getProjectionState("me@example.com");
    assert.ok(state);
    assert.equal(state.stale, true);
    assert.ok(state.lastError?.includes("network error"));
  });

  test("next success clears stale", () => {
    clearProjection();
    insertProjectionState("me@example.com", { stale: 1, last_error: "previous failure" });

    // Successful refresh
    const d = db_();
    d.prepare("DELETE FROM calendar_projection WHERE account = ?").run("me@example.com");
    insertProjectionRow({ event_id: "fresh_evt", account: "me@example.com", snapshot_id: "snap_fresh" });
    d.prepare(
      `INSERT OR REPLACE INTO calendar_projection_state
       (provider, account, last_success_at, last_attempt_at, snapshot_id, stale, last_error)
       VALUES ('google', ?, ?, ?, ?, 0, NULL)`,
    ).run("me@example.com", new Date().toISOString(), new Date().toISOString(), "snap_fresh");

    const state = getProjectionState("me@example.com");
    assert.ok(state);
    assert.equal(state.stale, false);
    assert.equal(state.lastError, null);
  });
});

describe("account isolation", () => {
  test("different accounts have independent projections", () => {
    clearProjection();
    insertProjectionRow({ account: "personal@gmail.com", event_id: "p1" });
    insertProjectionRow({ account: "work@company.com", event_id: "w1" });
    insertProjectionRow({ account: "work@company.com", event_id: "w2" });

    assert.equal(countRows("personal@gmail.com"), 1);
    assert.equal(countRows("work@company.com"), 2);

    // Deleting personal doesn't touch work
    db_().prepare("DELETE FROM calendar_projection WHERE account = ?").run("personal@gmail.com");
    assert.equal(countRows("work@company.com"), 2);
  });
});

describe("calendar isolation", () => {
  test("events from different calendars coexist", () => {
    clearProjection();
    insertProjectionRow({ account: "me@example.com", calendar_id: "primary", event_id: "c1" });
    insertProjectionRow({ account: "me@example.com", calendar_id: "secondary@group.calendar.google.com", event_id: "c2" });

    assert.equal(countRows("me@example.com"), 2);
    const d = db_();
    const calendars = d.prepare("SELECT DISTINCT calendar_id FROM calendar_projection WHERE account = ?")
      .all("me@example.com") as Array<{ calendar_id: string }>;
    assert.equal(calendars.length, 2);
  });
});

describe("query helpers", () => {
  test("query events starting within fixed time window", () => {
    clearProjection();
    // Use fixed times to avoid wall-clock races
    insertProjectionRow({ account: "me@example.com", event_id: "morning", start_at: "2026-08-25T09:00:00Z", end_at: "2026-08-25T10:00:00Z" });
    insertProjectionRow({ account: "me@example.com", event_id: "afternoon", start_at: "2026-08-25T14:00:00Z", end_at: "2026-08-25T15:00:00Z" });
    insertProjectionRow({ account: "me@example.com", event_id: "evening", start_at: "2026-08-25T20:00:00Z", end_at: "2026-08-25T21:00:00Z" });

    const d = db_();
    // Query a fixed 6-hour window
    const inWindow = d.prepare(
      `SELECT event_id FROM calendar_projection
       WHERE account = ? AND start_at >= ? AND start_at < ?`,
    ).all("me@example.com", "2026-08-25T08:00:00Z", "2026-08-25T15:00:00Z") as Array<{ event_id: string }>;

    const ids = inWindow.map(r => r.event_id);
    assert.ok(ids.includes("morning"), "should include morning");
    assert.ok(ids.includes("afternoon"), "should include afternoon");
    assert.ok(!ids.includes("evening"), "should not include evening (outside window)");
  });

  test("query events in time range", () => {
    clearProjection();
    insertProjectionRow({ account: "me@example.com", event_id: "aug25", start_at: "2026-08-25T09:00:00Z", end_at: "2026-08-25T10:00:00Z" });
    insertProjectionRow({ account: "me@example.com", event_id: "aug26", start_at: "2026-08-26T09:00:00Z", end_at: "2026-08-26T10:00:00Z" });
    insertProjectionRow({ account: "me@example.com", event_id: "aug30", start_at: "2026-08-30T09:00:00Z", end_at: "2026-08-30T10:00:00Z" });

    const d = db_();
    const range = d.prepare(
      `SELECT event_id FROM calendar_projection
       WHERE account = ? AND start_at >= ? AND start_at < ?`,
    ).all("me@example.com", "2026-08-25T00:00:00Z", "2026-08-27T00:00:00Z") as Array<{ event_id: string }>;

    const ids = range.map(r => r.event_id);
    assert.ok(ids.includes("aug25"));
    assert.ok(ids.includes("aug26"));
    assert.ok(!ids.includes("aug30"));
  });
});

describe("projection state", () => {
  test("getProjectionState returns undefined for unknown account", () => {
    clearProjection();
    const state = getProjectionState("nonexistent@example.com");
    assert.equal(state, undefined);
  });

  test("getProjectionState returns state for known account", () => {
    clearProjection();
    insertProjectionState("known@example.com", { stale: 0, last_error: null });
    const state = getProjectionState("known@example.com");
    assert.ok(state);
    assert.equal(state.stale, false);
    assert.equal(state.lastError, null);
    assert.ok(state.lastSuccessAt);
  });
});
