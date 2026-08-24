import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-contract-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

const { FakeGogRunner } = jiti("../../plugins/google-workspace/shared/gog-runner.ts") as {
  FakeGogRunner: new () => {
    setResponse(key: string, result: { exitCode: number; stdout: string; stderr: string; durationMs: number }): void;
    run(inv: any): Promise<any>;
  };
};

const { validateContract, clearContractCache } = jiti("../../plugins/google-workspace/shared/gog-contract.ts") as {
  validateContract: (runner: any, binaryPath: string) => Promise<{
    compatible: boolean;
    schemaVersion: number;
    build: string;
    missing: string[];
    commands: Set<string>;
    binaryPath: string;
  }>;
  clearContractCache: () => void;
};

/**
 * Build a valid schema that the contract validator accepts.
 * Uses the nested command tree format that flattenCommands expects:
 * { id: "root", commands: [{ id: "schema" }, { id: "calendar", commands: [...] }] }
 * Flags are { long: "flag-name" } on the root command.
 */
function makeValidSchema(opts?: {
  schema_version?: number;
  build?: string;
  omitCommands?: string[];
  omitFlags?: string[];
}): string {
  const allCalendarCmds = [
    "calendars", "events", "event", "raw", "create", "update", "move", "delete",
    "freebusy", "respond", "colors", "conflicts", "changed", "search", "time",
    "focus-time", "out-of-office", "working-location", "subscribe", "unsubscribe",
    "create-calendar", "delete-calendar", "acl", "propose-time", "users", "team",
  ];
  const aliasCmd = {
    id: "alias",
    commands: [{ id: "list" }, { id: "set" }, { id: "unset" }].filter(
      c => !(opts?.omitCommands ?? []).includes(`calendar.alias.${c.id}`)
    ),
  };

  const calendarChildren = allCalendarCmds
    .filter(id => !(opts?.omitCommands ?? []).includes(`calendar.${id}`))
    .map(id => ({ id }));

  // Only add alias if not all sub-commands were omitted
  if (aliasCmd.commands.length > 0) calendarChildren.push(aliasCmd as any);

  const allFlags = ["json", "no-input", "readonly", "wrap-untrusted", "enable-commands-exact", "dry-run"]
    .filter(f => !(opts?.omitFlags ?? []).includes(f));

  const schemaCommands: any[] = [];
  if (!(opts?.omitCommands ?? []).includes("schema")) {
    schemaCommands.push({ id: "schema" });
  }
  schemaCommands.push({ id: "calendar", commands: calendarChildren });

  return JSON.stringify({
    schema_version: opts?.schema_version ?? 1,
    build: opts?.build ?? "v0.37.0 (test)",
    command: {
      name: "",
      flags: allFlags.map(f => ({ long: f })),
      commands: schemaCommands,
    },
  });
}

