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
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { db_, waywiserHome, readJSON, shortId, registry_ } from "./utils/state.js";
import { createPiRpcClient, type PiRpcClient } from "./utils/rpc.js";
import { startBoardServer, broadcastEvent, setHtmlGenerator } from "./kanban-server.js";
import { generateBoardHtml, generateStaticSnapshot, type BoardRow, type CardRow } from "./kanban-html.js";

const STATUSES = ["todo", "doing", "review", "done", "blocked"] as const;
type Status_ = (typeof STATUSES)[number];
const PRIORITIES = ["low", "med", "high", "critical"] as const;
type Priority = (typeof PRIORITIES)[number];
const CARD_TYPES = ["task", "idea", "bug"] as const;
type CardType = (typeof CARD_TYPES)[number];

type OpResult = { ok: boolean; msg: string };

// Active board is per-process (not persisted across restarts); defaults to 'default'.
let activeBoardId = "default";
let serverPort = 7749;
let serverHandle: { port: number; close: () => void } | undefined;

const inFlight = new Map<string, "running">(); // cardId → in-flight worker

// ── due parsing (unchanged from the JSON-backed version) ────────────────
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

function isOverdue(c: CardRow): boolean {
	return !!c.due && c.status !== "done" && new Date(c.due).getTime() < Date.now();
}

function slugify(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
}

// ── DB helpers ────────────────────────────────────────────────────────
const CARD_ORDER =
	"ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, " +
	"CASE WHEN due IS NULL THEN 1 ELSE 0 END, due ASC, id ASC";

function getBoards(): BoardRow[] {
	return db_().prepare("SELECT * FROM boards WHERE archived = 0 ORDER BY (id = 'default') DESC, name ASC").all() as BoardRow[];
}
function getAllBoards(): BoardRow[] {
	return db_().prepare("SELECT * FROM boards ORDER BY (id = 'default') DESC, name ASC").all() as BoardRow[];
}
function getBoard(id: string): BoardRow | undefined {
	return db_().prepare("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined;
}
function ensureBoard(id: string, name?: string): void {
	db_().prepare("INSERT OR IGNORE INTO boards (id, name) VALUES (?, ?)").run(id, name ?? id);
}
function getCards(boardId?: string): CardRow[] {
	if (boardId) return db_().prepare(`SELECT * FROM cards WHERE board_id = ? ${CARD_ORDER}`).all(boardId) as CardRow[];
	return db_().prepare(`SELECT * FROM cards ${CARD_ORDER.replace("ORDER BY", "ORDER BY board_id,")}`).all() as CardRow[];
}
function getCard(id: string): CardRow | undefined {
	return db_().prepare("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined;
}
function nextCardId(): string {
	const row = db_().prepare("SELECT id FROM cards ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) DESC LIMIT 1").get() as { id: string } | undefined;
	const num = row ? parseInt(row.id.slice(1), 10) + 1 : 1;
	return `K${num}`;
}

// ── one-time JSON → SQLite migration ─────────────────────────────────
interface OldCard {
	id: string; title: string; status: string; assignee?: string; blockReason?: string;
	notes?: string; report?: string; priority?: string; due?: string; workerChild?: string;
	createdAt: number; updatedAt: number;
}
interface OldBoard { seq: number; cards: Record<string, OldCard>; }

const OLD_STATUS_MAP: Record<string, Status_> = { todo: "todo", ready: "doing", review: "review", done: "done", blocked: "blocked", scheduled: "todo" };

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
			const priority: Priority = c.priority && (PRIORITIES as readonly string[]).includes(c.priority) ? (c.priority as Priority) : "med";
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

// ── debounced Markdown + static HTML regeneration ────────────────────
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh(): void {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = undefined;
		try {
			const boards = getBoards();
			const cards = getCards();
			const boardsDir = path.join(waywiserHome(), "boards");
			fs.mkdirSync(boardsDir, { recursive: true });
			for (const board of boards) {
				const boardCards = cards.filter((c) => c.board_id === board.id);
				fs.writeFileSync(path.join(boardsDir, `${board.id}.md`), generateMarkdown(board, boardCards));
			}
			const html = generateStaticSnapshot(boards, cards, activeBoardId);
			fs.writeFileSync(path.join(waywiserHome(), "board.html"), html);
		} catch (e) {
			process.stderr.write(`waywiser/kanban: refresh failed: ${e instanceof Error ? e.message : String(e)}\n`);
		}
	}, 500);
}

