/**
 * waywiser-*kanban — multi-agent task board (tool + /kanban command, same ops).
 *
 * Status lifecycle: todo → ready → review → done, with blocked/scheduled sides.
 * Card extras: priority (low|med|high), due time, notes, subagent report.
 * State: ~/.waywiser/kanban.json (atomic writes). Surfaced as a TUI widget in TUI mode;
 * the tool makes every op available to the model in ANY mode (incl. `waywiser -p`).
 *
 * `/kanban assign <id> subagent` (or tool action=assign who=subagent) really spawns a
 * leaf pi child (via utils/rpc) that works the card: it receives the card as a
 * self-contained briefing, and on finish its report is written onto the card and
 * the card moves to review. This is explicit, user-requested spawning — not hidden
 * automation. One card may have at most one in-flight worker (concurrency is the
 * caller's; delegate_task keeps its own pool).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { waywiserHome, readJSON, writeJSON, shortId } from "./utils/state.js";
import { createPiRpcClient, type PiRpcClient } from "./utils/rpc.js";

const STATUSES = ["todo", "ready", "review", "done", "blocked", "scheduled"] as const;
type Status_ = (typeof STATUSES)[number];
const PRIORITIES = ["low", "med", "high"] as const;
type Priority = (typeof PRIORITIES)[number];
const PRI_RANK = new Map<string, number>([["high", 0], ["med", 1], ["low", 2]]);

interface Card {
	id: string;
	title: string;
	status: Status_;
	assignee?: string;
	blockReason?: string;
	notes?: string;
	report?: string;
	priority?: Priority;
	/** ISO timestamp; surfaced as OVERDUE when in the past on non-done cards. */
	due?: string;
	workerChild?: string;
	createdAt: number;
	updatedAt: number;
}
interface Board { seq: number; cards: Record<string, Card>; }

const boardFile = (): string => path.join(waywiserHome(), "kanban.json");
function loadBoard(): Board { return readJSON<Board>(boardFile(), { seq: 0, cards: {} }); }
function saveBoard(b: Board): void { writeJSON(boardFile(), b); }

// ── shared ops (command and tool both call these) ───────────────────────
// Each returns {ok:boolean, msg:string, state?:board-after} ; `state` lets the
// command/refresh path re-draw the TUI widget without re-loading the file.

type OpResult = { ok: boolean; msg: string; state?: Board };

const inFlight = new Map<string, "running">(); // cardId → in-flight worker

const parseDue = (raw?: string): { iso?: string; err?: string } => {
	const s = (raw ?? "").trim();
	if (!s) return {};
	// Accept: @ISO, ISO with T, "YYYY-MM-DD hh:mm" (LOCAL time), "YYYY-MM-DD" (LOCAL midnight).
	const t = s.startsWith("@") ? s.slice(1) : s;
	if (t.includes("T")) {
		const d = new Date(t);
		if (Number.isNaN(d.getTime())) return { err: `invalid due time "${raw}" (use @ISO or YYYY-MM-DD[Thh:mm])` };
		return { iso: d.toISOString() };
	}
	const m = t.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):?(\d{2}))?$/);
	if (m) {
		// space-form / date-only = LOCAL wall-clock. Preserve it: find the local UTC offset at
		// noon of that day (noon = DST-stable) and append it as an explicit offset.
		const localNoon = new Date(`${m[1]}T12:00:00`).getTime();
		const utcNoon = Date.parse(`${m[1]}T12:00:00Z`);
		const off = utcNoon - localNoon; // ms, e.g. +10800000 for EEST (zone ahead of UTC)
		const H = Math.floor(Math.abs(off) / 3600000);
		const Min = Math.round((Math.abs(off) % 3600000) / 60000);
		const zone = `${off >= 0 ? "+" : "-"}${String(H).padStart(2, "0")}:${String(Min).padStart(2, "0")}`;
		const iso = `${m[1]}T${m[2] ? `${String(m[2]).padStart(2, "0")}:${m[3]}:00` : "00:00:00"}${zone}`;
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return { err: `invalid due time "${raw}"` };
		return { iso: d.toISOString() };
	}
	return { err: `invalid due time "${raw}" (use @ISO or YYYY-MM-DD[Thh:mm])` };
};

