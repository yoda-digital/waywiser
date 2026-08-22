/**
 * Structured trace events.
 *
 * Typed, machine-parseable journey entries that replace/augment the legacy
 * text-only `registry_().log(kind, text)`. The journey table schema is
 * unchanged: `(id INTEGER, kind TEXT, text TEXT, created_at TEXT)` — the
 * `text` column now stores `JSON.stringify(event)` for structured events.
 * Existing consumers that filter on `kind` are unaffected; consumers that
 * read `text` as plain prose (the /journey command, `/trace export`) parse
 * it as JSON and fall back to raw text for legacy rows.
 */
import { db_ } from "./state.js";

/** A structured journey entry. */
export interface TraceEvent {
	/** Event category (matches existing journey "kind" values for backward compat). */
	kind: string;

	/** Tool name, when the event is about a tool call. */
	tool?: string;

	/** Tool action (for multi-action tools: memory/recall, kanban/new, etc.). */
	action?: string;

	/** Risk class from the permission engine, if classified. */
	risk?: string;

	/** Wall-clock execution time in milliseconds. */
	latencyMs?: number;

	/** Outcome of the operation. */
	status?: "ok" | "error" | "denied" | "timeout" | "skipped";

	/** Free-form detail string (legacy text, error messages, etc.). */
	detail?: string;

	/** Subagent id, when the event relates to a delegated child. */
	subagentId?: string;

	/** MCP server name, when the event is an MCP tool call. */
	mcpServer?: string;
}

/**
 * Write a structured trace event to the journey table.
 *
 * Best-effort — same posture as the legacy `registry_().log()`: a logging
 * failure (e.g. DB unavailable) never breaks the caller.
 */
export function logTrace(event: TraceEvent): void {
	try {
		db_()
			.prepare("INSERT INTO journey (kind, text) VALUES (?, ?)")
			.run(event.kind, JSON.stringify(event));
	} catch {
		// Journey logging is best-effort.
	}
}

/**
 * Backward-compatible wrapper: matches the old `registry_().log(kind, text)`
 * signature. Existing call sites can migrate incrementally.
 */
export function logLegacy(kind: string, text: string): void {
	logTrace({ kind, detail: text });
}
