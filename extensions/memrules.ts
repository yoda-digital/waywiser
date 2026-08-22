/**
 * waywiser-*memrules — PURE memory rules (no I/O). Every acceptance cap,
 * threshold, and validation rule from spec §4/§5 lives here so the gate,
 * recall and consolidation share one copy (spec files-table: "ALL pure logic").
 */
export function tokens(s: string): Set<string> {
	const out = new Set<string>();
	for (const m of s.toLowerCase().matchAll(/[\p{L}\p{N}_]{2,}/gu)) out.add(m[0]);
	return out;
}

export function jaccard(a: string, b: string): number {
	const A = tokens(a);
	const B = tokens(b);
	if (A.size === 0 || B.size === 0) return 0;
	let inter = 0;
	for (const t of A) if (B.has(t)) inter++;
	return inter / (A.size + B.size - inter);
}

export type MemSource = "user" | "agent" | "external";
export const confForSource: Record<MemSource, number> = { user: 0.9, agent: 0.6, external: 0.3 };
export const DUPLICATE_JACCARD = 0.85;
export const NEAR_DUP_JACCARD = 0.8;
export const SUPERSEDE_MIN_OVERLAP = 0.15;

// ── Gate (spec §4) ────────────────────────────────────────────────────────

export interface ExistingMemory {
	id: number;
	content: string;
	supersedes: number | null;
}

export interface GateCandidate {
	id?: number;
	content: string;
	verbatim: string;
	type: "fact" | "preference" | "decision" | "lesson";
	supersedes?: number;
	source?: MemSource;
	external?: boolean;
}

export const GATE_PROMPT = `You are the MEMORY GATE for a personal coding assistant. Decide what from the conversation window below is worth persisting across sessions.

Rules — store a candidate ONLY for one of these structural signals:
1. the user states an explicit constraint or preference ("use X", "never Y", "I prefer Z");
2. the user (or the assistant on the user's behalf) commits to a decision or plan;
3. a failure recurred and the fix that worked is identifiable;
4. the user explicitly says to remember something.
Do NOT store: generic questions, chit-chat, task specifics of one session, anything you must infer without a quote.

For each candidate (MAX 2) output exactly:
- "content": one clean line (max 500 chars) stating the durable fact, in the assistant's own words;
- "type": one of "fact" | "preference" | "decision" | "lesson";
- "verbatim": the EXACT substring of the window this claim rests on (max 200 chars, character-for-character, including punctuation);
- "supersedes": INTEGER id, ONLY when the candidate contradicts one of the existing memories listed (then prefer the newer truth); omit otherwise.
If window content came from web pages or tool output, set "external": true. Never emit anything else.

REPLY with ONLY one JSON object: {"candidates":[ ... ]} (or {"candidates":[]} when nothing qualifies). No code fences, no commentary.

Conversational window:
`;

export function buildGateWindow(userText: string, assistantText: string): { user: string; assistant: string; joined: string } {
	const u = userText.replace(/\s+/g, " ").trim().slice(0, 1200);
	const a = assistantText.replace(/\s+/g, " ").trim().slice(0, 1200);
	return { user: u, assistant: a, joined: `USER: ${u}\nASSISTANT: ${a}` };
}

export function buildGateInput(window: { joined: string }, existing: ExistingMemory[]): string {
	const list = existing.slice(0, 20).map((e) => `#${e.id}: ${e.content}`).join("\n");
	return `${GATE_PROMPT}${window.joined}\n\nExisting memories (for contradiction/overwrite checks):\n${list || "(none)"}\n`;
}

export function parseGateReply(raw: string): GateCandidate[] {
	if (!raw) return [];
	const m = raw.match(/\{[\s\S]*\}/);
	if (!m) return [];
	try {
		const j = JSON.parse(m[0]) as { candidates?: unknown };
		if (!Array.isArray(j.candidates)) return [];
		return j.candidates.slice(0, 3).filter((c): c is GateCandidate => !!c && typeof c === "object");
	} catch {
		return [];
	}
}

