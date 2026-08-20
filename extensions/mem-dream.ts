/**
 * waywiser-*mem-dream — consolidation (spec §6): deterministic pass 1 + LLM-capped
 * pass 2, dry-run default, conflicts propose-only, USER.md regeneration.
 * The llm function is injectable (tests stub it; default is llmcall.runChild).
 */
import type { DatabaseSync } from "node:sqlite";
import { planPass1, MERGE_PROMPT_HEAD, CONFLICT_PROMPT_HEAD, jaccard, NEAR_DUP_JACCARD, tokens, type ConsolidateInputRow, type P1Change } from "./memrules.js";
import { rememberRow, logMem, appendEpisode, homeFile, READ_POOL_PREDICATE } from "./utils/state.js";
import { runChild } from "./utils/llmcall.js";
import * as fs from "node:fs";

export interface ConsolidateReport {
	dryRun: boolean;
	applied: number;
	p1: P1Change[];
	nearMerges: Array<{ a: number; b: number; merged: string | null; applied: boolean }>;
	conflictsProposed: Array<{ a: number; b: number; keepId: number | null; reason: string }>;
	userMdLines: number;
	skipped?: string;
}

export async function runConsolidate(
	db: DatabaseSync,
	opts: { dryRun?: boolean; cap?: number; llm?: (prompt: string) => Promise<string>; nowIso?: string },
): Promise<ConsolidateReport> {
	const dryRun = opts.dryRun ?? true;
	const cap = opts.cap ?? 10;
	const llm = opts.llm ?? ((p: string) => runChild({ prompt: p, totalMs: 60_000 }));
	const nowIso = opts.nowIso ?? new Date().toISOString();
	const rows = db
		.prepare("SELECT id, type, content, confidence, source, last_accessed, supersedes_id AS supersedes FROM memories ORDER BY id LIMIT 5000")
		.all() as unknown as ConsolidateInputRow[];
	if (rows.length >= 5000)
		return { dryRun, applied: 0, p1: [], nearMerges: [], conflictsProposed: [], userMdLines: 0, skipped: "consolidate: too many rows (delete old rows first)" };
	const { changes, nearPairs } = planPass1(rows, nowIso);

	const report: ConsolidateReport = {
		dryRun, applied: 0, p1: changes, nearMerges: [], conflictsProposed: [], userMdLines: 0,
	};

	// ── pass 2 work lists (computed either way so dry-run reports honestly) ──
	let mergePairs = nearPairs.slice(0, cap);
	const byId = new Map(rows.map((r) => [r.id, r]));
	const dupDropped = new Set(changes.filter((c) => c.kind === "exact-dup").map((c) => (c as { dropId: number }).dropId));
	const conflictPairs: Array<{ a: number; b: number }> = [];
	for (const p of mergePairs) dupDropped.add(p.a), dupDropped.add(p.b);
	outer: for (let i = 0; i < rows.length && conflictPairs.length < cap; i++) {
		for (let j = i + 1; j < rows.length && conflictPairs.length < cap; j++) {
			const A = rows[i], B = rows[j];
			if (dupDropped.has(A.id) || dupDropped.has(B.id)) continue;
			let shared = 0;
			for (const t of tokens(A.content)) if (tokens(B.content).has(t)) shared++;
			if (shared >= 3 && jaccard(A.content, B.content) < NEAR_DUP_JACCARD) conflictPairs.push({ a: A.id, b: B.id });
		}
	}

	if (!dryRun) {
		for (const c of changes) {
			if (c.kind === "exact-dup") {
				db.prepare("UPDATE memories SET supersedes_id = ?, valid_at = ? WHERE id = ?").run(c.keepId, nowIso, c.dropId);
				logMem("dedup", `drop=#${c.dropId} keep=#${c.keepId}`);
				report.applied++;
			} else if (c.kind === "supersede-orphan") {
				db.prepare("UPDATE memories SET supersedes_id = NULL WHERE id = ?").run(c.id);
				logMem("orphan", `#${c.id} (was -> #${c.oldTarget ?? "-"})`);
				report.applied++;
			} else {
				db.prepare("UPDATE memories SET confidence = 0.3, valid_at = ? WHERE id = ?").run(nowIso, c.id);
				logMem("decay", `#${c.id} (${c.from.toFixed(2)} -> 0.30)`);
				report.applied++;
			}
		}
	}

	// ── pass 2 merges (LLM, sequential, error-tolerant) ──
	for (const p of mergePairs) {
		const A = byId.get(p.a) as ConsolidateInputRow, B = byId.get(p.b) as ConsolidateInputRow;
		let merged: string | null = null;
		try {
			const reply = await llm(`${MERGE_PROMPT_HEAD}${A.content}\n${B.content}`);
			const m = reply.match(/\{[\s\S]*\}/);
			const jj = m ? (JSON.parse(m[0]) as { merged: unknown }) : { merged: null };
			if (typeof jj.merged === "string" && jj.merged.length >= 3 && jj.merged.length <= 200) merged = jj.merged;
		} catch { /* pair skipped */ }
		const entry = { a: p.a, b: p.b, merged, applied: false };
		if (!dryRun && merged) {
			const low = byId.get(Math.min(p.a, p.b)) as ConsolidateInputRow;
			const high = byId.get(Math.max(p.a, p.b)) as ConsolidateInputRow;
			const newId = rememberRow(db, {
				type: low.type, content: merged,
				confidence: Math.max(low.confidence, high.confidence),
				source: low.source === "external" ? "agent" : low.source,
				supersedesId: Math.min(p.a, p.b),
			});
			db.prepare("DELETE FROM memories WHERE id IN (?, ?)").run(p.a, p.b);
			logMem("merge", `a=#${p.a} b=#${p.b} -> #${newId}: ${merged.slice(0, 100)}`);
			entry.applied = true;
			report.applied++;
		}
		report.nearMerges.push(entry);
	}

	// ── pass 2 conflicts (LLM, propose-only) ──
	for (const p of conflictPairs) {
		const A = byId.get(p.a) as ConsolidateInputRow, B = byId.get(p.b) as ConsolidateInputRow;
		let conflict = false, keepId: number | null = null, reason = "";
		try {
			const reply = await llm(`${CONFLICT_PROMPT_HEAD}A #${A.id}: ${A.content}
B #${B.id}: ${B.content}`);
			const m = reply.match(/\{[\s\S]*\}/);
			const jj = m ? (JSON.parse(m[0]) as { conflict?: unknown; keep_id?: unknown; reason?: unknown }) : {};
			conflict = jj.conflict === true;
			keepId = Number.isInteger(jj.keep_id) && (jj.keep_id === p.a || jj.keep_id === p.b) ? (jj.keep_id as number) : null;
			reason = String(jj.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
		} catch { /* pair skipped */ }
		if (conflict) {
			report.conflictsProposed.push({ a: p.a, b: p.b, keepId, reason });
			if (!dryRun) logMem("propose", `conflict a=#${p.a} b=#${p.b} keep=${keepId ?? "null"} reason=${reason}`);
		}
	}

	if (!dryRun) {
		report.userMdLines = rebuildUserMd(db);
		appendEpisode("consolidate", `${report.applied} applied, ${report.conflictsProposed.length} proposed`);
	}
	return report;
}

export function rebuildUserMd(db: DatabaseSync): number {
	const rows = db
		.prepare(`SELECT m.id, m.source, m.content FROM memories m WHERE m.type = 'preference' AND ${READ_POOL_PREDICATE} ORDER BY m.id`)
		.all() as Array<{ id: number; source: string; content: string }>;
	const body = rows.length
		? rows.map((r) => `- [preference|${r.source}] ${r.content}`).join("\n")
		: "- (no confirmed preferences yet)";
	fs.writeFileSync(homeFile("USER.md"), `<!-- USER.md — generated by waywiser /memory consolidate. Edit in memory, not here. -->\n${body}\n`);
	return rows.length;
}

const PROPOSE_RE = /^conflict a=#(\d+) b=#(\d+) keep=(\d+|null) reason=(.*)$/;

export function listConflictsDB(db: DatabaseSync): Array<{ id: number; a: number; b: number; keepId: number | null; reason: string; created_at: string; resolved: boolean }> {
	const rows = db.prepare("SELECT id, text, created_at FROM memlog WHERE kind = 'propose' ORDER BY id").all() as Array<{ id: number; text: string; created_at: string }>;
	const supersedeLogs = db.prepare("SELECT id, text, created_at FROM memlog WHERE kind = 'supersede'").all() as Array<{ id: number; text: string; created_at: string }>;
	return rows.map((r) => {
		const m = r.text.match(PROPOSE_RE);
		if (!m) return null;
		const a = Number(m[1]), b = Number(m[2]);
		const resolved = supersedeLogs.some((s) => s.id > r.id && s.text.includes(`#${a}`) && (s.text.includes(`drop=#${a}`) || s.text.includes(`drop=#${b}`)));
		return { id: r.id, a, b, keepId: m[3] === "null" ? null : Number(m[3]), reason: m[4], created_at: r.created_at, resolved };
	}).filter((x): x is NonNullable<typeof x> => x !== null);
}

export function applySupersedeDB(db: DatabaseSync, keepId: number, dropId: number): { ok: boolean; msg: string } {
	if (!Number.isInteger(keepId) || !Number.isInteger(dropId) || keepId === dropId)
		return { ok: false, msg: "supersede needs two distinct integer ids (keep, drop)" };
	const k = db.prepare("SELECT id FROM memories WHERE id = ?").get(keepId);
	const dr = db.prepare("SELECT id FROM memories WHERE id = ?").get(dropId);
	if (!k || !dr) return { ok: false, msg: `supersede: both ids must exist (keep=${keepId} drop=${dropId})` };
	db.prepare("UPDATE memories SET supersedes_id = ?, valid_at = ? WHERE id = ?").run(keepId, new Date().toISOString(), dropId);
	logMem("supersede", `manual keep=#${keepId} drop=#${dropId}`);
	return { ok: true, msg: `memory #${dropId} superseded by #${keepId}` };
}

export function formatConsolidateReport(rep: ConsolidateReport): string {
	const head = `[${rep.dryRun ? "dry-run" : "applied"}] ${rep.p1.length} p1-changes, ${rep.nearMerges.filter((m) => m.merged).length} merges, ${rep.conflictsProposed.length} conflict-proposals`;
	const lines = [rep.skipped ? head + ` — SKIPPED: ${rep.skipped}` : head];
	const pre = rep.dryRun ? "would " : "";
	for (const c of rep.p1) {
		if (c.kind === "exact-dup") lines.push(`${pre}dedup drop=#${c.dropId} keep=#${c.keepId}`);
		else if (c.kind === "supersede-orphan") lines.push(`${pre}orphan #${c.id} (was -> #${c.oldTarget ?? "-"})`);
		else lines.push(`${pre}decay #${c.id} (${c.from.toFixed(2)} -> 0.30)`);
	}
	for (const m of rep.nearMerges) lines.push(m.merged ? `${pre}merge a=#${m.a} b=#${m.b}` : `merge-skip a=#${m.a} b=#${m.b} (no/invalid reply)`);
	for (const c of rep.conflictsProposed) lines.push(`${pre}conflict a=#${c.a} b=#${c.b} keep=${c.keepId ?? "none"} reason=${c.reason}`);
	lines.push(`user md: ${rep.userMdLines} lines`);
	return lines.join("\n");
}
