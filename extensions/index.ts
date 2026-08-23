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
import { buildSystemPrompt, clearInjections, resetCacheStats } from "./utils/prompt-budget.js";
import { readJSON, waywiserHome } from "./utils/state.js";

const here = path.dirname(fileURLToPath(import.meta.url));

interface PromptBudgetConfig {
	maxChars?: number;
}

// Load order: permissions first (gates all tool calls), then identity
// (stable system-prompt prefix), memory second, then capabilities, then
// user-facing commands last.
const modules = [
	"./permissions.js",
	"./soul.js",
	"./memory.js",
	"./brain/index.js", // Brain is core — loaded as a regular extension
	"./skills-manage.js",
	"./web.js",
	"./mcp.js",
	"./execute-code.js",
	"./delegate.js",
	"./cronjob.js",
	"./notify.js",
	"./clarify.js",
	"./kanban/index.js",
	"./todo-compat.js",
	"./commands.js",
	"./proactive.js",
	"./meta-skills.js",
	"./mobile/index.js",
];

export default async function (pi: ExtensionAPI) {
	// Registered BEFORE any module loads, so this is the FIRST "session_start"
	// handler in this extension's registration order (pi dispatches handlers
	// per-event in the exact order pi.on() was called — verified against
	// @earendil-works/pi-coding-agent's ExtensionRunner.emit()). That ordering
	// matters: soul.ts and memory.ts register their session-stable injections
	// ("soul", "memory-digest") from their OWN session_start handlers below,
	// during the module-load loop, and no longer re-register them per-turn.
	// If this clear ran AFTER theirs (e.g. registered below the loop, mirroring
	// the before_agent_start assembly handler), it would wipe out those
	// same-pass registrations and neither would ever reappear for the session.
	pi.on("session_start", () => {
		clearInjections();
		resetCacheStats();
	});

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

	// Coordinated assembly — registered AFTER all module loads above, so this
	// before_agent_start handler runs LAST (pi fires before_agent_start handlers
	// in registration order). By the time this runs, every extension has already
	// registered (or removed) its injection for this turn.
	pi.on("before_agent_start", (event) => {
		const cfg = readJSON<{ promptBudget?: PromptBudgetConfig }>(
			path.join(waywiserHome(), "config.json"),
			{},
		);
		const budgetChars = cfg.promptBudget?.maxChars ?? 12_000;
		const assembled = buildSystemPrompt(event.systemPrompt, budgetChars);
		return { systemPrompt: assembled };
	});
}
