/**
 * waywiser-*memory — cross-session memory.
 *
 * SQLite (node:sqlite, FTS5) under ~/.waywiser/waywiser.db.
 * - `memory` tool: remember / recall / forget / list
 * - On before_agent_start, appends a COMPACT digest of the most-relevant recent
 *   memories to the system prompt (append position is after the soul block and
 *   stable within a session; content changes only between sessions → cache-safe).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import { db_, homeFile } from "./utils/state.js";
import { recentMemories, rememberRow, logMem, appendEpisode, memSettings, setMemSettings, READ_POOL_PREDICATE, type MemSettings } from "./utils/state.js";
import { runChild } from "./utils/llmcall.js";
import { applySupersedeDB, listConflictsDB, runConsolidate, formatConsolidateReport } from "./mem-dream.js";
import {
	buildGateWindow,
	buildGateInput,
	parseGateReply,
	validateCandidate,
	buildRecallQuery,
	renderRecallBlock,
	type RecallRow,
	type ExistingMemory,
	type GateCandidate,
	type MemSource,
	confForSource,
	extractText,
	lastUserEntry, // pure helper defined in memrules.ts (Test 6 imports it from there; hook reaches it via this namespace import)
} from "./memrules.js";

export type MemActionResult = { text: string; isErr?: boolean };

const VALID_SET: Record<string, (v: string) => boolean> = {
	auto: (v) => v === "true" || v === "false",
	recall: (v) => v === "selective" || v === "top8" || v === "off",
	gateTimeoutMs: (v) => Number.isInteger(Number(v)) && Number(v) >= 1000 && Number(v) <= 20000,
};

export async function memAction(db: ReturnType<typeof db_>, action: string, p: Record<string, unknown>): Promise<MemActionResult> {
	switch (action) {
		case "remember": {
			const content = String(p.content ?? "").trim();
			if (!content) return { text: "remember requires content", isErr: true };
			const verbatim = p.verbatim ? String(p.verbatim) : null;
			if (verbatim && (verbatim.length < 1 || verbatim.length > 200))
				return { text: "verbatim must be 1..200 chars", isErr: true };
			const type = String(p.type ?? "fact");
			if (!["fact", "preference", "decision", "lesson"].includes(type)) return { text: "bad type", isErr: true };
			const id = rememberRow(db, {
				type, content,
				confidence: typeof p.confidence === "number" ? Math.min(Math.max(p.confidence, 0), 1) : 0.9,
				tags: Array.isArray(p.tags) ? (p.tags as string[]).join(",") : undefined,
				source: "user", verbatim,
				sourceSession: String(p.session ?? "user"),
			});
			try { fs.appendFileSync(homeFile("MEMORY.md"), `- [${type}] ${content}\n`); } catch { /* best effort */ }
			logMem("remember", `id=${id}: ${content.slice(0, 100)}`);
			return { text: `Stored memory #${id}: ${content}` };
		}
		case "recall":
			return brainRecallText(db, String(p.query ?? ""), Math.min(Number(p.limit) || 5, 20));
		case "forget": {
			const id = Number(p.id);
			const r = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
			if ((r.changes as number) === 0) return { text: `no memory with id ${id}`, isErr: true };
			logMem("forget", `id=${id}`);
			return { text: `Forgot memory #${id}` };
		}
		case "list": {
			const limit = Math.min(Number(p.limit) || 20, 50);
			const rows = db
				.prepare("SELECT id, type, content, confidence, source, supersedes_id, last_accessed FROM memories ORDER BY id DESC LIMIT ?")
				.all(limit) as Array<Record<string, unknown>>;
			if (!rows.length) return { text: "Memory is empty." };
			return {
				text: rows
					.map((r) =>
						`#${String(r.id)} [${String(r.type)}] conf=${String(r.confidence)} src=${String(r.source)}` +
						(`${r.supersedes_id ? ` supersedes=#${r.supersedes_id}` : ""} ${String(r.content)}`),
					)
					.join("\n"),
			};
		}
		case "promote": {
			const id = Number(p.id);
			const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
			if (!row) return { text: `no memory with id ${id}`, isErr: true };
			if (row.source !== "external" || Number(row.confidence) >= 0.5) return { text: `memory #${id} is not an external-frozen row`, isErr: true };
			db.prepare("UPDATE memories SET source = 'user', confidence = 0.9 WHERE id = ?").run(id);
			logMem("promote", `id=${id}: ${String(row.content).slice(0, 100)}`);
			return { text: `Promoted #${id} to user memory` };
		}
		case "supersede": {
			const r = applySupersedeDB(db, Number(p.keep), Number(p.drop));
			return r.ok ? { text: r.msg } : { text: r.msg, isErr: true };
		}
		case "conflicts": {
			const rows = listConflictsDB(db);
			if (!rows.length) return { text: "no pending conflicts" };
			return {
				text: rows
					.map((r) =>
						`#${r.id} a=#${r.a} b=#${r.b} keep=#${r.keepId ?? "-"} reason=${r.reason} (${r.created_at})${r.resolved ? " [resolved]" : ""}`,
					)
					.join("\n"),
			};
		}
		case "stats": {
			const t = db.prepare("SELECT type, COUNT(*) AS c FROM memories GROUP BY type").all() as Array<{ type: string; c: number }>;
			const s = db.prepare("SELECT source, COUNT(*) AS c FROM memories GROUP BY source").all() as Array<{ source: string; c: number }>;
			const total = (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
			const readable = db.prepare(`SELECT COUNT(*) AS c FROM memories m WHERE ${READ_POOL_PREDICATE}`).get() as { c: number };
			const writes = (db.prepare("SELECT COUNT(*) AS c FROM memlog WHERE kind IN ('remember','gate')").get() as { c: number }).c;
			const injects = (db.prepare("SELECT COUNT(*) AS c FROM memlog WHERE kind = 'inject'").get() as { c: number }).c;
			const md = fs.existsSync(homeFile("USER.md")) ? fs.readFileSync(homeFile("USER.md"), "utf-8").trim().split("\n").length : 0;
			return {
				text:
					`memories: ${total}\n` +
					`by type: ${t.map((r) => `${r.type}=${r.c}`).join(" ") || "(none)"}\n` +
					`by source: ${s.map((r) => `${r.source}=${r.c}`).join(" ") || "(none)"}\n` +
					`readable (conf>=0.5): ${readable.c}\n` +
					`memlog: writes=${writes} injects=${injects}\n` +
					`user md: ${md} lines`,
			};
		}
		case "set": {
			const kv = String(p.kv ?? "");
			const [k, ...rest] = kv.split("=");
			const v = rest.join("=");
			if (!VALID_SET[k] || !VALID_SET[k](v))
				return { text: `invalid set: "${kv}" (valid: auto=true|false, recall=selective|top8|off, gateTimeoutMs=1000..20000)`, isErr: true };
			setMemSettings({ [k]: k === "gateTimeoutMs" ? Number(v) : (v as never) } as Partial<MemSettings>); // eslint-disable-line @typescript-eslint/no-explicit-any
			logMem("set", kv);
			return { text: `memory set ${kv}` };
		}
		default:
			return { text: `unknown memory action: ${action}`, isErr: true };
	}
}

