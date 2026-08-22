/**
 * kanban/shared.ts — types, constants, and DB helpers shared by every kanban
 * module (ops.ts, worker.ts, index.ts) AND by kanban-server.ts.
 *
 * Single definition of everything that used to be duplicated between
 * kanban.ts and kanban-server.ts (CARD_ORDER, nextCardId, slugify, CardRow).
 */
import { randomUUID } from "node:crypto";
import { db_ } from "../utils/state.js";
import type { BoardRow, CardRow } from "../kanban-html.js";

export type { BoardRow, CardRow } from "../kanban-html.js";

export type OpResult = { ok: boolean; msg: string };

export const STATUSES = ["todo", "doing", "review", "done", "blocked"] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ["low", "med", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CARD_TYPES = ["task", "idea", "bug"] as const;
export type CardType = (typeof CARD_TYPES)[number];

/**
 * Single definition of the card ordering SQL fragment.
 *
 * Previously duplicated in kanban.ts:93 and kanban-server.ts:27.
 */
export const CARD_ORDER =
	"ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, " +
	"CASE WHEN due IS NULL THEN 1 ELSE 0 END, due ASC, id ASC";

/**
 * Race-safe card ID: 8-char random hex prefix.
 *
 * Replaces the old sequential SELECT MAX + increment, which was duplicated
 * in kanban.ts:117 and kanban-server.ts:60 and racy under concurrent
 * REST + TUI use (Finding #30).
 */
export function nextCardId(): string {
	return `K${randomUUID().slice(0, 8)}`;
}

export function slugify(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
}

// ── due parsing (unchanged from the original kanban.ts) ─────────────────
export const parseDue = (raw?: string): { iso?: string; err?: string } => {
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

export function isOverdue(c: CardRow): boolean {
	return !!c.due && c.status !== "done" && new Date(c.due).getTime() < Date.now();
}

// ── shared DB accessors used by both ops.ts and kanban-server.ts ────────
export function getBoards(): BoardRow[] {
	return db_().prepare("SELECT * FROM boards WHERE archived = 0 ORDER BY (id = 'default') DESC, name ASC").all() as BoardRow[];
}
export function getAllBoards(): BoardRow[] {
	return db_().prepare("SELECT * FROM boards ORDER BY (id = 'default') DESC, name ASC").all() as BoardRow[];
}
export function getBoard(id: string): BoardRow | undefined {
	return db_().prepare("SELECT * FROM boards WHERE id = ?").get(id) as BoardRow | undefined;
}
export function ensureBoard(id: string, name?: string): void {
	db_().prepare("INSERT OR IGNORE INTO boards (id, name) VALUES (?, ?)").run(id, name ?? id);
}
export function getCards(boardId?: string): CardRow[] {
	if (boardId) return db_().prepare(`SELECT * FROM cards WHERE board_id = ? ${CARD_ORDER}`).all(boardId) as CardRow[];
	return db_().prepare(`SELECT * FROM cards ${CARD_ORDER.replace("ORDER BY", "ORDER BY board_id,")}`).all() as CardRow[];
}
export function getCard(id: string): CardRow | undefined {
	return db_().prepare("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined;
}