function cardLine(c: Card): string {
	const pri = c.priority ? ` [${c.priority}]` : "";
	const due = c.due ? (
		c.status === "done" ? ` (was due ${c.due.slice(0, 16).replace("T", " ")})`
		: new Date(c.due).getTime() < Date.now() ? ` (OVERDUE since ${c.due.slice(0, 16).replace("T", " ")})`
		: ` (due ${c.due.slice(0, 16).replace("T", " ")})`
	) : "";
	return `${c.id}${pri} [${c.status}] ${c.title}${c.assignee ? ` → ${c.assignee}` : ""}${c.blockReason ? ` (block: ${c.blockReason})` : ""}${due}`;
}

function sortedCards(b: Board, withDone = true): Card[] {
	const withWeight = (arr: Card[]): Array<{ c: Card; w: number[]; i: number }> =>
		arr.map((c, i) => ({
			c,
			i,
			w: [
				PRI_RANK.get(c.priority ?? "med") ?? 1,
				c.status === "done" ? 2 : c.status === "blocked" ? 1 : c.status === "scheduled" ? 1 : 0,
				c.due && c.status !== "done" && new Date(c.due).getTime() < Date.now() ? 0 : 1,
				c.due ? new Date(c.due).getTime() : Number.MAX_SAFE_INTEGER,
			],
		}));
	return withWeight(
		Object.values(b.cards).filter((c) => withDone || c.status !== "done"),
	).sort((x, y) => {
		for (let k = 0; k < x.w.length; k++) if (x.w[k] !== y.w[k]) return x.w[k] - y.w[k];
		return x.c.id.localeCompare(y.c.id) || x.i - y.i;
	}).map((x) => x.c);
}

// Spawn a leaf child that works one card; write the report back on completion.
// Detached: returns as soon as the child is running. Never blocks the caller.
async function spawnCard(
	c: Card,
	b: Board,
	cwd: string,
	timeoutMs: number,
): Promise<{ ok: boolean; msg: string }> {
	if (inFlight.has(c.id)) {
		return { ok: false, msg: `${c.id} already has a worker running (${c.workerChild ?? "?"}) — one worker per card` };
	}
	const briefing =
		`You are a leaf worker on the Waywiser kanban board. Work card ${c.id}: "${c.title}"` +
		(c.notes ? `\nNotes: ${c.notes}` : "") +
		(c.report ? `\nPrevious report: ${c.report}` : "") +
		`\nDo the work with your tools. When finished, reply in AT MOST 10 lines: what you did, what files/commands touched (if anything), and anything blocked.\n` +
		`Prefix your first line with "WAYWISER_REPORT: ".\nReply honestly; if you could not do it, say exactly what failed.`;
	let state: PiRpcClient;
	try {
		state = await createPiRpcClient({ cwd, args: ["--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"] });
	} catch (e) {
		return { ok: false, msg: `could not start worker child: ${String(e)}` };
	}
	inFlight.set(c.id, "running");
	c.workerChild = shortId("kc");
	c.status = "ready";
	c.updatedAt = Date.now();
	saveBoard(b);
	const run = async (): Promise<void> => {
		let report = "(no report captured)";
		try {
			const res0 = await state.command({ type: "prompt", message: briefing }, Math.min(timeoutMs, 120_000));
			if (res0.success) {
				await state.waitAgentEnd(timeoutMs).catch(() => void state.abort());
				report = (await state.getLastAssistantText(15_000).catch(() => "")) || "(no report captured)";
			} else {
				report = `worker child rejected the prompt: ${JSON.stringify(res0).slice(0, 300)}`;
			}
			if (!state.isAlive()) report += `\n(worker child exited mid-task)`;
		} catch (e) {
			report = `worker child error: ${String(e)}\n${state.stderrTail() || ""}`.trim();
		} finally {
			state.stop();
			inFlight.delete(c.id);
			// Re-load the board (not mutate our copy): the card may have moved since spawn.
			const b2 = loadBoard();
			const c2 = b2.cards[c.id];
			if (c2) {
				c2.report = report;
				c2.workerChild = undefined;
				if (c2.status === "ready") c2.status = report.startsWith("WAYWISER_REPORT:") ? "review" : "ready";
				c2.updatedAt = Date.now();
				saveBoard(b2);
			}
		}
	};
	void run(); // detached; progress is on the card, report written on completion
	return { ok: true, msg: `worker ${c.workerChild} spawned for ${c.id} (detached) — report will land on the card on completion; use action=wait or list to check` };
}

