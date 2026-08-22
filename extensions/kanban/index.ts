/**
 * waywiser-*kanban — multi-board task board (tool + /kanban command, same ops).
 *
 * Status lifecycle: todo → doing → review → done, with a blocked side-state.
 * Card extras: type (task|idea|bug), priority (low|med|high|critical), due time,
 * notes, subagent report, board_id (multi-board).
 *
 * State: SQLite (~/.waywiser/waywiser.db, tables `boards` + `cards` — schema owned
 * by utils/state.ts::db_()). Every mutation also schedules (debounced 500ms):
 *  - a live push to any connected browser tab over SSE (kanban-server.ts)
 *  - a Markdown export per board (~/.waywiser/boards/<id>.md)
 *  - a static HTML snapshot (~/.waywiser/board.html), readable when waywiser isn't running
 *
 * A tiny localhost-only HTTP server (kanban-server.ts, bound 127.0.0.1) serves the
 * live interactive board at http://localhost:7749/ (or the next free port up to +10).
 * `/kanban open` opens it in the default browser.
 *
 * On first load, a legacy ~/.waywiser/kanban.json (the old single-board JSON store)
 * is migrated into SQLite once, then renamed to `.migrated` (kept, not deleted).
 *
 * `/kanban assign <id> subagent` (or tool action=assign who=subagent) really spawns a
 * leaf pi child (via utils/rpc) that works the card: it receives the card as a
 * self-contained briefing, and on finish its report is written onto the card and
 * the card moves to review. This is explicit, user-requested spawning — not hidden
 * automation. One card may have at most one in-flight worker (concurrency is the
 * caller's; delegate_task keeps its own pool).
 *
 * This is the extension entry point: wiring, migration, the debounced-refresh
 * server bootstrap, and the /kanban command + kanban tool. The actual board/card
 * CRUD lives in ops.ts, the subagent worker lifecycle in worker.ts, and the
 * shared types/constants/DB helpers in shared.ts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { db_, waywiserHome, readJSON } from "../utils/state.js";
import { startBoardServer, setHtmlGenerator } from "../kanban-server.js";
import { generateBoardHtml } from "../kanban-html.js";
import { registerInjection, removeInjection, PRIORITIES as INJECTION_PRIORITIES } from "../utils/prompt-budget.js";
import { STATUSES, PRIORITIES, ensureBoard, getBoards, getCards, type Status, type OpResult } from "./shared.js";
import { boardOps as ops, cardLine, getActiveBoardId, scheduleRefresh, stopRefreshTimer } from "./ops.js";
import { inFlight } from "./worker.js";

let serverPort = 7749;
let serverHandle: { port: number; close: () => void } | undefined;

// ── one-time JSON → SQLite migration ─────────────────────────────────
interface OldCard {
	id: string; title: string; status: string; assignee?: string; blockReason?: string;
	notes?: string; report?: string; priority?: string; due?: string; workerChild?: string;
	createdAt: number; updatedAt: number;
}
interface OldBoard { seq: number; cards: Record<string, OldCard>; }

const OLD_STATUS_MAP: Record<string, Status> = { todo: "todo", ready: "doing", review: "review", done: "done", blocked: "blocked", scheduled: "todo" };

function migrateFromJson(): void {
	const jsonFile = path.join(waywiserHome(), "kanban.json");
	if (!fs.existsSync(jsonFile)) return;
	try {
		const old = readJSON<OldBoard>(jsonFile, { seq: 0, cards: {} });
		const d = db_();
		ensureBoard("default", "Default");
		let migrated = 0;
		for (const c of Object.values(old.cards ?? {})) {
			const status = OLD_STATUS_MAP[c.status] ?? "todo";
			const priority = c.priority && (PRIORITIES as readonly string[]).includes(c.priority) ? c.priority : "med";
			const res = d
				.prepare(
					`INSERT OR IGNORE INTO cards (id, board_id, title, type, status, priority, assignee, block_reason, notes, report, due, created_at, updated_at)
					 VALUES (?, 'default', ?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					c.id,
					c.title,
					status,
					priority,
					c.assignee ?? null,
					c.blockReason ?? null,
					c.notes ?? null,
					c.report ?? null,
					c.due ?? null,
					new Date(c.createdAt ?? Date.now()).toISOString(),
					new Date(c.updatedAt ?? Date.now()).toISOString(),
				);
			if (res.changes) migrated++;
		}
		fs.renameSync(jsonFile, `${jsonFile}.migrated`);
		process.stderr.write(`waywiser/kanban: migrated ${migrated} card(s) from kanban.json → SQLite\n`);
	} catch (e) {
		process.stderr.write(`waywiser/kanban: migration from kanban.json failed: ${e instanceof Error ? e.message : String(e)}\n`);
	}
}

// ── TUI widget ─────────────────────────────────────────────────────────
function widgetText(): string {
	const cards = getCards(getActiveBoardId());
	const counts: Record<string, number> = {};
	let overdue = 0;
	for (const c of cards) {
		counts[c.status] = (counts[c.status] ?? 0) + 1;
		if (c.due && c.status !== "done" && new Date(c.due).getTime() < Date.now()) overdue++;
	}
	const parts = STATUSES.filter((s) => s !== "blocked").map((s) => `${s.toUpperCase()}(${counts[s] ?? 0})`);
	if (counts.blocked) parts.push(`BLOCKED(${counts.blocked})`);
	if (overdue) parts.push(`${overdue} OVERDUE`);
	if (inFlight.size) parts.push(`${inFlight.size} WORKING`);
	return `BOARD: ${getActiveBoardId()} | ${parts.join(" ")}`;
}

function ensureWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const cards = getCards(getActiveBoardId());
	if (!cards.length) return;
	ctx.ui.setWidget("waywiser-*:kanban", [widgetText()]);
}

function openInBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	exec(`${cmd} "${url}"`, () => {
		/* best-effort; failures are silent (headless envs, no DISPLAY, etc.) */
	});
}

