import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-cal-err-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

const {
  mapExitCode,
  toCalendarError,
  isRetryable,
  isAuthError,
} = jiti("../../plugins/google-workspace/shared/gog-errors.ts") as {
  mapExitCode: (code: number) => string;
  toCalendarError: (exitCode: number, stderr: string) => { code: string; message: string; exitCode?: number; stderr?: string };
  isRetryable: (code: string) => boolean;
  isAuthError: (code: string) => boolean;
};

describe("mapExitCode", () => {
  test("0 → success", () => assert.equal(mapExitCode(0), "success"));
  test("2 → invalid_input", () => assert.equal(mapExitCode(2), "invalid_input"));
  test("3 → empty_results", () => assert.equal(mapExitCode(3), "empty_results"));
  test("4 → auth_required", () => assert.equal(mapExitCode(4), "auth_required"));
  test("5 → not_found", () => assert.equal(mapExitCode(5), "not_found"));
  test("6 → permission_denied", () => assert.equal(mapExitCode(6), "permission_denied"));
  test("7 → rate_limited", () => assert.equal(mapExitCode(7), "rate_limited"));
  test("8 → retryable", () => assert.equal(mapExitCode(8), "retryable"));
  test("10 → config", () => assert.equal(mapExitCode(10), "config"));
  test("130 → cancelled", () => assert.equal(mapExitCode(130), "cancelled"));
  test("1 → unknown", () => assert.equal(mapExitCode(1), "unknown"));
  test("any other code → unknown", () => {
    assert.equal(mapExitCode(9), "unknown");
    assert.equal(mapExitCode(127), "unknown");
    assert.equal(mapExitCode(255), "unknown");
    assert.equal(mapExitCode(-1), "unknown");
    assert.equal(mapExitCode(42), "unknown");
  });
});

describe("isRetryable", () => {
  test("retryable is retryable", () => assert.equal(isRetryable("retryable"), true));
  test("rate_limited is retryable", () => assert.equal(isRetryable("rate_limited"), true));
  test("auth_required is NOT retryable", () => assert.equal(isRetryable("auth_required"), false));
  test("not_found is NOT retryable", () => assert.equal(isRetryable("not_found"), false));
  test("success is NOT retryable", () => assert.equal(isRetryable("success"), false));
  test("unknown is NOT retryable", () => assert.equal(isRetryable("unknown"), false));
  test("cancelled is NOT retryable", () => assert.equal(isRetryable("cancelled"), false));
  test("config is NOT retryable", () => assert.equal(isRetryable("config"), false));
  test("permission_denied is NOT retryable", () => assert.equal(isRetryable("permission_denied"), false));
  test("invalid_input is NOT retryable", () => assert.equal(isRetryable("invalid_input"), false));
});

describe("isAuthError", () => {
  test("auth_required is auth error", () => assert.equal(isAuthError("auth_required"), true));
  test("permission_denied is auth error", () => assert.equal(isAuthError("permission_denied"), true));
  test("not_found is NOT auth error", () => assert.equal(isAuthError("not_found"), false));
  test("retryable is NOT auth error", () => assert.equal(isAuthError("retryable"), false));
  test("success is NOT auth error", () => assert.equal(isAuthError("success"), false));
  test("unknown is NOT auth error", () => assert.equal(isAuthError("unknown"), false));
});

describe("toCalendarError", () => {
  test("constructs from exit code and stderr", () => {
    const err = toCalendarError(4, "oauth token expired\nplease re-auth\n");
    assert.equal(err.code, "auth_required");
    assert.equal(err.message, "oauth token expired");
    assert.equal(err.exitCode, 4);
    assert.ok(err.stderr?.includes("please re-auth"));
  });

  test("uses exit code in message when stderr is empty", () => {
    const err = toCalendarError(7, "");
    assert.equal(err.code, "rate_limited");
    assert.ok(err.message.includes("7"));
  });

  test("unknown exit code produces unknown error", () => {
    const err = toCalendarError(42, "something went wrong");
    assert.equal(err.code, "unknown");
    assert.equal(err.message, "something went wrong");
    assert.equal(err.exitCode, 42);
  });
});
