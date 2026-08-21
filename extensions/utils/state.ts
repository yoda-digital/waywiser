/**
 * Shared Waywiser state: home directory, SQLite DB, JSON files, registry.
 *
 * Everything is in-process (extensions run inside pi), so a plain module-level
 * registry is the honest mechanism — no IPC, no globals file, no MCP.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const WAYWISER_VERSION = "0.1.0";

export function waywiserHome(): string {
	const home = process.env.WAYWISER_HOME || path.join(process.env.HOME || ".", ".waywiser");
	fs.mkdirSync(home, { recursive: true });
	return home;
}

export function homeFile(name: "SOUL.md" | "MEMORY.md" | "USER.md"): string {
	return path.join(waywiserHome(), name);
}

import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync | undefined;

/** Open (and lazily initialize) the Waywiser SQLite database. */
export function db_(): DatabaseSync {
	if (db) return db;
	const file = path.join(waywiserHome(), "waywiser.db");
	const d = new DatabaseSync(file);
	db = d;
	d.exec(`
		PRAGMA journal_mode = WAL;

		CREATE TABLE IF NOT EXISTS memories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL DEFAULT 'fact',
			content TEXT NOT NULL,
			confidence REAL NOT NULL DEFAULT 0.5,
			tags TEXT,
			source_session TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
			access_count INTEGER NOT NULL DEFAULT 0
		);

		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			type, content, content='memories', content_rowid='id'
		);

		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, type, content) VALUES (new.id, new.type, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, type, content) VALUES ('delete', old.id, old.type, old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, type ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, type, content) VALUES ('delete', old.id, old.type, old.content);
			INSERT INTO memories_fts(rowid, type, content) VALUES (new.id, new.type, new.content);
		END;

		CREATE TABLE IF NOT EXISTS cronjobs (
			id TEXT PRIMARY KEY,
			name TEXT,
			schedule TEXT NOT NULL,
			prompt TEXT NOT NULL,
			mode TEXT NOT NULL DEFAULT 'session',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			enabled INTEGER NOT NULL DEFAULT 1,
			last_run TEXT
		);

		CREATE TABLE IF NOT EXISTS goals (
			id TEXT PRIMARY KEY,
			parent_id TEXT,
			text TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS journey (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			text TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);

	// Selective-memory migration (spec §3): idempotent ALTERs + new tables.
	const memCols = d.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
	for (const [col, def] of [
		["source", "TEXT NOT NULL DEFAULT 'user'"],
		["verbatim", "TEXT"],
		["valid_at", "TEXT"],
		["supersedes_id", "INTEGER"],
	] as const) {
		if (!memCols.some((r) => r.name === col)) d.exec(`ALTER TABLE memories ADD COLUMN ${col} ${def}`);
	}
	d.exec(
		`CREATE TABLE IF NOT EXISTS memlog (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			text TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS episodes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session TEXT NOT NULL,
			summary TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);`,
	);
	return db;
}

/** Close the shared DB (tests, shutdown). */
export function closeDb(): void {
	db?.close();
	db = undefined;
}

export function logMem(kind: string, text: string): void {
	db_().prepare("INSERT INTO memlog (kind, text) VALUES (?, ?)").run(kind, text);
}

export function memlogRecent(limit = 50): Array<{ id: number; kind: string; text: string; created_at: string }> {
	return db_().prepare("SELECT id, kind, text, created_at FROM memlog ORDER BY id DESC LIMIT ?").all(limit) as Array<
		{ id: number; kind: string; text: string; created_at: string }
	>;
}

export function appendEpisode(session: string, summary: string): void {
	const d = db_();
	d.prepare("INSERT INTO episodes (session, summary) VALUES (?, ?)").run(session, summary);
	const over = d.prepare("SELECT id FROM episodes ORDER BY id DESC LIMIT 1 OFFSET 200").get() as { id: number } | undefined;
	if (over) d.prepare("DELETE FROM episodes WHERE id = ?").run(over.id);
}

export interface MemSettings {
	auto: boolean;
	recall: "selective" | "top8" | "off";
	recallMaxItems: number;
	recallMaxChars: number;
	consolidateCap: number;
	throttle: number;
	gateTimeoutMs: number;
}

const DEFAULT_MEM_SETTINGS: MemSettings = {
	auto: true,
	recall: "selective",
	recallMaxItems: 5,
	recallMaxChars: 500,
	consolidateCap: 10,
	throttle: 2,
	gateTimeoutMs: 8000,
};

export function memSettings(): MemSettings {
	const file = path.join(waywiserHome(), "mem.json");
	const raw = readJSON<Partial<MemSettings>>(file, {});
	const merged = { ...DEFAULT_MEM_SETTINGS, ...raw };
	merged.gateTimeoutMs = Math.min(Math.max(1000, merged.gateTimeoutMs), 20000);
	return merged;
}

export function setMemSettings(patch: Partial<MemSettings>): void {
	const file = path.join(waywiserHome(), "mem.json");
	writeJSON(file, { ...memSettings(), ...patch });
}

export function rememberRow(
	db: ReturnType<typeof db_>,
	p: {
		type: string;
		content: string;
		confidence: number;
		tags?: string;
		sourceSession?: string;
		source?: "user" | "agent" | "external";
		verbatim?: string | null;
		supersedesId?: number | null;
	},
): number {
	const r = db
		.prepare(
			"INSERT INTO memories (type, content, confidence, tags, source_session, source, verbatim, valid_at, supersedes_id) VALUES (?,?,?,?,?,?,?,?,?)",
		)
		.run(p.type, p.content, p.confidence, p.tags ?? "", p.sourceSession ?? "", p.source ?? "user", p.verbatim ?? null, new Date().toISOString(), p.supersedesId ?? null);
	return Number(r.lastInsertRowid);
}

export function recentMemories(
	db: ReturnType<typeof db_>,
	limit = 50,
): Array<{ id: number; type: string; content: string; source: string; supersedes: number | null }> {
	return db.prepare("SELECT id, type, content, source, supersedes_id AS supersedes FROM memories ORDER BY id DESC LIMIT ?").all(limit) as Array<
		{ id: number; type: string; content: string; source: string; supersedes: number | null }
	>;
}

/** Spec §4 read-pool predicate: confidence >= 0.5 (freezes external 0.3 + decayed rows) and not
 *  superseded by a live non-external row. Used by recall, digest-adjacent queries, consolidate. */
export const READ_POOL_PREDICATE =
	"COALESCE(m.confidence,0.5) >= 0.5 AND NOT EXISTS (SELECT 1 FROM memories s WHERE s.supersedes_id = m.id AND s.source != 'external')";

/** Read a JSON file, returning fallback when missing. Logs a warning on parse errors
 *  so malformed config files don't silently disappear. */
export function readJSON<T>(file: string, fallback: T): T {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return fallback; // ENOENT / permission — expected when file doesn't exist yet
	}
	try {
		return JSON.parse(raw) as T;
	} catch (e) {
		process.stderr.write(`waywiser: ${file} contains invalid JSON, using defaults: ${e instanceof Error ? e.message : String(e)}\n`);
		return fallback;
	}
}

/** Write a JSON file atomically (tmp + rename). */
export function writeJSON(file: string, data: unknown): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(data, null, "\t"));
	fs.renameSync(tmp, file);
}

/** Cross-extension registry (in-process only). */
export interface WaywiserRegistry {
	subagents: Map<string, unknown>;
	todos: unknown;
	cron: { onSchedule?: (dueAt: number, id: string, run: (id: string) => void) => void };
	log: (kind: string, text: string) => void;
	bumpKanban?: () => void;
}

const registry: WaywiserRegistry = {
	subagents: new Map(),
	todos: undefined,
	cron: {},
	log: (kind, text) => {
		try {
			db_().prepare("INSERT INTO journey (kind, text) VALUES (?, ?)").run(kind, text);
		} catch {
			/* DB unavailable; journey logging is best-effort */
		}
	},
};

export function registry_(): WaywiserRegistry {
	return registry;
}

/** Short id for cron jobs / subagents. */
export function shortId(prefix: string): string {
	const rand = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	return `${prefix}_${rand}`;
}

/**
 * Focused subagent system prompt built from goal + context.
 * Mirrors waywiser-* semantics: isolated context, task-scoped identity, output contract.
 */
export function buildSubagentPrompt(opts: {
	agentName?: string;
	goal: string;
	context?: string;
	output?: "text" | "summary";
	reportLine: string;
}): string {
	const name = opts.agentName ?? "subagent";
	return [
		`You are ${name}, a focused worker subagent of the Waywiser agent on the Pi harness.`,
		`You run in an ISOLATED context: you do not see the parent conversation.`,
		`Treat the goal and context below as your complete briefing.`,
		``,
		`## Goal`,
		opts.goal,
		...(opts.context ? ["", "## Context", opts.context] : []),
		``,
		`## Working rules`,
		`- Do exactly the goal; do not expand scope.`,
		`- Verify concrete claims with the tools available to you before stating them.`,
		`- Distinguish observed facts from inferences; label inferences as (inferred).`,
		`- If the task cannot be completed, say why and give the exact blocker.`,
		``,
		`## Report contract`,
		`Your final message is parsed by the orchestrator. End it with the marker line: ${opts.reportLine}`,
		opts.output === "summary"
			? `Everything after the marker is the report sent back to the orchestrator. Keep it concise: key findings, files touched, commands run, verification status, risks.`
			: `Everything after the marker is returned verbatim to the orchestrator.`,
		`If the task was NOT completed, the marker line must be ${opts.reportLine.replace("DONE", "FAILED")} instead.`,
	].join("\n");
}