// Wait for a card's worker (bounded). Used by tool action=wait.
async function waitCard(id: string, timeoutMs: number): Promise<{ report?: string; stillRunning: boolean }> {
	const t0 = Date.now();
	while (inFlight.has(id) && Date.now() - t0 < timeoutMs) {
		await new Promise((r) => setTimeout(r, 1000));
	}
	if (inFlight.has(id)) return { stillRunning: true };
	const c = loadBoard().cards[id];
	return { report: c?.report, stillRunning: false };
}

const ops = {
	newCard(title: string, extra?: { priority?: string; due?: string }): OpResult {
		const b = loadBoard();
		if (!title.trim()) return { ok: false, msg: "usage: new <title> [priority=low|med|high] [due=@ISO|YYYY-MM-DD[Thh:mm]]" };
		const pr = extra?.priority ? (PRIORITIES as readonly string[]).includes(extra.priority) ? (extra.priority as Priority) : null : undefined;
		if (extra?.priority && !pr) return { ok: false, msg: `priority must be one of ${PRIORITIES.join(", ")}` };
		const dueP = extra?.due ? parseDue(extra.due) : {};
		if (dueP.err) return { ok: false, msg: dueP.err };
		b.seq += 1;
		const id = `K${b.seq}`;
		b.cards[id] = { id, title: title.trim(), status: "todo", createdAt: Date.now(), updatedAt: Date.now(), ...(pr ? { priority: pr } : {}), ...(dueP.iso ? { due: dueP.iso } : {}) };
		saveBoard(b);
		return { ok: true, msg: cardLine(b.cards[id]), state: b };
	},
	list(): OpResult {
		const b = loadBoard();
		const cards = sortedCards(b);
		return { ok: true, msg: cards.length ? cards.map(cardLine).join("\n") : "Board is empty.", state: b };
	},
	show(id: string): OpResult {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return { ok: false, msg: `no card ${id}` };
		return { ok: true, msg: cardLine(c) +
			`\ncreated ${new Date(c.createdAt).toISOString()}\nupdated ${new Date(c.updatedAt).toISOString()}` +
			(c.notes ? `\nnotes: ${c.notes}` : "") +
			(c.report ? `\nreport: ${c.report}` : "") + (inFlight.has(c.id) ? `\n(worker running: ${c.workerChild ?? "?"})` : ""), state: b };
	},
	move(id: string, status: string): OpResult {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return { ok: false, msg: `no card ${id}` };
		if (!(STATUSES as readonly string[]).includes(status)) return { ok: false, msg: `status must be one of ${STATUSES.join(", ")}` };
		if (inFlight.has(c.id) && status !== "ready") return { ok: false, msg: `${c.id} has a worker running — don't move it off the board; stop the worker first (assign … subagent is not stop; use remove or wait)` };
		c.status = status as Status_;
		if (c.status !== "blocked") c.blockReason = undefined;
		c.updatedAt = Date.now();
		saveBoard(b);
		return { ok: true, msg: cardLine(c), state: b };
	},
	assign(id: string, who: string, cwd: string, timeoutMs?: number): Promise<OpResult> {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return Promise.resolve({ ok: false, msg: `no card ${id}` });
		if (!who) return Promise.resolve({ ok: false, msg: "usage: assign <id> <name|subagent>" });
		c.assignee = who;
		c.updatedAt = Date.now();
		if (who === "subagent") {
			return spawnCard(c, b, cwd, timeoutMs ?? 900_000).then((r) => (r.ok
				? { ok: true, msg: `${cardLine(c)} — ${r.msg}`, state: loadBoard() }
				: ({ ok: false, msg: `assign ${id} subagent: ${r.msg}` } as OpResult)));
		}
		saveBoard(b);
		return { ok: true, msg: cardLine(c), state: b };
	},
	block(id: string, reason: string): OpResult {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return { ok: false, msg: `no card ${id}` };
		c.status = "blocked";
		c.blockReason = reason || "unspecified";
		c.updatedAt = Date.now();
		saveBoard(b);
		return { ok: true, msg: cardLine(c), state: b };
	},
	resume(id: string): OpResult {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return { ok: false, msg: `no card ${id}` };
		c.status = "ready";
		c.blockReason = undefined;
		c.updatedAt = Date.now();
		saveBoard(b);
		return { ok: true, msg: cardLine(c), state: b };
	},
	note(id: string, text: string): OpResult {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return { ok: false, msg: `no card ${id}` };
		if (!text.trim()) return { ok: false, msg: "usage: note <id> <text>" };
		c.notes = text.trim();
		c.updatedAt = Date.now();
		saveBoard(b);
		return { ok: true, msg: `note set on ${id}`, state: b };
	},
	report(id: string, text: string): OpResult {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return { ok: false, msg: `no card ${id}` };
		if (!text.trim()) return { ok: false, msg: "usage: report <id> <text>" };
		c.report = text.trim();
		c.updatedAt = Date.now();
		saveBoard(b);
		return { ok: true, msg: `report recorded on ${id}`, state: b };
	},
	setPriority(id: string, priority: string): OpResult {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return { ok: false, msg: `no card ${id}` };
		if (!(PRIORITIES as readonly string[]).includes(priority)) return { ok: false, msg: `priority must be one of ${PRIORITIES.join(", ")}` };
		c.priority = priority as Priority;
		c.updatedAt = Date.now();
		saveBoard(b);
		return { ok: true, msg: cardLine(c), state: b };
	},
	setDue(id: string, due: string): OpResult {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return { ok: false, msg: `no card ${id}` };
		const p = parseDue(due);
		if (p.err) return { ok: false, msg: p.err };
		c.due = p.iso!;
		c.updatedAt = Date.now();
		saveBoard(b);
		return { ok: true, msg: cardLine(c), state: b };
	},
	done(id: string): OpResult {
		const b = loadBoard();
		const c = b.cards[id];
		if (!c) return { ok: false, msg: `no card ${id}` };
		c.status = "done";
		c.blockReason = undefined;
		c.updatedAt = Date.now();
		saveBoard(b);
		return { ok: true, msg: cardLine(c), state: b };
	},
	remove(id: string): OpResult {
		const b = loadBoard();
		if (!b.cards[id]) return { ok: false, msg: `no card ${id}` };
		delete b.cards[id];
		saveBoard(b);
		return { ok: true, msg: `removed ${id}`, state: b };
	},
	stats(): OpResult {
		const b = loadBoard();
		const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<string, number>;
		let overdue = 0;
		for (const c of Object.values(b.cards)) {
			counts[c.status] += 1;
			if (c.due && c.status !== "done" && new Date(c.due).getTime() < Date.now()) overdue += 1;
		}
		const parts = Object.keys(counts).filter((k) => counts[k] > 0).map((k) => `${k}=${counts[k]}`);
		if (overdue) parts.push(`overdue=${overdue}`);
		return { ok: true, msg: parts.join("  ") || "empty", state: b };
	},
	clearDone(): OpResult {
		const b = loadBoard();
		for (const k of Object.keys(b.cards)) if (b.cards[k].status === "done") delete b.cards[k];
		saveBoard(b);
		return { ok: true, msg: "cleared done cards", state: b };
	},
	wait(id: string, timeoutMs: number): Promise<OpResult> {
		return waitCard(id, timeoutMs).then((r) => {
			const b = loadBoard();
			const c = b.cards[id];
			if (!c) return { ok: false, msg: `no card ${id}`, state: b };
			if (r.stillRunning) return { ok: false, msg: `${id} still running after ${timeoutMs}ms — check later with list/show`, state: b };
			return { ok: true, msg: cardLine(c) + (c.report ? `\nreport: ${c.report}` : ""), state: b };
		});
	},
};