// ── Markdown export ───────────────────────────────────────────────────
function fmtShortDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function mdCardLine(c: CardRow): string {
	const pri = c.priority && c.priority !== "med" ? ` \`${c.priority}\`` : "";
	const due = c.due ? ` \`due:${fmtShortDate(c.due)}\`` : "";
	const typeTag = c.type === "idea" ? " 💡idea" : c.type === "bug" ? " 🐛bug" : "";
	const overdueTag = isOverdue(c) ? " ⚠️OVERDUE" : "";
	const assignee = c.assignee ? ` → ${c.assignee}` : "";
	const line = `- [ ] **${c.id}** ${c.title}${pri}${due}${typeTag}${overdueTag}${assignee}`;
	const extra: string[] = [];
	if (c.status === "blocked" && c.block_reason) extra.push(`  > ${c.block_reason.slice(0, 200)}`);
	if (c.notes) extra.push(`  > ${c.notes.slice(0, 200)}`);
	if (c.report) extra.push(`  > Report: ${c.report.slice(0, 200)}`);
	return extra.length ? `${line}\n${extra.join("\n")}` : line;
}

function generateMarkdown(board: BoardRow, cards: CardRow[]): string {
	const open = cards.filter((c) => c.status !== "done").length;
	const overdue = cards.filter((c) => isOverdue(c)).length;
	const done = cards.filter((c) => c.status === "done").length;

	const lines: string[] = [
		"<!-- generated by waywiser — edits will be overwritten on next board change -->",
		`# Board: ${board.name}`,
		"",
		`> ${open} open · ${overdue} overdue · ${done} done`,
	];

	const section = (title: string, status: Status_): void => {
		const rows = cards.filter((c) => c.status === status);
		if (!rows.length) return;
		lines.push("", `## ${title}`, ...rows.map(mdCardLine));
	};
	section("⚡ Doing", "doing");
	section("📋 Todo", "todo");
	section("🔍 Review", "review");
	section("🔴 Blocked", "blocked");

	const doneRows = cards.filter((c) => c.status === "done");
	if (doneRows.length) {
		lines.push("", "## ✅ Done", ...doneRows.map((c) => `- [x] ~~${c.id} ${c.title}~~ · ${fmtShortDate(c.updated_at)}`));
	}

	return `${lines.join("\n")}\n`;
}

// ── card line (TUI/tool text) ────────────────────────────────────────
function cardLine(c: CardRow): string {
	const pri = c.priority && c.priority !== "med" ? ` [${c.priority}]` : "";
	const typeTag = c.type === "idea" ? " 💡" : c.type === "bug" ? " 🐛" : "";
	const due = c.due
		? c.status === "done"
			? ` (was due ${c.due.slice(0, 16).replace("T", " ")})`
			: isOverdue(c)
				? ` (OVERDUE since ${c.due.slice(0, 16).replace("T", " ")})`
				: ` (due ${c.due.slice(0, 16).replace("T", " ")})`
		: "";
	return `${c.id}${pri} [${c.status}]${typeTag} ${c.title}${c.assignee ? ` → ${c.assignee}` : ""}${c.block_reason ? ` (block: ${c.block_reason})` : ""}${due}`;
}