describe("validateContract", () => {
  test("valid schema → compatible=true, missing=[]", async () => {
    clearContractCache();
    const runner = new FakeGogRunner();
    runner.setResponse("schema --json", {
      exitCode: 0, stdout: makeValidSchema(), stderr: "", durationMs: 10,
    });
    const result = await validateContract(runner, "/tmp/fake-gog");
    assert.equal(result.compatible, true);
    assert.deepEqual(result.missing, []);
    assert.equal(result.schemaVersion, 1);
    assert.ok(result.build.includes("v0.37.0"));
  });

  test("schema_version !== 1 → incompatible", async () => {
    clearContractCache();
    const runner = new FakeGogRunner();
    runner.setResponse("schema --json", {
      exitCode: 0, stdout: makeValidSchema({ schema_version: 2 }), stderr: "", durationMs: 10,
    });
    const result = await validateContract(runner, "/tmp/fake-v2");
    assert.equal(result.compatible, false);
    assert.ok(result.missing.some(m => m.includes("schema_version")));
  });

  test("missing required command → listed in missing", async () => {
    clearContractCache();
    const runner = new FakeGogRunner();
    runner.setResponse("schema --json", {
      exitCode: 0, stdout: makeValidSchema({ omitCommands: ["calendar.freebusy"] }), stderr: "", durationMs: 10,
    });
    const result = await validateContract(runner, "/tmp/fake-nocmd");
    assert.equal(result.compatible, false);
    assert.ok(result.missing.some(m => m.includes("calendar.freebusy")));
  });

  test("missing required flag → listed in missing", async () => {
    clearContractCache();
    const runner = new FakeGogRunner();
    runner.setResponse("schema --json", {
      exitCode: 0, stdout: makeValidSchema({ omitFlags: ["readonly"] }), stderr: "", durationMs: 10,
    });
    const result = await validateContract(runner, "/tmp/fake-noflag");
    assert.equal(result.compatible, false);
    assert.ok(result.missing.some(m => m.includes("--readonly")));
  });

  test("schema parse error → incompatible", async () => {
    clearContractCache();
    const runner = new FakeGogRunner();
    runner.setResponse("schema --json", {
      exitCode: 0, stdout: "NOT VALID JSON {{{{", stderr: "", durationMs: 10,
    });
    const result = await validateContract(runner, "/tmp/fake-badjson");
    assert.equal(result.compatible, false);
    assert.ok(result.missing.some(m => m.includes("JSON")));
  });

  test("gog not found (non-zero exit) → incompatible", async () => {
    clearContractCache();
    const runner = new FakeGogRunner();
    runner.setResponse("schema --json", {
      exitCode: 1, stdout: "", stderr: "command not found", durationMs: 10,
    });
    const result = await validateContract(runner, "/tmp/no-gog");
    assert.equal(result.compatible, false);
    assert.ok(result.missing.some(m => m.includes("failed")));
  });

  test("multiple missing items are all listed", async () => {
    clearContractCache();
    const runner = new FakeGogRunner();
    runner.setResponse("schema --json", {
      exitCode: 0,
      stdout: makeValidSchema({ omitCommands: ["calendar.freebusy", "calendar.respond"], omitFlags: ["dry-run"] }),
      stderr: "", durationMs: 10,
    });
    const result = await validateContract(runner, "/tmp/fake-multi");
    assert.equal(result.compatible, false);
    assert.ok(result.missing.length >= 3);
    assert.ok(result.missing.some(m => m.includes("calendar.freebusy")));
    assert.ok(result.missing.some(m => m.includes("calendar.respond")));
    assert.ok(result.missing.some(m => m.includes("--dry-run")));
  });
});

describe("required commands", () => {
  test("a schema with NO commands lists all required as missing", async () => {
    clearContractCache();
    const runner = new FakeGogRunner();
    runner.setResponse("schema --json", {
      exitCode: 0,
      stdout: JSON.stringify({ schema_version: 1, build: "test", command: { name: "" } }),
      stderr: "", durationMs: 10,
    });
    const result = await validateContract(runner, "/tmp/empty-cmds");
    assert.ok(result.missing.some(m => m.includes("calendar.events")));
    assert.ok(result.missing.some(m => m.includes("calendar.create")));
    assert.ok(result.missing.some(m => m.includes("calendar.delete")));
    assert.ok(result.missing.some(m => m.includes("schema")));
  });
});

describe("required global flags", () => {
  test("a schema with NO flags lists all required as missing", async () => {
    clearContractCache();
    const runner = new FakeGogRunner();
    runner.setResponse("schema --json", {
      exitCode: 0,
      stdout: JSON.stringify({ schema_version: 1, build: "test", command: { name: "", flags: [] } }),
      stderr: "", durationMs: 10,
    });
    const result = await validateContract(runner, "/tmp/empty-flags");
    assert.ok(result.missing.some(m => m.includes("--json")));
    assert.ok(result.missing.some(m => m.includes("--readonly")));
    assert.ok(result.missing.some(m => m.includes("--no-input")));
    assert.ok(result.missing.some(m => m.includes("--wrap-untrusted")));
    assert.ok(result.missing.some(m => m.includes("--enable-commands-exact")));
    assert.ok(result.missing.some(m => m.includes("--dry-run")));
  });
});