// ── TUI widget (command path; tool path skips — no UI there) ────────────
function widgetLines(b: Board): string[] {
	const cols: Array<[Status_, string]> = [["todo", "TODO"], ["ready", "READY"], ["review", "REVIEW"], ["done", "DONE"]];
	const lines: string[] = [];
	for (const [st, label] of cols) {
		const all = sortedCards(b).filter((c) => c.status === st);
		const cards = all.slice(0, 6);
		const extra = all.length - cards.length;
		lines.push(`${label} (${all.length}): ` + (cards.map((c) => c.id).join(", ") || "-") + (extra > 0 ? ` +${extra}` : ""));
	}
	const extras: string[] = [];
	const blocked = sortedCards(b).filter((c) => c.status === "blocked");
	if (blocked.length) extras.push(`BLOCKED: ${blocked.map((c) => `${c.id} (${c.blockReason ?? "?"})`).join(", ")}`);
	const sched = sortedCards(b).filter((c) => c.status === "scheduled");
	if (sched.length) extras.push(`SCHEDULED: ${sched.map((c) => c.id).join(", ")}`);
	const overdue = sortedCards(b).filter((c) => c.due && c.status !== "done" && new Date(c.due).getTime() < Date.now());
	if (overdue.length) extras.push(`OVERDUE: ${overdue.map((c) => c.id).join(", ")}`);
	const working = [...inFlight.keys()];
	if (working.length) extras.push(`WORKING: ${working.join(", ")}`);
	return lines.length ? [...lines, ...extras] : null!;
}