// ── subagent spawning (SQLite-backed) ────────────────────────────────
async function spawnCard(c: CardRow, cwd: string, timeoutMs: number): Promise<OpResult> {
	if (inFlight.has(c.id)) {
		return { ok: false, msg: `${c.id} already has a worker running (${c.worker_child ?? "?"}) — one worker per card` };
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
	const workerChild = shortId("kc");
	db_().prepare("UPDATE cards SET worker_child = ?, status = 'doing', updated_at = datetime('now') WHERE id = ?").run(workerChild, c.id);
	broadcastEvent("card_updated", getCard(c.id));
	scheduleRefresh();
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
			// Re-read the card (not the stale copy): it may have moved since spawn.
			const c2 = getCard(c.id);
			if (c2) {
				const nextStatus: Status_ = c2.status === "doing" ? (report.startsWith("WAYWISER_REPORT:") ? "review" : "doing") : (c2.status as Status_);
				db_().prepare("UPDATE cards SET report = ?, worker_child = NULL, status = ?, updated_at = datetime('now') WHERE id = ?").run(report, nextStatus, c.id);
				broadcastEvent("card_updated", getCard(c.id));
				registry_().log("kanban", `${c.id} worker finished → ${nextStatus}`);
			}
			scheduleRefresh();
		}
	};
	void run(); // detached; progress is on the card, report written on completion
	return { ok: true, msg: `worker ${workerChild} spawned for ${c.id} (detached) — report will land on the card on completion; use action=wait or list to check` };
}

// Wait for a card's worker (bounded). Used by tool action=wait.
async function waitCard(id: string, timeoutMs: number): Promise<{ report?: string; stillRunning: boolean }> {
	const t0 = Date.now();
	while (inFlight.has(id) && Date.now() - t0 < timeoutMs) {
		await new Promise((r) => setTimeout(r, 1000));
	}
	if (inFlight.has(id)) return { stillRunning: true };
	const c = getCard(id);
	return { report: c?.report ?? undefined, stillRunning: false };
}

