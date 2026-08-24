import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-gog-runner-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { FakeGogRunner, ProductionGogRunner } = jiti("../../plugins/google-workspace/shared/gog-runner.ts") as {
	FakeGogRunner: new () => {
		invocations: Array<{ command: string[]; account?: string; readonly?: boolean; noInput?: boolean; wrapUntrusted?: boolean; exactCommands: string[]; timeoutMs: number }>;
		setResponse(commandKey: string, result: { exitCode: number; stdout: string; stderr: string; durationMs: number }): void;
		setDefaultResponse(result: { exitCode: number; stdout: string; stderr: string; durationMs: number }): void;
		run(invocation: { command: string[]; account?: string; readonly?: boolean; noInput?: boolean; wrapUntrusted?: boolean; exactCommands: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
	};
	ProductionGogRunner: new (opts?: { binary?: string; stdoutCap?: number; stderrCap?: number }) => {
		run(invocation: { command: string[]; exactCommands: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
	};
};

describe("FakeGogRunner", () => {
	test("records invocations", async () => {
		const runner = new FakeGogRunner();
		const invocation = {
			command: ["calendar", "events", "--json"],
			account: "me@example.com",
			readonly: true,
			noInput: true,
			wrapUntrusted: true,
			exactCommands: ["schema", "calendar.events"],
			timeoutMs: 30_000,
		};
		await runner.run(invocation);
		assert.equal(runner.invocations.length, 1);
		assert.deepEqual(runner.invocations[0].command, ["calendar", "events", "--json"]);
		assert.equal(runner.invocations[0].account, "me@example.com");
	});

	test("returns canned response for matching command key", async () => {
		const runner = new FakeGogRunner();
		// setResponse takes a string key which is command.join(" ")
		runner.setResponse("calendar events --from today", {
			exitCode: 0,
			stdout: JSON.stringify([{ id: "evt1", summary: "Test" }]),
			stderr: "",
			durationMs: 10,
		});

		const result = await runner.run({
			command: ["calendar", "events", "--from", "today"],
			exactCommands: ["schema", "calendar.events"],
			timeoutMs: 30_000,
		});
		assert.equal(result.exitCode, 0);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed[0].id, "evt1");
	});

	test("returns default response for unmatched command", async () => {
		const runner = new FakeGogRunner();
		// Default response is exitCode: 0, stdout: "{}"
		const result = await runner.run({
			command: ["calendar", "delete", "primary", "evt1"],
			exactCommands: ["schema", "calendar.delete"],
			timeoutMs: 30_000,
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout, "{}");
	});

	test("custom default response via setDefaultResponse", async () => {
		const runner = new FakeGogRunner();
		runner.setDefaultResponse({ exitCode: 1, stdout: "", stderr: "error", durationMs: 5 });
		const result = await runner.run({
			command: ["calendar", "delete", "primary", "evt1"],
			exactCommands: ["schema", "calendar.delete"],
			timeoutMs: 30_000,
		});
		assert.equal(result.exitCode, 1);
		assert.equal(result.stdout, "");
	});

	test("command remains array — not joined as string", async () => {
		const runner = new FakeGogRunner();
		await runner.run({
			command: ["calendar", "events", "--query", "with spaces; rm -rf /"],
			exactCommands: ["schema", "calendar.events"],
			timeoutMs: 30_000,
		});
		assert.ok(Array.isArray(runner.invocations[0].command));
		assert.equal(runner.invocations[0].command.length, 4);
		assert.equal(runner.invocations[0].command[3], "with spaces; rm -rf /");
	});

	test("duration is tracked", async () => {
		const runner = new FakeGogRunner();
		const result = await runner.run({
			command: ["calendar", "time"],
			exactCommands: ["schema", "calendar.time"],
			timeoutMs: 30_000,
		});
		assert.equal(typeof result.durationMs, "number");
		assert.ok(result.durationMs >= 0);
	});

	test("multiple canned responses matched by exact command string", async () => {
		const runner = new FakeGogRunner();
		runner.setResponse("calendar events", {
			exitCode: 0,
			stdout: '{"events":[]}',
			stderr: "",
			durationMs: 10,
		});
		runner.setResponse("calendar create primary", {
			exitCode: 0,
			stdout: '{"id":"new1"}',
			stderr: "",
			durationMs: 10,
		});
		runner.setResponse("schema --json", {
			exitCode: 0,
			stdout: '{"schema_version":1}',
			stderr: "",
			durationMs: 10,
		});

		const eventsResult = await runner.run({
			command: ["calendar", "events"],
			exactCommands: ["calendar.events"],
			timeoutMs: 30_000,
		});
		assert.equal(eventsResult.exitCode, 0);

		const createResult = await runner.run({
			command: ["calendar", "create", "primary"],
			exactCommands: ["calendar.create"],
			timeoutMs: 30_000,
		});
		assert.equal(createResult.exitCode, 0);
		assert.ok(createResult.stdout.includes("new1"));

		const schemaResult = await runner.run({
			command: ["schema", "--json"],
			exactCommands: ["schema"],
			timeoutMs: 10_000,
		});
		assert.equal(schemaResult.exitCode, 0);
		assert.ok(schemaResult.stdout.includes("schema_version"));
	});
});

describe("ProductionGogRunner env sanitization", () => {
	// sanitizeEnv is a private method, so we test its behavior indirectly
	// by checking that ProductionGogRunner construction succeeds and
	// that the runner properly removes env vars via spawn behavior.
	// We cannot unit-test private methods directly, but the safety contract
	// is covered by the fact that: spawn(binary, argv, { env: sanitizedEnv })
	// is called with shell:false and the env filtering logic.

	test("can be constructed with defaults", () => {
		const runner = new ProductionGogRunner();
		assert.ok(runner);
	});

	test("can be constructed with custom binary and caps", () => {
		const runner = new ProductionGogRunner({
			binary: "/usr/local/bin/gog",
			stdoutCap: 1024,
			stderrCap: 512,
		});
		assert.ok(runner);
	});

	test("GOG_ACCESS_TOKEN is never passed to the child process", async () => {
		process.env.GOG_ACCESS_TOKEN = "should-not-leak";
		delete process.env.GOG_KEYRING_PASSWORD;
		const probe = path.join(tmp, "probe-env.js");
		fs.writeFileSync(
			probe,
			"console.log(JSON.stringify({ token: process.env.GOG_ACCESS_TOKEN ?? null, keyring: process.env.GOG_KEYRING_PASSWORD ?? null }));",
		);
		const runner = new ProductionGogRunner({ binary: process.execPath });
		const result = await runner.run({
			command: [probe],
			exactCommands: ["probe"],
			timeoutMs: 10_000,
		});
		assert.equal(result.exitCode, 0);
		const envSeen = JSON.parse(result.stdout.trim());
		assert.equal(envSeen.token, null, "GOG_ACCESS_TOKEN must be stripped");
		delete process.env.GOG_ACCESS_TOKEN;
	});

	test("GOG_KEYRING_PASSWORD is injected from ~/.waywiser/.gog-keyring-password", async () => {
		delete process.env.GOG_KEYRING_PASSWORD;
		fs.writeFileSync(path.join(tmp, ".gog-keyring-password"), "file-kp-123\n");
		const probe = path.join(tmp, "probe-env.js");
		fs.writeFileSync(
			probe,
			"console.log(JSON.stringify({ keyring: process.env.GOG_KEYRING_PASSWORD ?? null }));",
		);
		const runner = new ProductionGogRunner({ binary: process.execPath });
		const result = await runner.run({
			command: [probe],
			exactCommands: ["probe"],
			timeoutMs: 10_000,
		});
		assert.equal(result.exitCode, 0);
		const envSeen = JSON.parse(result.stdout.trim());
		assert.equal(envSeen.keyring, "file-kp-123");
	});

	test("existing GOG_KEYRING_PASSWORD env var takes precedence over file", async () => {
		fs.writeFileSync(path.join(tmp, ".gog-keyring-password"), "file-kp-123\n");
		process.env.GOG_KEYRING_PASSWORD = "env-kp-456";
		const probe = path.join(tmp, "probe-env.js");
		fs.writeFileSync(
			probe,
			"console.log(JSON.stringify({ keyring: process.env.GOG_KEYRING_PASSWORD ?? null }));",
		);
		const runner = new ProductionGogRunner({ binary: process.execPath });
		const result = await runner.run({
			command: [probe],
			exactCommands: ["probe"],
			timeoutMs: 10_000,
		});
		assert.equal(result.exitCode, 0);
		const envSeen = JSON.parse(result.stdout.trim());
		assert.equal(envSeen.keyring, "env-kp-456");
		delete process.env.GOG_KEYRING_PASSWORD;
	});

	test("missing password file does not break the child (keyring unset)", async () => {
		delete process.env.GOG_KEYRING_PASSWORD;
		fs.rmSync(path.join(tmp, ".gog-keyring-password"), { force: true });
		const probe = path.join(tmp, "probe-env.js");
		fs.writeFileSync(
			probe,
			"console.log(JSON.stringify({ keyring: process.env.GOG_KEYRING_PASSWORD ?? null }));",
		);
		const runner = new ProductionGogRunner({ binary: process.execPath });
		const result = await runner.run({
			command: [probe],
			exactCommands: ["probe"],
			timeoutMs: 10_000,
		});
		assert.equal(result.exitCode, 0);
		const envSeen = JSON.parse(result.stdout.trim());
		assert.equal(envSeen.keyring, null);
	});
});

describe("shell injection safety", () => {
	test("command with shell metacharacters stays as separate array elements", async () => {
		const runner = new FakeGogRunner();
		const dangerous = [
			"calendar", "events", "--query",
			"test && rm -rf / ; echo pwned | cat /etc/passwd `whoami` $(id)",
		];
		await runner.run({
			command: dangerous,
			exactCommands: ["calendar.events"],
			timeoutMs: 30_000,
		});
		// Each element stays isolated — no shell interpretation possible
		assert.equal(runner.invocations[0].command.length, 4);
		assert.equal(runner.invocations[0].command[0], "calendar");
		assert.equal(runner.invocations[0].command[3], dangerous[3]);
	});
});
