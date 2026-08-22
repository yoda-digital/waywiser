#!/usr/bin/env node
/**
 * Waywiser on Pi — root extension entry.
 *
 * Composes every waywiser extension. Each sub-extension keeps its state isolated
 * and speaks to pi only through the stable ExtensionAPI, so a broken module can
 * be removed without taking the whole pack down.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Load order: permissions first (gates all tool calls), then identity
// (stable system-prompt prefix), memory second, then capabilities, then
// user-facing commands last.
const modules = [
	"./permissions.js",
	"./soul.js",
	"./memory.js",
	"./skills-manage.js",
	"./web.js",
	"./mcp.js",
	"./execute-code.js",
	"./delegate.js",
	"./cronjob.js",
	"./notify.js",
	"./clarify.js",
	"./kanban.js",
	"./commands.js",
];

// Tools whose names may collide with other loaded extensions (e.g. the
// pi-superpowers `todo` extension). These are registered LAZILY on the first
// before_agent_start, only when the name is not already taken by another
// extension (observed via event.systemPromptOptions.selectedTools).
const conflictProne: Array<[string, string]> = [
	["./todo.js", "todo"],
];

export default async function (pi: ExtensionAPI) {
	const load = async (id: string): Promise<void> => {
		const file = path.join(here, id);
		try {
			const mod = await import(file);
			const ext = mod.default;
			if (typeof ext !== "function") {
				throw new Error("module default export is not a function");
			}
			await ext(pi);
		} catch (err) {
			// Fail loud, keep loading (pi philosophy: contain errors, skip the broken one).
			// stderr only: stdout is the protocol channel in RPC mode.
			const msg = `waywiser: failed to load ${id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
			process.stderr.write(`${msg}\n`);
		}
	};

	for (const id of modules) await load(id);

	let lazyTried = false;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	pi.on("before_agent_start", (event: any, ctx: any) => {
		if (lazyTried) return;
		lazyTried = true;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const selected: string[] = (event.systemPromptOptions?.selectedTools as string[] | undefined) ?? [];
		for (const [id, toolName] of conflictProne) {
			if (selected.includes(toolName)) {
				process.stderr.write(`waywiser: tool "${toolName}" is provided by another loaded extension; skipping waywiser's own to avoid a name conflict.\n`);
				continue;
			}
			void load(id);
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return undefined as any;
	});
}
