/**
 * Shared time module — single source of truth for all timestamp
 * formatting, parsing, and timezone handling across Waywiser.
 *
 * All formatters accept ISO strings (both SQLite "YYYY-MM-DD HH:MM:SS"
 * and JS "YYYY-MM-DDTHH:MM:SS.sssZ") or epoch ms, and output in the
 * user's configured timezone.
 */
import * as path from "node:path";
import { readJSON } from "./state.js";

// ── timezone ──────────────────────────────────────────────────────────

function configFile(): string {
	const home = process.env.WAYWISER_HOME || path.join(process.env.HOME || ".", ".waywiser");
	return path.join(home, "config.json");
}

export function isValidTz(tz: string): boolean {
	try {
		Intl.DateTimeFormat("en", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

export function userTz(): string {
	try {
		const cfg = readJSON<{ timezone?: string }>(configFile(), {});
		if (cfg.timezone && isValidTz(cfg.timezone)) return cfg.timezone;
	} catch {
		// Config unreadable — fall through to system TZ.
	}
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ── parsing ───────────────────────────────────────────────────────────

/**
 * Parse a timestamp from SQLite format, JS ISO format, or epoch ms.
 * SQLite format ("YYYY-MM-DD HH:MM:SS") is treated as UTC.
 */
export function parseTs(v: string | number): number {
	if (typeof v === "number") return v;
	// SQLite format has a space separator and no trailing Z — treat as UTC
	const normalized = v.includes("T") ? v : v.replace(" ", "T") + "Z";
	const ms = Date.parse(normalized);
	if (Number.isNaN(ms)) throw new Error(`invalid timestamp: ${v}`);
	return ms;
}

// ── core formatters ───────────────────────────────────────────────────

/** "14:23" — time only in user timezone. */
export function fmtTime(v: string | number): string {
	const d = new Date(parseTs(v));
	return d.toLocaleTimeString("en-GB", {
		timeZone: userTz(),
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

/** "Aug 24" — month + day in user timezone. */
export function fmtDate(v: string | number): string {
	const d = new Date(parseTs(v));
	return d.toLocaleDateString("en-US", {
		timeZone: userTz(),
		month: "short",
		day: "numeric",
	});
}

/** "Aug 24, 14:23" — cross-year adds year: "Aug 24 2025, 14:23". */
export function fmtDateTime(v: string | number): string {
	const d = new Date(parseTs(v));
	const tz = userTz();
	const now = new Date();
	const thisYear = now.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
	const thatYear = d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
	const datePart = fmtDate(v);
	const timePart = fmtTime(v);
	if (thisYear !== thatYear) return `${datePart} ${thatYear}, ${timePart}`;
	return `${datePart}, ${timePart}`;
}

/**
 * Smart stamp: same day → "14:23", cross-day → "Aug 24, 14:23".
 * Primary formatter for TUI display. Unlike fmtDateTime, never adds a
 * year — cross-day is enough context for a live status line.
 */
export function fmtStamp(v: string | number): string {
	const d = new Date(parseTs(v));
	const tz = userTz();
	const now = new Date();
	const todayStr = now.toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
	const thatStr = d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
	if (todayStr === thatStr) return fmtTime(v);
	return `${fmtDate(v)}, ${fmtTime(v)}`;
}

/** "2026-08-24" — ISO date in user timezone (for persistence, SOUL.md stamps). */
export function fmtDateOnly(v: string | number): string {
	const d = new Date(parseTs(v));
	const tz = userTz();
	const y = d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
	const m = d.toLocaleDateString("en-US", { timeZone: tz, month: "2-digit" });
	const day = d.toLocaleDateString("en-US", { timeZone: tz, day: "2-digit" });
	return `${y}-${m}-${day}`;
}

/** Full ISO string (re-emit from parsed input). */
export function fmtIso(v: string | number): string {
	return new Date(parseTs(v)).toISOString();
}

// ── duration / age ────────────────────────────────────────────────────

/**
 * Format a duration in ms as human-readable:
 * 0-59s → "Xs", 1-59m → "Xm Ys", 1-23h → "Xh Ym", 1d+ → "Xd Yh"
 */
export function fmtDuration(ms: number): string {
	const abs = Math.max(0, Math.round(ms / 1000));
	if (abs < 60) return `${abs}s`;
	if (abs < 3600) {
		const m = Math.floor(abs / 60);
		const s = abs % 60;
		return s > 0 ? `${m}m ${s}s` : `${m}m`;
	}
	if (abs < 86400) {
		const h = Math.floor(abs / 3600);
		const m = Math.floor((abs % 3600) / 60);
		return m > 0 ? `${h}h ${m}m` : `${h}h`;
	}
	const d = Math.floor(abs / 86400);
	const h = Math.floor((abs % 86400) / 3600);
	return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Human-readable age: "2m ago", "3h ago", "3d ago". */
export function fmtAge(v: string | number): string {
	const then = parseTs(v);
	const diff = Date.now() - then;
	return diff >= 0 ? `${fmtDuration(diff)} ago` : `in ${fmtDuration(-diff)}`;
}

// ── convenience ───────────────────────────────────────────────────────

/** Current time as ISO string. */
export function nowIso(): string {
	return new Date().toISOString();
}

/** Current time as epoch ms. */
export function nowEpoch(): number {
	return Date.now();
}