// ── extension wiring ────────────────────────────────────────────────────
export default function kanban(pi: ExtensionAPI): void {
	const ensureWidget = (ctx: ExtensionContext, state?: Board): void => {
		if (!ctx.hasUI) return;
		const lines = widgetLines(state ?? loadBoard());
		if (lines) ctx.ui.setWidget("waywiser-*:kanban", lines);
	};

	pi.on("session_start", (_e, ctx) => ensureWidget(ctx));

	const SUBDESCRIPTION =
		"new <title> | list | show <id> | move <id> <status> | assign <id> <name|subagent> " +
		"(subagent really spawns a leaf worker that files its report on the card) | block <id> <reason> | " +
		"resume <id> | note <id> <text> | report <id> <text> | pri <id> <low|med|high> | due <id> <@ISO|YYYY-MM-DD[Thh:mm]> | " +
		"wait <id> | done <id> | remove <id> | stats | clear-done | refresh";

	pi.registerCommand("kanban", {
		description: "Kanban board. " + SUBDESCRIPTION,
		handler: async (args, ctx: ExtensionContext) => {
			const [cmd, ...rest] = args.trim().split(/\s+/);
			const run = async (r: OpResult | Promise<OpResult>): Promise<void> => {
				const res = await r;
				if (res.ok) {
					ctx.ui.notify(res.msg, "info");
					ensureWidget(ctx, res.state);
				} else {
					ctx.ui.notify(res.msg, "error");
				}
			};
			switch (cmd) {
				case "new": return run(ops.newCard(rest.join(" ")));
				case "list": return run(ops.list());
				case "show": return run(ops.show(rest[0] ?? ""));
				case "move": return run(ops.move(rest[0] ?? "", rest[1] ?? ""));
				case "assign": return run(ops.assign(rest[0] ?? "", rest[1] ?? "", ctx.cwd));
				case "block": return run(ops.block(rest[0] ?? "", rest.slice(1).join(" ")));
				case "resume": return run(ops.resume(rest[0] ?? ""));
				case "note": return run(ops.note(rest[0] ?? "", rest.slice(1).join(" ")));
				case "report": return run(ops.report(rest[0] ?? "", rest.slice(1).join(" ")));
				case "pri": return run(ops.setPriority(rest[0] ?? "", rest[1] ?? ""));
				case "due": return run(ops.setDue(rest[0] ?? "", rest[1] ?? ""));
				case "wait": {
					const timeoutMs = rest[1] ? Number(rest[1]) : 120_000;
					ctx.ui.notify(`waiting up to ${Math.round(timeoutMs / 1000)}s for ${rest[0] ?? "-"}…`, "info");
					return run(ops.wait(rest[0] ?? "", Number.isFinite(timeoutMs) ? timeoutMs : 120_000));
				}
				case "done": return run(ops.done(rest[0] ?? ""));
				case "remove": return run(ops.remove(rest[0] ?? ""));
				case "stats": return run(ops.stats());
				case "clear-done": return run(ops.clearDone());
				case "refresh":
				case undefined: {
					ensureWidget(ctx);
					const b = loadBoard();
					const open = sortedCards(b).filter((c) => c.status !== "done");
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
			"Operate the Waywiser kanban board (same board as the /kanban command). " +
			"Use for multi-step or multi-agent work you want tracked across turns/sessions. " +
			"status: todo|ready|review|done|blocked|scheduled. " +
			"assign with who=subagent spawns a DETACHED leaf worker that works the card and files its report on it; " +
			"wait(id,timeout_ms?) blocks (bounded) until that worker finishes; one worker per card. " +
			"actions: new(title[, priority=low|med|high][, due=@ISO|YYYY-MM-DD[Thh:mm]]) | list | show(id) | move(id,status) | " +
			"assign(id,who) | block(id,reason) | resume(id) | note(id,text) | report(id,text) | pri(id,low|med|high) | " +
			"due(id,@ISO|YYYY-MM-DD[Thh:mm]) | wait(id,timeout_ms?) | done(id) | remove(id) | stats | clear_done",
		parameters: Type.Object({
			action: Type.String({ description: "new | list | show | move | assign | block | resume | note | report | pri | due | wait | done | remove | stats | clear_done" }),
			id: Type.Optional(Type.String({ description: "Card id (K1, K2, …)" })),
			title: Type.Optional(Type.String({ description: "For new" })),
			status: Type.Optional(Type.String({ description: "For move: todo|ready|review|done|blocked|scheduled" })),
			who: Type.Optional(Type.String({ description: "For assign: a name, or 'subagent' to spawn a worker" })),
			reason: Type.Optional(Type.String({ description: "For block" })),
			text: Type.Optional(Type.String({ description: "For note/report" })),
			priority: Type.Optional(Type.String({ description: "For pri, or at new: low|med|high" })),
			due: Type.Optional(Type.String({ description: "For due, or at new: @ISO or YYYY-MM-DD[Thh:mm]" })),
			timeout: Type.Optional(Type.Number({ description: "For wait: max ms to block (default 120000, max 300000)" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, _signal, _update, ctx: ExtensionContext) {
			const a = (p.action ?? "").trim();
			const r: OpResult | Promise<OpResult> =
				a === "new" ? ops.newCard(p.title ?? "", { priority: p.priority?.trim() || undefined, due: p.due?.trim() || undefined })
				: a === "list" ? ops.list()
				: a === "show" ? ops.show(p.id ?? "")
				: a === "move" ? ops.move(p.id ?? "", p.status ?? "")
				: a === "assign" ? ops.assign(p.id ?? "", p.who ?? "", ctx.cwd)
				: a === "block" ? ops.block(p.id ?? "", p.reason ?? "")
				: a === "resume" ? ops.resume(p.id ?? "")
				: a === "note" ? ops.note(p.id ?? "", p.text ?? "")
				: a === "report" ? ops.report(p.id ?? "", p.text ?? "")
				: a === "pri" ? ops.setPriority(p.id ?? "", p.priority ?? "")
				: a === "due" ? ops.setDue(p.id ?? "", p.due ?? "")
				: a === "wait" ? ops.wait(p.id ?? "", Math.min(Math.max(p.timeout ?? 120_000, 1000), 300_000))
				: a === "done" ? ops.done(p.id ?? "")
				: a === "remove" ? ops.remove(p.id ?? "")
				: a === "stats" ? ops.stats()
				: a === "clear_done" ? ops.clearDone()
				: { ok: false, msg: `unknown kanban action "${a}" (see tool description)` };
			const res = await r;
			return mkTool(res.msg, !res.ok);
		},
	});
}

function mkTool(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

// Exported for tests / other modules.
export { ops as boardOps, STATUSES, PRIORITIES, parseDue, widgetLines, loadBoard };