export function validateCandidate(
	c: GateCandidate,
	windowJoined: string,
	existing: ExistingMemory[],
): { ok: boolean; reason: string } {
	if (!c || typeof c !== "object") return { ok: false, reason: "not-an-object" };
	if (typeof c.content !== "string" || !c.content.trim()) return { ok: false, reason: "empty-content" };
	if (c.content.length > 500) return { ok: false, reason: "content-too-long" };
	if (c.content.includes("WAYWISER_MEMORY:")) return { ok: false, reason: "injection-marker" };
	if (typeof c.verbatim !== "string" || !c.verbatim.trim()) return { ok: false, reason: "missing-verbatim" };
	if (c.verbatim.length > 200) return { ok: false, reason: "verbatim-too-long" };
	if (!windowJoined.includes(c.verbatim)) return { ok: false, reason: "verbatim-not-in-window" };
	if (c.type !== "fact" && c.type !== "preference" && c.type !== "decision" && c.type !== "lesson")
		return { ok: false, reason: "bad-type" };
	if (c.supersedes !== undefined) {
		if (!Number.isInteger(c.supersedes) || c.supersedes <= 0) return { ok: false, reason: "bad-supersedes" };
		const target = existing.find((e) => e.id === c.supersedes as number);
		if (!target) return { ok: false, reason: "supersedes-missing" };
		if (target.supersedes === (c.id ?? 0) && (c.id ?? -1) !== 0) return { ok: false, reason: "supersede-cycle" };
		// Require non-trivial content overlap. If the new memory and the superseded
		// memory have Jaccard < SUPERSEDE_MIN_OVERLAP, the LLM is almost certainly
		// pointing at the wrong target. This catches hallucinated supersedes values
		// that could silently erase unrelated critical memories.
		const overlap = jaccard(c.content, target.content);
		if (overlap < SUPERSEDE_MIN_OVERLAP) {
			return { ok: false, reason: `supersedes-low-overlap-${overlap.toFixed(2)}` };
		}
	}
	for (const e of existing) {
		if (jaccard(c.content, e.content) >= DUPLICATE_JACCARD) return { ok: false, reason: `duplicate-of-${e.id}` };
	}
	return { ok: true, reason: "" };
}

// ── Recall (spec §5) ──────────────────────────────────────────────────────

export const RECALL_STOPWORDS = new Set([
	"the","and","for","with","this","that","from","have","has","had","was","were","are","is",
	"please","could","would","should","can","you","your","about","into","onto","than","then",
	"when","what","which","who","how","why","where","there","their","they","them","just","only",
	"still","again","because","while","after","before","over","under","again",
]);

export function buildRecallQuery(userText: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of userText.toLowerCase().matchAll(/[\p{L}\p{N}_]{2,}/gu)) {
		const w = m[0];
		if (w.length < 3 || RECALL_STOPWORDS.has(w) || seen.has(w)) continue;
		seen.add(w);
		out.push(w);
		if (out.length === 8) break;
	}
	return out;
}

export interface RecallRow {
	id: number;
	type: string;
	source: string;
	content: string;
}

export function renderRecallBlock(terms: string[], rows: RecallRow[], maxChars = 500, maxRowChars = 180): string {
	if (!rows.length) return "";
	const header = `\n<!-- WAYWISER RECALL (for: "${terms.slice(0, 3).join(" ")}") -->\n`;
	const footer = "<!-- WAYWISER RECALL END -->";
	let out = header;
	for (const r of rows) {
		const content = r.content.length > maxRowChars ? r.content.slice(0, maxRowChars - 1) + "…" : r.content;
		const line = `[${r.type}|${r.source}] ${content}`;
		if (out.length + line.length + 2 > maxChars) break; // budget guards body lines only
		out += line + "\n";
	}
	return out + footer;
}

