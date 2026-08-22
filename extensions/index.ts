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
	"./todo-compat.js",
	"./commands.js",
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
}