function mkTool(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

// ── tool action dispatch (replaces the old 28-line ternary chain — L13) ──
const boardArg = (p: Record<string, unknown>): string | undefined => (p.board as string | undefined)?.trim() || undefined;

const ACTION_DISPATCH: Record<
	string,
	(p: Record<string, unknown>, ctx: ExtensionContext) => OpResult | Promise<OpResult>
> = {
	new: (p) =>
		ops.newCard((p.title as string) ?? "", {
			priority: (p.priority as string | undefined)?.trim() || undefined,
			due: (p.due as string | undefined)?.trim() || undefined,
			type: (p.type as string | undefined)?.trim() || undefined,
			board: boardArg(p),
		}),
	list: (p) => ops.list(boardArg(p)),
	show: (p) => ops.show((p.id as string) ?? ""),
	move: (p) => ops.move((p.id as string) ?? "", (p.status as string) ?? "", boardArg(p)),
	assign: (p, ctx) => ops.assign((p.id as string) ?? "", (p.who as string) ?? "", ctx.cwd),
	block: (p) => ops.block((p.id as string) ?? "", (p.reason as string) ?? ""),
	resume: (p) => ops.resume((p.id as string) ?? ""),
	note: (p) => ops.note((p.id as string) ?? "", (p.text as string) ?? ""),
	report: (p) => ops.report((p.id as string) ?? "", (p.text as string) ?? ""),
	pri: (p) => ops.setPriority((p.id as string) ?? "", (p.priority as string) ?? ""),
	due: (p) => ops.setDue((p.id as string) ?? "", (p.due as string) ?? ""),
	type: (p) => ops.setType((p.id as string) ?? "", (p.type as string) ?? ""),
	wait: (p) => ops.wait((p.id as string) ?? "", Math.min(Math.max((p.timeout as number) ?? 120_000, 1000), 300_000)),
	done: (p) => ops.done((p.id as string) ?? ""),
	remove: (p) => ops.remove((p.id as string) ?? ""),
	stats: (p) => ops.stats(boardArg(p)),
	clear_done: (p) => ops.clearDone(boardArg(p)),
	search: (p) => ops.search((p.query as string) ?? ""),
	boards: () => ops.boards(),
	board: (p) => ops.boardSwitch(boardArg(p) ?? (p.title as string) ?? ""),
	board_create: (p) => ops.boardCreate(boardArg(p) ?? (p.title as string) ?? "", p.description as string | undefined),
	board_archive: (p) => ops.boardArchive(boardArg(p) ?? ""),
	board_delete: (p) => ops.boardDelete(boardArg(p) ?? ""),
	open: () => {
		const url = `http://localhost:${serverPort}/`;
		openInBrowser(url);
		return { ok: true, msg: `opening ${url}` };
	},
};

// ── extension wiring ────────────────────────────────────────────────────
export default function kanban(pi: ExtensionAPI): void {
	// 1. Migrate from the legacy JSON store (one-time, idempotent).
	migrateFromJson();

	// 2. Start the localhost board server (127.0.0.1, ports 7749..7759).
	startBoardServer(serverPort)
		.then((h) => {
			serverHandle = h;
			serverPort = h.port;
			setHtmlGenerator(() => generateBoardHtml(getBoards(), getCards(), getActiveBoardId(), serverPort));
			process.stderr.write(`waywiser/board: live at http://localhost:${serverPort}/\n`);
			scheduleRefresh();
		})
		.catch((e) => {
			process.stderr.write(`waywiser/board: server failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
		});

	pi.on("session_start", (_e, ctx) => ensureWidget(ctx));

	// 3. Session-start-adjacent: inject open cards into the system prompt so the
	// model sees board state even in non-TUI modes (e.g. `waywiser -p`).
	pi.on("before_agent_start", () => {
		const cards = getCards(getActiveBoardId()).filter((c) => c.status !== "done");
		if (!cards.length) {
			removeInjection("kanban");
			return;
		}
		const summary = cards
			.map((c) => `${c.id} [${c.status}/${c.priority}] ${c.title}${c.due ? ` (due ${c.due.slice(0, 10)})` : ""}${c.assignee ? ` → ${c.assignee}` : ""}`)
			.join("\n");
		registerInjection({
			key: "kanban",
			priority: INJECTION_PRIORITIES.KANBAN,
			cacheable: false,
			content: `\n\n[Kanban — ${cards.length} open]\n${summary}`,
		});
		// NO return — buildSystemPrompt handles assembly
	});

	const SUBDESCRIPTION =
		"new <title> | list | show <id> | move <id> <status> [--board <name>] | assign <id> <name|subagent> " +
		"(subagent really spawns a leaf worker that files its report on the card) | block <id> <reason> | " +
		"resume <id> | note <id> <text> | report <id> <text> | pri <id> <low|med|high|critical> | due <id> <@ISO|YYYY-MM-DD[Thh:mm]> | " +
		"type <id> <task|idea|bug> | wait <id> | done <id> | remove <id> | stats | clear-done | search <query> | " +
		"boards | board <name> | board create <name> [desc] | board archive <name> | board delete <name> | open | refresh";

	pi.registerCommand("kanban", {
		description: "Kanban board. " + SUBDESCRIPTION,
		handler: async (args, ctx: ExtensionContext) => {
			const [cmd, ...rest] = args.trim().split(/\s+/);
			const run = async (r: OpResult | Promise<OpResult>): Promise<void> => {
				const res = await r;
				if (res.ok) {
					ctx.ui.notify(res.msg, "info");
					ensureWidget(ctx);
				} else {
					ctx.ui.notify(res.msg, "error");
				}
			};
			switch (cmd) {
				case "new": return run(ops.newCard(rest.join(" ")));
				case "list": return run(ops.list());
				case "show": return run(ops.show(rest[0] ?? ""));
				case "move": {
					const bIdx = rest.indexOf("--board");
					const boardArgVal = bIdx !== -1 ? rest[bIdx + 1] : undefined;
					const statusArgs = bIdx !== -1 ? rest.slice(0, bIdx) : rest;
					return run(ops.move(statusArgs[0] ?? "", statusArgs[1] ?? "", boardArgVal));
				}
				case "assign": return run(ops.assign(rest[0] ?? "", rest[1] ?? "", ctx.cwd));
				case "block": return run(ops.block(rest[0] ?? "", rest.slice(1).join(" ")));
				case "resume": return run(ops.resume(rest[0] ?? ""));
				case "note": return run(ops.note(rest[0] ?? "", rest.slice(1).join(" ")));
				case "report": return run(ops.report(rest[0] ?? "", rest.slice(1).join(" ")));
				case "pri": return run(ops.setPriority(rest[0] ?? "", rest[1] ?? ""));
				case "due": return run(ops.setDue(rest[0] ?? "", rest[1] ?? ""));
				case "type": return run(ops.setType(rest[0] ?? "", rest[1] ?? ""));
				case "wait": {
					const timeoutMs = rest[1] ? Number(rest[1]) : 120_000;
					ctx.ui.notify(`waiting up to ${Math.round(timeoutMs / 1000)}s for ${rest[0] ?? "-"}…`, "info");
					return run(ops.wait(rest[0] ?? "", Number.isFinite(timeoutMs) ? timeoutMs : 120_000));
				}
				case "done": return run(ops.done(rest[0] ?? ""));
				case "remove": return run(ops.remove(rest[0] ?? ""));
				case "stats": return run(ops.stats());
				case "clear-done": return run(ops.clearDone());
				case "search": return run(ops.search(rest.join(" ")));
				case "boards": return run(ops.boards());
				case "board": {
					const sub = rest[0];
					if (sub === "create") return run(ops.boardCreate(rest[1] ?? "", rest.slice(2).join(" ")));
					if (sub === "archive") return run(ops.boardArchive(rest.slice(1).join(" ")));
					if (sub === "delete") return run(ops.boardDelete(rest.slice(1).join(" ")));
					return run(ops.boardSwitch(rest.join(" ")));
				}
				case "open": {
					const url = `http://localhost:${serverPort}/`;
					openInBrowser(url);
					ctx.ui.notify(`opening ${url}`, "info");
					return;
				}
				case "refresh":
				case "":
				case undefined: {
					ensureWidget(ctx);
					const open = getCards(getActiveBoardId()).filter((c) => c.status !== "done");
					ctx.ui.notify(open.length ? open.map(cardLine).join("\n") : "no open cards", "info");
					return;
				}
				default: return run({ ok: false, msg: `unknown /kanban subcommand "${cmd}". See description for the list.` });
			}
		},
	});

	// Tool facade: the SAME ops, reachable by the model in any mode (`-p` included).
	pi.registerTool({
		name: "kanban",
		label: "Kanban",
		description:
			"Operate the Waywiser kanban board (same board as the /kanban command). Multi-board: pass `board` to " +
			"target a board other than the active one; omit it to use the active board. " +
			"Use for multi-step or multi-agent work you want tracked across turns/sessions. " +
			"status: todo|doing|review|done|blocked. type: task|idea|bug. priority: low|med|high|critical. " +
			"assign with who=subagent spawns a DETACHED leaf worker that works the card and files its report on it; " +
			"wait(id,timeout_ms?) blocks (bounded) until that worker finishes; one worker per card. " +
			"actions: new(title[,priority][,due][,type][,board]) | list([board]) | show(id) | move(id,status[,board]) | " +
			"assign(id,who) | block(id,reason) | resume(id) | note(id,text) | report(id,text) | pri(id,priority) | " +
			"due(id,due) | type(id,type) | wait(id,timeout_ms?) | done(id) | remove(id) | stats([board]) | clear_done([board]) | " +
			"search(query) | boards | board(board) | board_create(board,description?) | board_archive(board) | board_delete(board) | open",
		parameters: Type.Object({
			action: Type.String({ description: "new | list | show | move | assign | block | resume | note | report | pri | due | type | wait | done | remove | stats | clear_done | search | boards | board | board_create | board_archive | board_delete | open" }),
			id: Type.Optional(Type.String({ description: "Card id (e.g. Ka1b2c3d4)" })),
			title: Type.Optional(Type.String({ description: "For new" })),
			status: Type.Optional(Type.String({ description: "For move: todo|doing|review|done|blocked" })),
			who: Type.Optional(Type.String({ description: "For assign: a name, or 'subagent' to spawn a worker" })),
			reason: Type.Optional(Type.String({ description: "For block" })),
			text: Type.Optional(Type.String({ description: "For note/report" })),
			priority: Type.Optional(Type.String({ description: "For pri, or at new: low|med|high|critical" })),
			due: Type.Optional(Type.String({ description: "For due, or at new: @ISO or YYYY-MM-DD[Thh:mm]" })),
			type: Type.Optional(Type.String({ description: "For type, or at new: task|idea|bug" })),
			board: Type.Optional(Type.String({ description: "Board id (default: active board). Used by new/list/move/stats/clear_done/board*" })),
			description: Type.Optional(Type.String({ description: "For board_create" })),
			query: Type.Optional(Type.String({ description: "For search" })),
			timeout: Type.Optional(Type.Number({ description: "For wait: max ms to block (default 120000, max 300000)" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, _signal, _update, ctx: ExtensionContext) {
			const a = ((p.action as string | undefined) ?? "").trim();
			const handler = ACTION_DISPATCH[a];
			if (!handler) return mkTool(`unknown kanban action "${a}" (see tool description)`, true);
			const res = await handler(p as Record<string, unknown>, ctx);
			return mkTool(res.msg, !res.ok);
		},
	});

	// 4. Shutdown: stop the debounce timer and close the HTTP server.
	pi.on("session_shutdown", () => {
		stopRefreshTimer();
		serverHandle?.close();
	});
}

// Exported for tests / other modules.
export { widgetText };
export { STATUSES, PRIORITIES } from "./shared.js";
export { boardOps } from "./ops.js";