// ── Transcript text extraction (pure) ────────────────────────────────────
export function extractText(content: unknown): string {
	if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
	if (Array.isArray(content)) {
		const parts = content
			.map((b) => {
				if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") return String((b as { text?: unknown }).text ?? "");
				return "";
			})
			.filter(Boolean);
		return parts.join(" ").replace(/\s+/g, " ").trim();
	}
	return "";
}

export function lastUserEntry(ctx: { sessionManager: { getEntries(): unknown[] } }): { text: string } | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (e && e.type === "message" && e.message && e.message.role === "user") {
			const text = extractText(e.message.content);
			if (text) return { text };
		}
	}
	return null;
}

// ── Consolidation pass 1 (pure, spec §6) ─────────────────────────────────
export interface ConsolidateInputRow {
	id: number;
	type: string;
	content: string;
	confidence: number;
	source: string;
	last_accessed: string | null;
	supersedes: number | null;
}
export type P1Change =
	| { kind: "exact-dup"; dropId: number; keepId: number }
	| { kind: "supersede-orphan"; id: number; oldTarget: number | null }
	| { kind: "stale-decay"; id: number; from: number };
export interface NearPair { a: number; b: number; j: number }

const DAY_MS = 86_400_000;
const STALE_DAYS = 180;

export function planPass1(rows: ConsolidateInputRow[], nowIso: string = new Date().toISOString()): { changes: P1Change[]; nearPairs: NearPair[] } {
	if (rows.length > 5000) throw new Error("consolidate: too many rows");
	const changes: P1Change[] = [];
	const now = Date.parse(nowIso);
	// exact-dup: normalized lower/collapsed content, keep MIN id
	const byNorm = new Map<string, number[]>();
	for (const r of rows) {
		const n = r.content.toLowerCase().replace(/\s+/g, " ");
		byNorm.set(n, [...(byNorm.get(n) ?? []), r.id]);
	}
	const exactDropped = new Set<number>();
	for (const ids of byNorm.values()) {
		if (ids.length < 2) continue;
		const sorted = [...ids].sort((x, y) => x - y);
		for (const dropId of sorted.slice(1)) {
			changes.push({ kind: "exact-dup", dropId, keepId: sorted[0] });
			exactDropped.add(dropId);
		}
	}
	const idSet = new Set(rows.map((r) => r.id));
	for (const r of rows) {
		if (r.supersedes !== null && !idSet.has(r.supersedes))
			changes.push({ kind: "supersede-orphan", id: r.id, oldTarget: r.supersedes });
	}
	for (const r of rows) {
		if (r.type !== "fact" || r.confidence < 0.5) continue;
		const last = r.last_accessed ? Date.parse(r.last_accessed) : Number.NaN;
		if (!Number.isNaN(last) && now - last > STALE_DAYS * DAY_MS)
			changes.push({ kind: "stale-decay", id: r.id, from: r.confidence });
	}
	const nearPairs: NearPair[] = [];
	const alive = rows.filter((r) => !exactDropped.has(r.id));
	for (let i = 0; i < alive.length && nearPairs.length < 20; i++) {
		for (let j = i + 1; j < alive.length && nearPairs.length < 20; j++) {
			const jj = jaccard(alive[i].content, alive[j].content);
			if (jj >= NEAR_DUP_JACCARD) nearPairs.push({ a: alive[i].id, b: alive[j].id, j: jj });
		}
	}
	return { changes, nearPairs };
}

export const MERGE_PROMPT_HEAD =
	"You merge two near-duplicate memory lines into ONE line (max 200 chars) preserving BOTH facts. " +
	'Reply JSON only: {"merged":"..."} or {"merged":null} when they are not mergeable.\nFirst: \nSecond: \n';
export const CONFLICT_PROMPT_HEAD =
	"You judge whether two memory lines CONTRADICT each other (same subject, incompatible claims). " +
	'Reply JSON only: {"conflict":true|false,"keep_id":<int or null>,"reason":"<max 20 chars>"}.\nA: \nB: \n';