export function parseMemCommandLine(args: string):
	| { action: string; p: Record<string, unknown> }
	| { query: string }
	| { consolidate: boolean; apply: boolean } {
	const a = args.trim();
	if (!a) return { query: "" };
	if (/^consolidate( apply)?$/i.test(a)) return { consolidate: true, apply: /apply/i.test(a) };
	if (a === "conflicts") return { action: "conflicts", p: {} };
	if (a === "stats") return { action: "stats", p: {} };
	let m = a.match(/^supersede (\d+) (\d+)$/);
	if (m) return { action: "supersede", p: { keep: Number(m[1]), drop: Number(m[2]) } };
	m = a.match(/^promote (\d+)$/);
	if (m) return { action: "promote", p: { id: Number(m[1]) } };
	m = a.match(/^set (\S+)$/);
	if (m) return { action: "set", p: { kv: m[1] } };
	m = a.match(/^forget (\d+)$/);
	if (m) return { action: "forget", p: { id: Number(m[1]) } };
	m = a.match(/^remember (.+)$/);
	if (m) return { action: "remember", p: { content: m[1] } };
	m = a.match(/^recall (.+)$/);
	if (m) return { action: "recall", p: { query: m[1] } };
	return { query: a };
}

export default function memory(pi: ExtensionAPI): void {
	registerMemory(pi);
}

