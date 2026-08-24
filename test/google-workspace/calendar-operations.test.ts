import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-cal-ops-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

const {
  CALENDAR_OPERATIONS,
  ALL_MANIFEST_ACTIONS,
  getOperationSpec,
} = jiti("../../plugins/google-workspace/extensions/calendar/operations.ts") as {
  CALENDAR_OPERATIONS: Record<string, {
    action: string;
    gogCommand: string[];
    exactCommand: string;
    risk: string;
    mode: string;
    readonly: boolean;
    wrapUntrusted: boolean;
    requiresAuth: boolean;
    requiresWriteReady: boolean;
    supportsDryRun: boolean;
    timeoutMs: number;
  }>;
  ALL_MANIFEST_ACTIONS: string[];
  getOperationSpec: (action: string) => {
    action: string;
    gogCommand: string[];
    exactCommand: string;
    risk: string;
    mode: string;
    readonly: boolean;
    wrapUntrusted: boolean;
    requiresAuth: boolean;
    requiresWriteReady: boolean;
    supportsDryRun: boolean;
    timeoutMs: number;
  } | undefined;
};

// Blueprint §13 — complete risk mapping table (excluding "status" which is a meta-action)
const EXPECTED_RISK: Record<string, string> = {
  calendars: "read_only",
  acl: "read_only",
  alias_list: "read_only",
  events: "read_only",
  event: "read_only",
  event_raw: "read_only",
  freebusy: "read_only",
  propose_time: "read_only",
  colors: "read_only",
  conflicts: "read_only",
  changed: "read_only",
  search: "read_only",
  time: "read_only",
  users: "read_only",
  team: "read_only",
  alias_set: "write_local",
  alias_unset: "write_local",
  subscribe: "scheduling",
  unsubscribe: "scheduling",
  create_calendar: "scheduling",
  delete_calendar: "scheduling",
  create: "scheduling",
  update: "scheduling",
  move: "scheduling",
  delete: "scheduling",
  focus_time: "scheduling",
  out_of_office: "scheduling",
  working_location: "scheduling",
  respond: "communication",
};

describe("CALENDAR_OPERATIONS manifest", () => {
  test("every ALL_MANIFEST_ACTIONS entry exists in manifest", () => {
    for (const action of ALL_MANIFEST_ACTIONS) {
      assert.ok(
        CALENDAR_OPERATIONS[action] !== undefined,
        `Action "${action}" missing from CALENDAR_OPERATIONS`,
      );
    }
  });

  test("every manifest entry has a matching action field", () => {
    for (const [key, spec] of Object.entries(CALENDAR_OPERATIONS)) {
      assert.equal(spec.action, key, `action field mismatch for ${key}`);
    }
  });

  test("every operation has expected risk class", () => {
    for (const [action, expectedRisk] of Object.entries(EXPECTED_RISK)) {
      const spec = CALENDAR_OPERATIONS[action];
      assert.ok(spec, `Missing operation for ${action}`);
      assert.equal(spec.risk, expectedRisk, `${action}: expected risk=${expectedRisk}, got ${spec.risk}`);
    }
  });

  test("every operation has a non-empty exact gog command", () => {
    for (const [key, spec] of Object.entries(CALENDAR_OPERATIONS)) {
      assert.ok(spec.gogCommand.length > 0, `${key} has empty gogCommand`);
      assert.ok(spec.exactCommand.length > 0, `${key} has empty exactCommand`);
    }
  });

  test("every operation has timeout > 0", () => {
    for (const [key, spec] of Object.entries(CALENDAR_OPERATIONS)) {
      assert.ok(spec.timeoutMs > 0, `${key} has timeoutMs=${spec.timeoutMs}`);
    }
  });

  test("every operation has auth/readiness metadata", () => {
    for (const [key, spec] of Object.entries(CALENDAR_OPERATIONS)) {
      assert.equal(typeof spec.requiresAuth, "boolean", `${key} missing requiresAuth`);
      assert.equal(typeof spec.requiresWriteReady, "boolean", `${key} missing requiresWriteReady`);
    }
  });

  test("read operations are all readonly=true", () => {
    for (const [action, risk] of Object.entries(EXPECTED_RISK)) {
      if (risk !== "read_only") continue;
      const spec = CALENDAR_OPERATIONS[action];
      if (spec && spec.mode === "read") {
        assert.equal(spec.readonly, true, `${action} should be readonly=true`);
      }
    }
  });

  test("remote write operations are readonly=false", () => {
    for (const [action, risk] of Object.entries(EXPECTED_RISK)) {
      if (risk !== "scheduling" && risk !== "communication") continue;
      const spec = CALENDAR_OPERATIONS[action];
      if (spec && spec.mode === "remote_write") {
        assert.equal(spec.readonly, false, `${action} should be readonly=false`);
      }
    }
  });

  test("status is a meta-action not in manifest, getOperationSpec returns undefined", () => {
    assert.equal(getOperationSpec("status"), undefined);
  });

  test("local_write operations are write_local risk", () => {
    for (const action of ["alias_set", "alias_unset"]) {
      const spec = CALENDAR_OPERATIONS[action];
      assert.ok(spec, `Missing ${action}`);
      assert.equal(spec.mode, "local_write");
      assert.equal(spec.risk, "write_local");
    }
  });

  test("gogCommand array matches exactCommand dot notation", () => {
    for (const [key, spec] of Object.entries(CALENDAR_OPERATIONS)) {
      const expected = spec.gogCommand.join(".");
      assert.equal(spec.exactCommand, expected, `${key}: gogCommand ${JSON.stringify(spec.gogCommand)} doesn't match exactCommand "${spec.exactCommand}"`);
    }
  });

  test("wrapUntrusted is true for operations that read external content", () => {
    const externalContentOps = ["events", "event", "event_raw", "search", "changed", "freebusy", "conflicts", "team"];
    for (const action of externalContentOps) {
      const spec = CALENDAR_OPERATIONS[action];
      if (spec) {
        assert.equal(spec.wrapUntrusted, true, `${action} should have wrapUntrusted=true`);
      }
    }
  });
});
