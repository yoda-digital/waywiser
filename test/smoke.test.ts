// Smoke test: every sub-extension loads under jiti (pi's loader semantics) and
// registers its tools/commands against a deterministic stub ExtensionAPI.
// Run: cd waywiser && node --test test/smoke.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-smoke-"));
process.env.WAYWISER_HOME = tmp;

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url);

function makeStubApi() {
	const tools: Array<{ name: string; description: string; parameters: unknown }> = [];
	const commands: Array<{ name: string; description?: string }> = [];
	const handlers: Array<{ event: string }> = [];
	return {
		tools,
		commands,
		handlers,
		api: {
			on: (event: string) => {
				handlers.push({ event });
				return undefined;
			},
			registerTool: (t: { name: string; description: string; parameters: unknown }) => {
				tools.push({ name: t.name, description: t.description, parameters: t.parameters });
			},
			registerCommand: (name: string, opts: { description?: string; handler: unknown }) => {
				commands.push({ name, description: opts.description });
			},
			registerShortcut: () => undefined,
			registerFlag: () => {
				throw new Error("not in smoke");
			},
			sendUserMessage: () => undefined,
			appendEntry: () => undefined,
		},
	};
}

const MODULES = [
	"soul",
	"memory",
	"skills-manage",
	"web",
	"execute-code",
	"delegate",
	"cronjob",
	"clarify",
	"kanban",
	"todo-compat",
	"commands",
];

const EXPECTED_TOOLS = new Set([
	"soul",
	"memory",
	"skills_list",
	"skill_view",
	"skill_manage",
	"kanban",
	"web_search",
	"web_extract",
	"execute_code",
	"delegate_task",
	"cronjob",
	"clarify",
]);

const EXPECTED_COMMANDS = new Set([
	"todo",
	"cron",
	"kanban",
	"goal",
	"subgoal",
	"goals",
	"goal-done",
	"memory",
	"soul",
	"journey",
	"trace",
	"waywiser",
	"refine",
	"handoff",
	"worktree",
	"context",
]);

function loadExt(m: string): (api: unknown) => unknown {
	const mod = jiti(`../extensions/${m}.js`) as ({ default?: never } & unknown) | ((api: unknown) => unknown);
	// ESM default goes through node jiti as .default when the import is a real ESM namespace;
	// CJS interop returns the function directly. Handle both.
	if (typeof mod === "function") return mod as (api: unknown) => unknown;
	const d = (mod as { default?: unknown }).default;
	if (typeof d === "function") return d as (api: unknown) => unknown;
	throw new Error(`${m}: no function export found (typeof mod=${typeof mod})`);
}

test("all sub-extensions load and register expected tools", () => {
	const stub = makeStubApi();
	for (const m of MODULES) {
		const ext = loadExt(m);
		const p = ext(stub.api as never);
		void p; // extensions may return undefined or a promise
	}
	const toolNames = new Set(stub.tools.map((t) => t.name));
	for (const want of EXPECTED_TOOLS) {
		assert.ok(toolNames.has(want), `missing tool: ${want} (got: ${[...toolNames].join(", ")})`);
	}
	const cmdNames = new Set(stub.commands.map((c) => c.name));
	for (const want of EXPECTED_COMMANDS) {
		assert.ok(cmdNames.has(want), `missing command: /${want} (got: ${[...cmdNames].join(", ")})`);
	}
});

test("root index composes all modules without throwing (stub API)", async () => {
	const stub = makeStubApi();
	const root = loadExt("index");
	await root(stub.api as never);
	const toolNames = new Set(stub.tools.map((t) => t.name));
	assert.ok(toolNames.has("delegate_task"), "index should register delegate_task");
	assert.ok(toolNames.has("soul"), "index should register soul");
});

test("every tool has a parseable description and schema object", () => {
	const stub = makeStubApi();
	for (const m of MODULES) {
		loadExt(m)(stub.api as never);
	}
	for (const t of stub.tools) {
		assert.ok(t.description && t.description.length > 10, `tool ${t.name} has too-short description`);
		assert.ok(t.parameters && typeof t.parameters === "object", `tool ${t.name} missing parameters`);
		// TypeBox v2 JSON-schema shape: { type: 'object', properties: {...} }.
		const schema = t.parameters as { type?: string; properties?: Record<string, unknown> };
		assert.equal(schema.type, "object", `tool ${t.name} schema not an object schema`);
		assert.ok(schema.properties, `tool ${t.name} schema has no properties field (empty object is fine for no-arg tools)`);
	}
});
