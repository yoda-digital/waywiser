import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-cal-safe-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

const { buildGogInvocation } = jiti("../../plugins/google-workspace/extensions/calendar/invocation.ts") as {
  buildGogInvocation: (
    spec: {
      gogCommand: string[];
      exactCommand: string;
      readonly: boolean;
      wrapUntrusted: boolean;
      timeoutMs: number;
    },
    account: string | undefined,
    operationArgs: string[],
  ) => {
    command: string[];
    account?: string;
    readonly: boolean;
    noInput: boolean;
    wrapUntrusted: boolean;
    exactCommands: string[];
    timeoutMs: number;
  };
};

const { CALENDAR_OPERATIONS } = jiti("../../plugins/google-workspace/extensions/calendar/operations.ts") as {
  CALENDAR_OPERATIONS: Record<string, {
    action: string;
    gogCommand: string[];
    exactCommand: string;
    risk: string;
    mode: string;
    readonly: boolean;
    wrapUntrusted: boolean;
    timeoutMs: number;
  }>;
};

// Identify all read operations
const READ_OPERATIONS = Object.entries(CALENDAR_OPERATIONS)
  .filter(([, spec]) => spec.mode === "read")
  .map(([action, spec]) => ({ action, spec }));

// Identify all write operations that touch Google (remote_write)
const WRITE_OPERATIONS = Object.entries(CALENDAR_OPERATIONS)
  .filter(([, spec]) => spec.mode === "remote_write")
  .map(([action, spec]) => ({ action, spec }));

describe("read path defense-in-depth", () => {
  for (const { action, spec } of READ_OPERATIONS) {
    describe(`${action}`, () => {
      const invocation = buildGogInvocation(spec, "user@example.com", []);

      test("includes --readonly", () => {
        assert.ok(invocation.command.includes("--readonly"), `${action}: missing --readonly`);
        assert.equal(invocation.readonly, true);
      });

      test("includes --no-input", () => {
        assert.ok(invocation.command.includes("--no-input"), `${action}: missing --no-input`);
        assert.equal(invocation.noInput, true);
      });

      test("includes --json", () => {
        assert.ok(invocation.command.includes("--json"), `${action}: missing --json`);
      });

      test("includes --enable-commands-exact with correct command", () => {
        const ecFlag = invocation.command.find((a) => a.startsWith("--enable-commands-exact="));
        assert.ok(ecFlag, `${action}: missing --enable-commands-exact`);
        assert.ok(ecFlag!.includes(spec.exactCommand), `${action}: --enable-commands-exact doesn't include ${spec.exactCommand}`);
        assert.ok(ecFlag!.includes("schema"), `${action}: --enable-commands-exact doesn't include schema`);
      });

      if (spec.wrapUntrusted) {
        test("includes --wrap-untrusted", () => {
          assert.ok(invocation.command.includes("--wrap-untrusted"), `${action}: missing --wrap-untrusted`);
          assert.equal(invocation.wrapUntrusted, true);
        });
      }
    });
  }
});

describe("read exact allowlist cannot include write commands", () => {
  const writeExactCommands = WRITE_OPERATIONS.map(({ spec }) => spec.exactCommand);

  for (const { action, spec } of READ_OPERATIONS) {
    test(`${action} allowlist excludes write commands`, () => {
      const invocation = buildGogInvocation(spec, "user@example.com", []);
      for (const writeCmd of writeExactCommands) {
        assert.ok(
          !invocation.exactCommands.includes(writeCmd),
          `${action}: exactCommands should not include ${writeCmd}`,
        );
      }
    });
  }
});

describe("account is always explicit when resolved", () => {
  test("account appears as --account flag when provided", () => {
    const spec = CALENDAR_OPERATIONS.events;
    assert.ok(spec);
    const invocation = buildGogInvocation(spec, "me@work.com", ["--from", "today"]);
    assert.ok(invocation.command.includes("--account"), "missing --account flag");
    const accountIdx = invocation.command.indexOf("--account");
    assert.equal(invocation.command[accountIdx + 1], "me@work.com");
    assert.equal(invocation.account, "me@work.com");
  });

  test("account is omitted when not resolved (undefined)", () => {
    const spec = CALENDAR_OPERATIONS.colors;
    assert.ok(spec);
    const invocation = buildGogInvocation(spec, undefined, []);
    assert.ok(!invocation.command.includes("--account"), "--account should not appear when account is undefined");
    assert.equal(invocation.account, undefined);
  });
});

describe("write operations do NOT have --readonly", () => {
  for (const { action, spec } of WRITE_OPERATIONS) {
    test(`${action} does not include --readonly`, () => {
      const invocation = buildGogInvocation(spec, "user@example.com", []);
      assert.ok(!invocation.command.includes("--readonly"), `${action}: should NOT have --readonly`);
      assert.equal(invocation.readonly, false);
    });
  }
});

describe("write operations still have --no-input and --json", () => {
  for (const { action, spec } of WRITE_OPERATIONS) {
    test(`${action} has --no-input and --json`, () => {
      const invocation = buildGogInvocation(spec, "user@example.com", []);
      assert.ok(invocation.command.includes("--no-input"), `${action}: missing --no-input`);
      assert.ok(invocation.command.includes("--json"), `${action}: missing --json`);
    });
  }
});

describe("--enable-commands=calendar is NOT used (too broad)", () => {
  for (const { action, spec } of [...READ_OPERATIONS, ...WRITE_OPERATIONS]) {
    test(`${action} uses --enable-commands-exact, not --enable-commands`, () => {
      const invocation = buildGogInvocation(spec, "user@example.com", []);
      const broadFlag = invocation.command.find(
        (a) => a.startsWith("--enable-commands="),
      );
      assert.equal(broadFlag, undefined, `${action}: must use --enable-commands-exact, found --enable-commands`);
    });
  }
});
