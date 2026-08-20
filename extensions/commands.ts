/**
 * waywiser-*commands — goal tree + the /waywiser-* command set.
 *
 * - Goals: persistent in the shared DB; /goal sets the session goal,
 *   /subgoal adds a child, /goals shows the tree. The current goal tree is
 *   appended to the system prompt (session-stable, cache-friendly).
 * - /waywiser-* status — packed health view (soul, memory count, subagents, cron, kanban, version).
 * - /memory [query] — quick recall right in the REPL.
 * - /soul — print current identity.
 * - /journey — session journey log tail.
 * - /handoff — produce a handoff summary via a subagent-free prompt the model can
 *   copy into a fresh session.
 * - /refine <instruction> — ask the model (followUp) to refine its last message.
 * - /worktree <path> — cd-equivalent: sets the working directory note for the session
 *   via a follow-up instruction (pi sessions are cwd-anchored at start, so this
 *   is an honest instruction, not silent mutation).
 * - /context [all] — show the current effective system prompt head.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { db_, WAYWISER_VERSION, waywiserHome, homeFile, readJSON, registry_, shortId, memSettings } from "./utils/state.js";
import { memAction, parseMemCommandLine, runRecallText } from "./memory.js";
import { runConsolidate, formatConsolidateReport } from "./mem-dream.js";

interface Goal {
	id: string;
	parent_id: string | null;
	text: string;
	status: string;
}

function goals(): Goal[] {
	try {
		return db_().prepare("SELECT id, parent_id, text, status FROM goals ORDER BY created_at, id").all() as Goal[];
	} catch {
		return [];
	}
}

function goalTree(g: Goal[]): string {
	const byParent = new Map<string | null, Goal[]>();
	for (const n of g) {
		const k = n.parent_id ?? null;
		byParent.set(k, [...(byParent.get(k) ?? []), n]);
	}
	const lines: string[] = [];
	const walk = (parent: string | null, indent: string): void => {
		for (const n of byParent.get(parent) ?? []) {
			lines.push(`${indent}${n.id} [${n.status}] ${n.text}`);
			walk(n.id, indent + "  ");
		}
	};
	walk(null, "");
	return lines.join("\n");
}

export default function commands(pi: ExtensionAPI): void {
	let lastCtx: ExtensionContext | undefined;

	const activeGoals = (): string => {
		const g = goals().filter((x) => x.status === "active");
		if (!g.length) return "";
		return "\n<!-- WAYWISER GOALS -->\nCurrent goal tree:\n" + goalTree(g) + "\n<!-- WAYWISER GOALS END -->";
	};

	pi.on("before_agent_start", (event) => {
		const block = activeGoals();
		if (!block) return;
		return { systemPrompt: event.systemPrompt + block };
	});

	pi.on("agent_end", (_e, ctx) => {
		lastCtx = ctx;
	});

	// ---------------------------------------------------------------- goals
	pi.registerCommand("goal", {
		description: "Set the session goal (replaces the current active root goal)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("usage: /goal <text>", "error");
			const id = shortId("g");
			db_().prepare("INSERT INTO goals (id, parent_id, text, status) VALUES (?,?,?,?)").run(id, null, text, "active");
			registry_().log("goal", `set: ${text.slice(0, 100)}`);
			ctx.ui.notify(`Goal set: ${id} ${text}`, "info");
		},
	});

	pi.registerCommand("subgoal", {
		description: "Add a subgoal: /subgoal <text> [parent_id] (default: no parent / root)",
		handler: async (args, ctx) => {
			const m = args.trim().match(/^(.+?)\s+((?:g|K)[\w]+)\s*$/);
			const parent = m ? m[2] : null;
			const text = m ? m[1] : args.trim();
			if (!text) return ctx.ui.notify("usage: /subgoal <text> [parent_id]", "error");
			if (parent && !db_().prepare("SELECT id FROM goals WHERE id = ?").get(parent)) {
				return ctx.ui.notify(`no goal ${parent} — listing: ${goals().map((g) => g.id).join(", ") || "(none)"}`, "error");
			}
			const id = shortId("g");
			db_().prepare("INSERT INTO goals (id, parent_id, text, status) VALUES (?,?,?,?)").run(id, parent, text, "active");
			ctx.ui.notify(`Subgoal added: ${id} under ${parent ?? "(root)"}: ${text}`, "info");
		},
	});

	pi.registerCommand("goals", {
		description: "Show the goal tree (all: /goals all)",
		handler: async (args, ctx) => {
			const showAll = args.trim() === "all";
			const g = showAll ? goals() : goals().filter((x) => x.status === "active");
			if (!g.length) return ctx.ui.notify("No goals set. /goal <text> to set one.", "info");
			ctx.ui.notify(goalTree(g), "info");
		},
	});

	pi.registerCommand("goal-done", {
		description: "Mark a goal done: /goal-done <id>",
		handler: async (args, ctx) => {
			const id = args.trim();
			const r = db_().prepare("UPDATE goals SET status='done' WHERE id=?").run(id);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(r as any).changes ? ctx.ui.notify(`goal ${id} marked done`, "info") : ctx.ui.notify(`no goal ${id}`, "error");
		},
	});

	// ---------------------------------------------------------------- memory / soul / journey
	pi.registerCommand("memory", {
		description: "Memory surface: /memory [query] — bare words recall; verbs: remember/recall/forget/list/promote <id>/supersede <keep> <drop>/conflicts/stats/set <k>=<v>/consolidate [apply]",
		handler: async (args, ctx) => {
			const r = parseMemCommandLine(args);
			try {
				if ("consolidate" in r) {
					const rep = await runConsolidate(db_(), { dryRun: !r.apply, cap: memSettings().consolidateCap });
					ctx.ui.notify(formatConsolidateReport(rep), "info");
					return;
				}
				const out = "query" in r ? await runRecallText(db_(), r.query) : await memAction(db_, r.action, r.p);
				ctx.ui.notify(out.text, out.isErr ? "error" : "info");
			} catch (e) {
				ctx.ui.notify(`memory error: ${String(e)}`, "error");
			}
		},
	});

	pi.registerCommand("soul", {
		description: "Show current SOUL.md identity",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(fs.readFileSync(homeFile("SOUL.md"), "utf-8").trim(), "info");
			} catch {
				ctx.ui.notify("SOUL.md not found (run bin/waywiser-* once to bootstrap)", "error");
			}
		},
	});

	pi.registerCommand("journey", {
		description: "Show the session journey log tail: /journey [n]",
		handler: async (args, ctx) => {
			const n = Math.min(Number(args.trim()) || 15, 50);
			try {
				const rows = db_().prepare("SELECT kind, text, created_at FROM journey ORDER BY id DESC LIMIT ?").all(n) as Array<
					Record<string, unknown>
				>;
				ctx.ui.notify(
					rows.length ? rows.map((r) => `[${r.created_at}] ${r.kind}: ${String(r.text).slice(0, 120)}`).join("\n") : "Journey empty.",
					"info",
				);
			} catch (e) {
				ctx.ui.notify(String(e), "error");
			}
		},
	});

	// ---------------------------------------------------------------- waywiser-* status
	pi.registerCommand("waywiser", {
		description: "Waywiser status: /waywiser [status] — soul, memory, cron, kanban, version",
		handler: async (_args, ctx) => {
			const lines: string[] = [`waywiser-on-pi v${WAYWISER_VERSION} — Waywiser on the Pi harness`];
			try {
				const soul = fs.existsSync(homeFile("SOUL.md"));
				lines.push(`SOUL.md: ${soul ? "loaded" : "MISSING"}`);
				const mem = db_().prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
				lines.push(`memories: ${mem.n}`);
				const cron = db_().prepare("SELECT COUNT(*) AS n FROM cronjobs WHERE enabled=1").get() as { n: number };
				lines.push(`cron jobs: ${cron.n} active`);
				const board = readJSON<{ cards?: Record<string, { status: string }> }>(path.join(waywiserHome(), "kanban.json"), {});
				const cards = Object.values(board.cards ?? {});
				lines.push(`kanban: ${cards.length} cards (${cards.filter((c) => c.status === "done").length} done)`);
				lines.push(`registry subagents: ${registry_().subagents.size}`);
				lines.push(`context usage: ${ctx.getContextUsage() ? JSON.stringify(ctx.getContextUsage()) : "n/a"} · model: ${ctx.model ? `${ctx.model.provider ?? "?"}/${ctx.model.id ?? String(ctx.model)}` : "n/a"}`);
			} catch (e) {
				lines.push(`status error: ${String(e)}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ---------------------------------------------------------------- refine / handoff / worktree / context
	pi.registerCommand("refine", {
		description: "Refine your last message: /refine <instruction>",
		handler: async (args, ctx) => {
			const instr = args.trim();
			if (!instr) return ctx.ui.notify("usage: /refine <instruction>", "error");
			try {
				pi.sendUserMessage(`Refine your previous answer. Instruction: ${instr}. Replace it with an improved version that keeps everything still true.`, {
					deliverAs: "followUp",
				});
				ctx.ui.notify("Refine queued.", "info");
			} catch (e) {
				ctx.ui.notify(String(e), "error");
			}
		},
	});

	pi.registerCommand("handoff", {
		description: "Produce a handoff brief for a fresh session: /handoff [note]",
		handler: async (args, ctx) => {
			try {
				const goalBlock = activeGoals() ? activeGoals().replace(/<!--[^>]+-->\n?/g, "") : "";
				pi.sendUserMessage(
					(
						"[waywiser-* handoff] Produce a handoff brief for an operator continuing this work in a FRESH session. It must contain: 1) objective, 2) success criteria, 3) workspace facts (dir, files touched, commands run with results), 4) decisions made + why, 5) open risks/unknowns, 6) next concrete steps. Plain markdown, no preamble.\n"
						+ (goalBlock ? `Goal tree: ${goalBlock}\n` : "")
						+ (args.trim() ? `Extra note: ${args.trim()}\n` : "")
					).trimEnd(),
					{ deliverAs: "followUp" },
				);
				ctx.ui.notify("Handoff brief queued as a follow-up.", "info");
			} catch (e) {
				ctx.ui.notify(String(e), "error");
			}
		},
	});

	pi.registerCommand("worktree", {
		description: "Note a working directory switch: /worktree <path> (pi sessions are cwd-anchored; restart pi in the new dir for full effect)",
		handler: async (args, ctx) => {
			const p = args.trim();
			if (!p || !fs.existsSync(p)) return ctx.ui.notify(`path does not exist: ${p}`, "error");
			registry_().log("worktree", `switched to ${p}`);
			ctx.ui.notify(`Noted working directory ${p}. (Pi sessions are anchored to the cwd at start — restart pi there for tools to use it as the default.)`, "info");
		},
	});

	pi.registerCommand("context", {
		description: "Show the current effective system prompt: /context [all] (head by default)",
		handler: async (args, ctx) => {
			let sp: string;
			try {
				sp = ctx.getSystemPrompt();
			} catch (e) {
				sp = `unavailable: ${String(e)}`;
			}
			const all = args.trim() === "all";
			const shown = all ? sp : sp.slice(0, 4000) + (sp.length > 4000 ? `\n…[${sp.length - 4000} chars omitted; /context all for full]` : "");
			ctx.ui.notify(shown, "info");
		},
	});
}