export function registerMemory(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Persistent cross-session memory. Remember facts/preferences/decisions/lessons, recall with full-text search, forget by id, promote frozen rows, mark supersede, list conflicts, stats, tune settings, consolidate (bounded cleanup pass, dry-run by default).",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("remember"), Type.Literal("recall"), Type.Literal("forget"), Type.Literal("list"),
					Type.Literal("promote"), Type.Literal("supersede"), Type.Literal("conflicts"), Type.Literal("stats"), Type.Literal("set"),
					Type.Literal("consolidate"),
				],
				{ description: "remember | recall | forget | list | promote | supersede | conflicts | stats | set | consolidate" },
			),
			content: Type.Optional(Type.String({ description: "For remember: what to store" })),
			type: Type.Optional(
				Type.Union([Type.Literal("fact"), Type.Literal("preference"), Type.Literal("decision"), Type.Literal("lesson")]),
				{ description: "For remember: memory type (default fact)" },
			),
			confidence: Type.Optional(Type.Number({ description: "For remember: 0..1" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "For remember: tags" })),
			query: Type.Optional(Type.String({ description: "For recall: search query" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
			id: Type.Optional(Type.Number({ description: "For forget/promote: memory id" })),
			verbatim: Type.Optional(Type.String({ description: "For remember: verbatim anchor, 1..200 chars" })),
			keep: Type.Optional(Type.Number({ description: "For supersede: id of the memory to keep" })),
			drop: Type.Optional(Type.Number({ description: "For supersede: id of the memory to supersede" })),
			kv: Type.Optional(Type.String({ description: "For set: key=value (auto=true|false, recall=selective|top8|off, gateTimeoutMs=1000..20000)" })),
			dry_run: Type.Optional(Type.Boolean({ description: "For consolidate: dry-run by default; pass false to apply" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, _signal, _update, _ctx: ExtensionContext) {
			// consolidate is the only long-async action; it stays OUT of memAction (spec §2).
			if (p.action === "consolidate") {
				const rep = await runConsolidate(db_(), { dryRun: p.dry_run ?? true, cap: memSettings().consolidateCap });
				return ok(formatConsolidateReport(rep));
			}
			return memAction(db_(), p.action, p as Record<string, unknown>).then(
				(r) => (r.isErr ? err(r.text) : ok(r.text)),
			);
		},
	});

	// Digest injection: top recent/high-frequency memories, bounded, stable per session.
	let digest = "";
	pi.on("session_start", () => {
		let digestText = "";
		try {
			const rows = db_()
				.prepare(
					"SELECT id, type, content FROM memories WHERE confidence >= 0.5 ORDER BY access_count DESC, id DESC LIMIT 8",
				)
				.all() as Array<{ id: number; type: string; content: string }>;
			if (rows.length) {
				digestText =
					"\n<!-- WAYWISER MEMORY DIGEST (session-stable) -->\nRelevant stored memories:\n" +
					rows.map((r) => `- [${r.type}] ${r.content}`).join("\n") +
					"\n<!-- WAYWISER MEMORY DIGEST END -->";
			}
		} catch {
			digestText = "";
		}
		digest = digestText; // digest build behavior unchanged (digest = full-text string, "" on no rows or error)
		recallState = initialRecallState; // block dies with the session; digest stays the one source of the session-stable block
	});

	pi.on("before_agent_start", (event) => {
		const s = memSettings();
		if (s.recall !== "selective") {
			return digest ? { systemPrompt: event.systemPrompt + digest } : undefined;   // "off" and "top8" = today's behavior, byte-identical
		}
		const terms = buildRecallQuery(event.prompt);
		const key = terms.join(" ");
		if (recallDecision(recallState, key, s.throttle)) {
			let block = "";
			if (key) {
				try {
					block = selectRecallBlock(db_(), terms, s.recallMaxItems, s.recallMaxChars);
				} catch (e) {
					process.stderr.write(`waywiser/memory: recall query failed (terms=${key.slice(0, 60)}): ${e instanceof Error ? e.message : String(e)}\n`);
				}
				if (block) logMem("inject", key.slice(0, 80));   // one row per NEW selection, not per turn
			}
			recallState = { ...recallState, block, lastKey: key, lastSelectionTurn: recallState.userTurns };
		}
		const append = digest + recallState.block;
		return append ? { systemPrompt: event.systemPrompt + append } : undefined;
	});

	let gateAccum: string[] = [];
	let recallState = initialRecallState;
	pi.on("turn_end", async (event, ctx) => {
		try {
			const s = memSettings();
			// recall counts USER turns even when the gate is off/muted (Task 7)
			const userEntry = lastUserEntry(ctx);
			if (userEntry) recallState = { ...recallState, userTurns: recallState.userTurns + 1 };  // single increment per user turn (Task-6 line, kept verbatim);
			if (!s.auto || !userEntry) return;
			const session = String((ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.() ?? "gate");
			const assistantText = extractText((event as { message?: { content?: unknown } }).message?.content);
			const existing = recentMemories(db_(), 50);
			const r = await runGate({ userText: userEntry.text, assistantText, db: db_(), existing, session });
			if (r.error) return; // silent skip: nothing useful happened (spec §4)
			if (r.accepted) {
				const added = recentMemories(db_(), r.accepted).slice(0, r.accepted).map((m) => m.content);
				gateAccum = [...gateAccum, ...added];
				if (gateAccum.length >= 5) { gateEpisode(db_(), gateAccum.slice(0, 5)); gateAccum = gateAccum.slice(5); }
			}
		} catch {
			/* gate must never break the session — same posture as the digest */
		}
	});
}

/** Escape a user query for FTS5 MATCH. Terms are OR-joined so a natural multi-word
 *  query matches any row containing *any* word; relevance comes from ORDER BY bm25
 *  (the recall SQL already computes it). AND-joining every word meant a 3-word query
 *  returned 0 rows unless one memory literally contained all three. */
export function ftsEscape(q: string): string {
	return q
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => `"${w.replace(/"/g, '""')}"`)
		.join(" OR ");
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

export async function runGate(env: {
	userText: string;
	assistantText: string;
	db: ReturnType<typeof db_>;
	existing: ExistingMemory[];
	llm?: (prompt: string) => Promise<string>;
	session?: string;
}): Promise<{ accepted: number; rejected: number; error?: string }> {
	const llm = env.llm ?? ((p: string) => runChild({ prompt: p, totalMs: memSettings().gateTimeoutMs }));
	const win = buildGateWindow(env.userText, env.assistantText);
	if (!win.user) return { accepted: 0, rejected: 0, error: undefined };
	let reply: string;
	try {
		reply = await llm(buildGateInput(win, env.existing));
	} catch (e) {
		return { accepted: 0, rejected: 0, error: String(e && (e as { message?: unknown }).message ? (e as { message?: unknown }).message : e).split("\n")[0] };
	}
	let accepted = 0;
	let rejected = 0;
	for (const c of parseGateReply(reply) as GateCandidate[]) {
		const v = validateCandidate(c, win.joined, env.existing);
		if (!v.ok) {
			rejected++;
			logMem("gate", `reject ${v.reason}`);
			continue;
		}
		const source: MemSource = c.source === "external" || c.external === true ? "external" : "agent";
		rememberRow(env.db, {
			type: c.type,
			content: c.content,
			confidence: confForSource[source],
			source,
			verbatim: c.verbatim,
			supersedesId: c.supersedes ?? null,
			sourceSession: env.session ?? "gate",
		});
		logMem("gate", `accept: ${c.content.slice(0, 80)}`);
		accepted++;
	}
	return { accepted, rejected, error: undefined };
}

export function gateEpisode(db: ReturnType<typeof db_>, acceptedContents: string[]): void {
	appendEpisode("gate", acceptedContents.join(" | ").slice(0, 500));
}

export function selectRecallBlock(db: ReturnType<typeof db_>, terms: string[], maxItems?: number, maxChars?: number): string {
	const s = memSettings();
	const rows = db
		.prepare(
			`SELECT m.id, m.type, m.source, m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
				 WHERE memories_fts MATCH ? AND ${READ_POOL_PREDICATE}
				 ORDER BY bm25(memories_fts) LIMIT ?`,
		)
		.all(ftsEscape(terms.join(" ")), maxItems ?? s.recallMaxItems) as Array<RecallRow>;
	return renderRecallBlock(terms, rows, maxChars ?? s.recallMaxChars, 180);
}

export interface RecallState {
	lastKey: string;
	block: string;
	lastSelectionTurn: number;
	userTurns: number;
}
export const initialRecallState: RecallState = { lastKey: "", block: "", lastSelectionTurn: -1, userTurns: 0 };

export function recallDecision(state: RecallState, key: string, throttle: number): boolean {
	// any key change (new key, cleared key, or first selection) re-selects;
	// otherwise re-select only once per `throttle` user turns (cache stability).
	if (key !== state.lastKey) return true;
	return state.userTurns - state.lastSelectionTurn >= throttle;
}

/**
 * Brain-enhanced recall: uses Brain's reciprocal rank fusion when available,
 * falls back to basic FTS match if Brain isn't loaded.
 * Brain's recall does per-term search (not exact phrase), so "decisions"
 * finds "decision", and unicode terms work properly.
 */
async function brainRecallText(db: ReturnType<typeof db_>, query: string, limit = 5): Promise<{ text: string }> {
	const q = query.trim();
	if (!q) return runRecallText(db, q, limit);

	try {
		// Dynamic import — Brain may or may not be installed
		const { BrainStore } = await import("../plugins/brain/extensions/brain/store.ts");
		const { loadBrainConfig } = await import("../plugins/brain/extensions/brain/config.ts");
		const { recall } = await import("../plugins/brain/extensions/brain/recall.ts");

		const config = loadBrainConfig();
		// Open Brain's store on the same DB that Waywiser uses
		const store = new BrainStore(config.dbPath);

		const result = recall({
			prompt: q,
			cwd: process.cwd(),
			projectKey: null,
			config: config.recall,
			scopingConfig: config.scoping,
			store,
		});

		store.close();

		if (!result.items.length) return { text: "No memories matched." };
		return {
			text: result.items
				.map((item) => {
					if (item.type === "memory") {
						return `#${item.id} [memory] ${item.content} (score: ${item.score.toFixed(3)})`;
					}
					return `[procedure] ${item.content} (score: ${item.score.toFixed(3)})`;
				})
				.join("\n"),
		};
	} catch {
		// Brain not available — fall back to old recall
		return runRecallText(db, q, limit);
	}
}

export async function runRecallText(db: ReturnType<typeof db_>, query: string, limit = 5): Promise<{ text: string }> {
	const lim = Math.min(limit, 20);
	const q = query.trim();
	if (q) {
		const rows = db
			.prepare(
				`SELECT m.id, m.type, m.source, m.content, bm25(memories_fts) AS rank
					 FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
					 WHERE memories_fts MATCH ? AND ${READ_POOL_PREDICATE}
					 ORDER BY rank LIMIT ?`,
			)
			.all(ftsEscape(q), lim) as Array<{ id: number; type: string; source: string; content: string }>;
		const bump = db.prepare("UPDATE memories SET last_accessed = datetime('now'), access_count = access_count + 1 WHERE id = ?");
		for (const r of rows) bump.run(r.id);
		return { text: rows.length ? rows.map((r) => `#${r.id} [${r.type}|${r.source}] ${r.content}`).join("\n") : "No memories matched." };
	}
	const idle = db
		.prepare(
			`SELECT m.id, m.type, m.source, m.content FROM memories m
			 WHERE ${READ_POOL_PREDICATE} ORDER BY m.access_count DESC, m.id DESC LIMIT ?`,
		)
		.all(lim) as Array<{ id: number; type: string; source: string; content: string }>;
	return { text: idle.length ? idle.map((r) => `#${r.id} [${r.type}|${r.source}] ${r.content}`).join("\n") : "Memory is empty." };
}