// ── shared ops (command and tool both call these) ────────────────────
const ops = {
	newCard(title: string, extra?: { priority?: string; due?: string; type?: string; board?: string }): OpResult {
		if (!title.trim()) return { ok: false, msg: "usage: new <title> [priority=low|med|high|critical] [due=@ISO|YYYY-MM-DD[Thh:mm]] [type=task|idea|bug]" };
		if (extra?.priority && !(PRIORITIES as readonly string[]).includes(extra.priority)) return { ok: false, msg: `priority must be one of ${PRIORITIES.join(", ")}` };
		if (extra?.type && !(CARD_TYPES as readonly string[]).includes(extra.type)) return { ok: false, msg: `type must be one of ${CARD_TYPES.join(", ")}` };
		const dueP = extra?.due ? parseDue(extra.due) : {};
		if (dueP.err) return { ok: false, msg: dueP.err };
		const boardId = extra?.board ? slugify(extra.board) : activeBoardId;
		ensureBoard(boardId);
		const id = nextCardId();
		db_()
			.prepare("INSERT INTO cards (id, board_id, title, type, status, priority, due) VALUES (?, ?, ?, ?, 'todo', ?, ?)")
			.run(id, boardId, title.trim(), (extra?.type as CardType) ?? "task", (extra?.priority as Priority) ?? "med", dueP.iso ?? null);
		const card = getCard(id)!;
		broadcastEvent("card_created", card);
		scheduleRefresh();
		return { ok: true, msg: cardLine(card) };
	},
	list(boardId?: string): OpResult {
		const cards = getCards(boardId ?? activeBoardId);
		return { ok: true, msg: cards.length ? cards.map(cardLine).join("\n") : "Board is empty." };
	},
	show(id: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		return {
			ok: true,
			msg:
				cardLine(c) +
				`\nboard: ${c.board_id}` +
				`\ncreated ${c.created_at}\nupdated ${c.updated_at}` +
				(c.notes ? `\nnotes: ${c.notes}` : "") +
				(c.report ? `\nreport: ${c.report}` : "") +
				(inFlight.has(c.id) ? `\n(worker running: ${c.worker_child ?? "?"})` : ""),
		};
	},
	move(id: string, status: string, boardId?: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		if (!(STATUSES as readonly string[]).includes(status)) return { ok: false, msg: `status must be one of ${STATUSES.join(", ")}` };
		if (inFlight.has(c.id) && status !== "doing") return { ok: false, msg: `${c.id} has a worker running — wait for it (action=wait) before moving it elsewhere` };
		const targetBoard = boardId ? slugify(boardId) : c.board_id;
		if (boardId) ensureBoard(targetBoard);
		const blockReason = status === "blocked" ? c.block_reason : null;
		db_().prepare("UPDATE cards SET status = ?, board_id = ?, block_reason = ?, updated_at = datetime('now') WHERE id = ?").run(status, targetBoard, blockReason, id);
		const updated = getCard(id)!;
		broadcastEvent("card_updated", updated);
		scheduleRefresh();
		return { ok: true, msg: cardLine(updated) };
	},
	assign(id: string, who: string, cwd: string, timeoutMs?: number): Promise<OpResult> {
		const c = getCard(id);
		if (!c) return Promise.resolve({ ok: false, msg: `no card ${id}` });
		if (!who) return Promise.resolve({ ok: false, msg: "usage: assign <id> <name|subagent>" });
		db_().prepare("UPDATE cards SET assignee = ?, updated_at = datetime('now') WHERE id = ?").run(who, id);
		if (who === "subagent") {
			const c2 = getCard(id)!;
			return spawnCard(c2, cwd, timeoutMs ?? 900_000).then((r) =>
				r.ok ? { ok: true, msg: `${cardLine(getCard(id)!)} — ${r.msg}` } : { ok: false, msg: `assign ${id} subagent: ${r.msg}` },
			);
		}
		const updated = getCard(id)!;
		broadcastEvent("card_updated", updated);
		scheduleRefresh();
		return Promise.resolve({ ok: true, msg: cardLine(updated) });
	},
	block(id: string, reason: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		db_().prepare("UPDATE cards SET status = 'blocked', block_reason = ?, updated_at = datetime('now') WHERE id = ?").run(reason || "unspecified", id);
		const updated = getCard(id)!;
		broadcastEvent("card_updated", updated);
		scheduleRefresh();
		return { ok: true, msg: cardLine(updated) };
	},
	resume(id: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		db_().prepare("UPDATE cards SET status = 'todo', block_reason = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
		const updated = getCard(id)!;
		broadcastEvent("card_updated", updated);
		scheduleRefresh();
		return { ok: true, msg: cardLine(updated) };
	},
	note(id: string, text: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		if (!text.trim()) return { ok: false, msg: "usage: note <id> <text>" };
		db_().prepare("UPDATE cards SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(text.trim(), id);
		broadcastEvent("card_updated", getCard(id));
		scheduleRefresh();
		return { ok: true, msg: `note set on ${id}` };
	},
	report(id: string, text: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		if (!text.trim()) return { ok: false, msg: "usage: report <id> <text>" };
		db_().prepare("UPDATE cards SET report = ?, updated_at = datetime('now') WHERE id = ?").run(text.trim(), id);
		broadcastEvent("card_updated", getCard(id));
		scheduleRefresh();
		return { ok: true, msg: `report recorded on ${id}` };
	},
	setPriority(id: string, priority: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		if (!(PRIORITIES as readonly string[]).includes(priority)) return { ok: false, msg: `priority must be one of ${PRIORITIES.join(", ")}` };
		db_().prepare("UPDATE cards SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(priority, id);
		const updated = getCard(id)!;
		broadcastEvent("card_updated", updated);
		scheduleRefresh();
		return { ok: true, msg: cardLine(updated) };
	},
	setDue(id: string, due: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		const p = parseDue(due);
		if (p.err) return { ok: false, msg: p.err };
		db_().prepare("UPDATE cards SET due = ?, updated_at = datetime('now') WHERE id = ?").run(p.iso!, id);
		const updated = getCard(id)!;
		broadcastEvent("card_updated", updated);
		scheduleRefresh();
		return { ok: true, msg: cardLine(updated) };
	},
	setType(id: string, type: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		if (!(CARD_TYPES as readonly string[]).includes(type)) return { ok: false, msg: `type must be one of ${CARD_TYPES.join(", ")}` };
		db_().prepare("UPDATE cards SET type = ?, updated_at = datetime('now') WHERE id = ?").run(type, id);
		const updated = getCard(id)!;
		broadcastEvent("card_updated", updated);
		scheduleRefresh();
		return { ok: true, msg: cardLine(updated) };
	},
	done(id: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		db_().prepare("UPDATE cards SET status = 'done', block_reason = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
		const updated = getCard(id)!;
		broadcastEvent("card_updated", updated);
		scheduleRefresh();
		return { ok: true, msg: cardLine(updated) };
	},
	remove(id: string): OpResult {
		const c = getCard(id);
		if (!c) return { ok: false, msg: `no card ${id}` };
		db_().prepare("DELETE FROM cards WHERE id = ?").run(id);
		broadcastEvent("card_deleted", { id });
		scheduleRefresh();
		return { ok: true, msg: `removed ${id}` };
	},
	stats(boardId?: string): OpResult {
		const cards = getCards(boardId ?? activeBoardId);
		const counts: Record<string, number> = {};
		let overdue = 0;
		for (const c of cards) {
			counts[c.status] = (counts[c.status] ?? 0) + 1;
			if (isOverdue(c)) overdue += 1;
		}
		const parts = Object.keys(counts).filter((k) => counts[k] > 0).map((k) => `${k}=${counts[k]}`);
		if (overdue) parts.push(`overdue=${overdue}`);
		return { ok: true, msg: parts.join("  ") || "empty" };
	},
	clearDone(boardId?: string): OpResult {
		const b = boardId ?? activeBoardId;
		db_().prepare("DELETE FROM cards WHERE board_id = ? AND status = 'done'").run(b);
		broadcastEvent("board_changed", { boardId: b, action: "clear_done" });
		scheduleRefresh();
		return { ok: true, msg: "cleared done cards" };
	},
	wait(id: string, timeoutMs: number): Promise<OpResult> {
		return waitCard(id, timeoutMs).then((r) => {
			const c = getCard(id);
			if (!c) return { ok: false, msg: `no card ${id}` };
			if (r.stillRunning) return { ok: false, msg: `${id} still running after ${timeoutMs}ms — check later with list/show` };
			return { ok: true, msg: cardLine(c) + (c.report ? `\nreport: ${c.report}` : "") };
		});
	},
	// ── multi-board ops (Phase 2) ────────────────────────────────────
	boards(): OpResult {
		const boards = getAllBoards();
		if (!boards.length) return { ok: true, msg: "no boards" };
		const cards = getCards();
		const lines = boards.map((b) => {
			const bc = cards.filter((c) => c.board_id === b.id);
			const overdue = bc.filter((c) => isOverdue(c)).length;
			return `${b.id === activeBoardId ? "* " : "  "}${b.id} — ${b.name} (${bc.length} cards${overdue ? `, ${overdue} overdue` : ""})${b.archived ? " [archived]" : ""}`;
		});
		return { ok: true, msg: lines.join("\n") };
	},
	boardSwitch(idOrName: string): OpResult {
		if (!idOrName.trim()) return { ok: false, msg: "usage: board <name>" };
		const id = slugify(idOrName);
		const existing = getBoard(id);
		if (!existing) {
			db_().prepare("INSERT INTO boards (id, name) VALUES (?, ?)").run(id, idOrName.trim());
			broadcastEvent("board_changed", { boardId: id, action: "created" });
		} else if (existing.archived) {
			db_().prepare("UPDATE boards SET archived = 0 WHERE id = ?").run(id);
			broadcastEvent("board_changed", { boardId: id, action: "unarchived" });
		}
		activeBoardId = id;
		scheduleRefresh();
		return { ok: true, msg: `switched to board "${id}"` };
	},
	boardCreate(name: string, description?: string): OpResult {
		if (!name.trim()) return { ok: false, msg: "usage: board create <name> [description]" };
		const id = slugify(name);
		if (getBoard(id)) return { ok: false, msg: `board "${id}" already exists` };
		db_().prepare("INSERT INTO boards (id, name, description) VALUES (?, ?, ?)").run(id, name.trim(), description?.trim() || null);
		broadcastEvent("board_changed", { boardId: id, action: "created" });
		scheduleRefresh();
		return { ok: true, msg: `created board "${id}"` };
	},
	boardArchive(idOrName: string): OpResult {
		if (!idOrName.trim()) return { ok: false, msg: "usage: board archive <name>" };
		const id = slugify(idOrName);
		if (id === "default") return { ok: false, msg: "cannot archive the default board" };
		if (!getBoard(id)) return { ok: false, msg: `no board ${id}` };
		db_().prepare("UPDATE boards SET archived = 1 WHERE id = ?").run(id);
		if (activeBoardId === id) activeBoardId = "default";
		broadcastEvent("board_changed", { boardId: id, action: "archived" });
		scheduleRefresh();
		return { ok: true, msg: `archived board "${id}"` };
	},
	boardDelete(idOrName: string): OpResult {
		if (!idOrName.trim()) return { ok: false, msg: "usage: board delete <name>" };
		const id = slugify(idOrName);
		if (id === "default") return { ok: false, msg: "cannot delete the default board" };
		if (!getBoard(id)) return { ok: false, msg: `no board ${id}` };
		db_().prepare("DELETE FROM cards WHERE board_id = ?").run(id);
		db_().prepare("DELETE FROM boards WHERE id = ?").run(id);
		if (activeBoardId === id) activeBoardId = "default";
		broadcastEvent("board_changed", { boardId: id, action: "deleted" });
		scheduleRefresh();
		return { ok: true, msg: `deleted board "${id}" and its cards` };
	},
	search(query: string): OpResult {
		const q = query.trim();
		if (!q) return { ok: false, msg: "usage: search <query>" };
		const like = `%${q}%`;
		const rows = db_().prepare(`SELECT * FROM cards WHERE title LIKE ? OR notes LIKE ? OR report LIKE ? ${CARD_ORDER.replace("ORDER BY", "ORDER BY board_id,")}`).all(like, like, like) as CardRow[];
		if (!rows.length) return { ok: true, msg: `no cards matching "${q}"` };
		return { ok: true, msg: rows.map((c) => `[${c.board_id}] ${cardLine(c)}`).join("\n") };
	},
};

// ── TUI widget ─────────────────────────────────────────────────────────
function widgetText(): string {
	const cards = getCards(activeBoardId);
	const counts: Record<string, number> = {};
	let overdue = 0;
	for (const c of cards) {
		counts[c.status] = (counts[c.status] ?? 0) + 1;
		if (isOverdue(c)) overdue++;
	}
	const parts = STATUSES.filter((s) => s !== "blocked").map((s) => `${s.toUpperCase()}(${counts[s] ?? 0})`);
	if (counts.blocked) parts.push(`BLOCKED(${counts.blocked})`);
	if (overdue) parts.push(`${overdue} OVERDUE`);
	if (inFlight.size) parts.push(`${inFlight.size} WORKING`);
	return `BOARD: ${activeBoardId} | ${parts.join(" ")}`;
}

function ensureWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const cards = getCards(activeBoardId);
	if (!cards.length) return;
	ctx.ui.setWidget("waywiser-*:kanban", [widgetText()]);
}

function openInBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	exec(`${cmd} "${url}"`, () => {
		/* best-effort; failures are silent (headless envs, no DISPLAY, etc.) */
	});
}

// ── extension wiring ────────────────────────────────────────────────────
export default function kanban(pi: ExtensionAPI): void {
	// 1. Migrate from the legacy JSON store (one-time, idempotent).
	migrateFromJson();

	// 2. Start the localhost board server (127.0.0.1, ports 7749..7759).
	startBoardServer(serverPort)
		.then((h) => {
			serverHandle = h;
			serverPort = h.port;
			setHtmlGenerator(() => generateBoardHtml(getBoards(), getCards(), activeBoardId, serverPort));
			process.stderr.write(`waywiser/board: live at http://localhost:${serverPort}/\n`);
			scheduleRefresh();
		})
		.catch((e) => {
			process.stderr.write(`waywiser/board: server failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
		});

	pi.on("session_start", (_e, ctx) => ensureWidget(ctx));

	// 3. Session-start-adjacent: inject open cards into the system prompt so the
	// model sees board state even in non-TUI modes (e.g. `waywiser -p`).
	pi.on("before_agent_start", (event) => {
		const cards = getCards(activeBoardId).filter((c) => c.status !== "done");
		if (!cards.length) return;
		const summary = cards
			.map((c) => `${c.id} [${c.status}/${c.priority}] ${c.title}${c.due ? ` (due ${c.due.slice(0, 10)})` : ""}${c.assignee ? ` → ${c.assignee}` : ""}`)
			.join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n[Kanban — ${cards.length} open]\n${summary}` };
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
					const boardArg = bIdx !== -1 ? rest[bIdx + 1] : undefined;
					const statusArgs = bIdx !== -1 ? rest.slice(0, bIdx) : rest;
					return run(ops.move(statusArgs[0] ?? "", statusArgs[1] ?? "", boardArg));
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
					const open = getCards(activeBoardId).filter((c) => c.status !== "done");
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
			id: Type.Optional(Type.String({ description: "Card id (K1, K2, …)" })),
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
			const a = (p.action ?? "").trim();
			const board = p.board?.trim() || undefined;
			const r: OpResult | Promise<OpResult> =
				a === "new" ? ops.newCard(p.title ?? "", { priority: p.priority?.trim() || undefined, due: p.due?.trim() || undefined, type: p.type?.trim() || undefined, board })
				: a === "list" ? ops.list(board)
				: a === "show" ? ops.show(p.id ?? "")
				: a === "move" ? ops.move(p.id ?? "", p.status ?? "", board)
				: a === "assign" ? ops.assign(p.id ?? "", p.who ?? "", ctx.cwd)
				: a === "block" ? ops.block(p.id ?? "", p.reason ?? "")
				: a === "resume" ? ops.resume(p.id ?? "")
				: a === "note" ? ops.note(p.id ?? "", p.text ?? "")
				: a === "report" ? ops.report(p.id ?? "", p.text ?? "")
				: a === "pri" ? ops.setPriority(p.id ?? "", p.priority ?? "")
				: a === "due" ? ops.setDue(p.id ?? "", p.due ?? "")
				: a === "type" ? ops.setType(p.id ?? "", p.type ?? "")
				: a === "wait" ? ops.wait(p.id ?? "", Math.min(Math.max(p.timeout ?? 120_000, 1000), 300_000))
				: a === "done" ? ops.done(p.id ?? "")
				: a === "remove" ? ops.remove(p.id ?? "")
				: a === "stats" ? ops.stats(board)
				: a === "clear_done" ? ops.clearDone(board)
				: a === "search" ? ops.search(p.query ?? "")
				: a === "boards" ? ops.boards()
				: a === "board" ? ops.boardSwitch(board ?? p.title ?? "")
				: a === "board_create" ? ops.boardCreate(board ?? p.title ?? "", p.description)
				: a === "board_archive" ? ops.boardArchive(board ?? "")
				: a === "board_delete" ? ops.boardDelete(board ?? "")
				: a === "open" ? (() => {
					const url = `http://localhost:${serverPort}/`;
					openInBrowser(url);
					return { ok: true, msg: `opening ${url}` } as OpResult;
				})()
				: { ok: false, msg: `unknown kanban action "${a}" (see tool description)` };
			const res = await r;
			return mkTool(res.msg, !res.ok);
		},
	});

	// 4. Shutdown: stop the debounce timer and close the HTTP server.
	pi.on("session_shutdown", () => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = undefined;
		}
		serverHandle?.close();
	});
}

function mkTool(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

// Exported for tests / other modules.
export { ops as boardOps, STATUSES, PRIORITIES, CARD_TYPES, parseDue, widgetText, getBoards, getCards, getCard, generateMarkdown };
