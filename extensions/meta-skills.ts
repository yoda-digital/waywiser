/**
 * waywiser-*meta-skills — behavioral engines for the 6 cross-cutting meta-skills
 * (spec 07 §3). Anticipatory Thinking and Continuous Learning are already covered
 * by proactive.ts and Brain respectively; this module implements the other four
 * as concrete runtime behavior, not just SOUL.md prose:
 *
 * 1. Emotional Intelligence — turn_end analyzer. Detects frustration/satisfaction
 *    from message patterns (correction language, "!!"/CAPS/please stress markers,
 *    a short reply after a long exchange, or positive markers) and injects a
 *    short awareness note into the NEXT turn's system prompt while the signal
 *    stays non-neutral. Ephemeral (in-memory only) — never written to the DB.
 *
 * 2. Discretion — applyDiscretion(signals) filters proactive Signals before
 *    delivery: drops anything that looks like a secret/financial detail
 *    (regardless of channel or priority), suppresses non-critical (priority>0)
 *    signals while the user is mid-flow ("deep conversation" = more than 5
 *    turns since the last pause) or once 3 notifications have already gone out
 *    this hour. True interrupts (priority 0) bypass the deep-conversation and
 *    quota gates (they already bypass quiet hours in proactive.ts) but are still
 *    subject to the sensitive-content check. Wired into proactive.ts's tick()
 *    and its `/proactive signals` preview.
 *
 * 3. Adaptability — turn_end detector for same-session corrections ("no, use X",
 *    "always use Y", "too verbose", "shorter"/"more detail"). On a hit it stores
 *    a memory IMMEDIATELY (does not wait for agent_settled/Brain's reflective
 *    pass) and injects a ONE-TURN "[Correction applied]" note into the very next
 *    turn's system prompt.
 *
 * 4. Multi-tasking — on agent_settled, while idle, looks for kanban cards flagged
 *    assignee='subagent' that have no worker actually running (crash/restart, or
 *    assignee set without going through the kanban tool's assign action) and
 *    reuses kanban's own worker (spawnCard) to pick the work up; and for active
 *    goals with zero recorded progress, surfaces a delegation suggestion via
 *    notification. Never injects into the conversation — matches kanban's own
 *    house style of reporting through the card + a notification, not chat.
 *    (MCP polling has no persisted queue in this codebase yet — spec §2.4 is
 *    aspirational — so that source is a documented no-op for now.)
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import { db_, registry_, rememberRow, recentMemories, logMem, homeFile } from "./utils/state.js";
import { extractText, lastUserEntry, jaccard, DUPLICATE_JACCARD } from "./memrules.js";
import { registerInjection, removeInjection, PRIORITIES } from "./utils/prompt-budget.js";
import { sendNotification } from "./notify.js";
import { spawnCard } from "./kanban/worker.js";
import { getCard } from "./kanban/shared.js";
import type { Signal } from "./proactive.js"; // type-only — no runtime import of proactive.ts

// ══════════════════════════════════════════════════════════════════════════
// 1. Emotional Intelligence
// ══════════════════════════════════════════════════════════════════════════

export type EmotionalContext = "neutral" | "frustrated" | "satisfied";

const SHORT_MESSAGE_WORDS = 10;
const LONG_EXCHANGE_CHARS = 500;

const CORRECTION_MARKERS = [/\bno,/i, /\bwrong\b/i, /\bthat'?s not\b/i, /\bagain\b/i];
const REPEAT_BANG_RE = /!!+/;
const ALLCAPS_WORD_RE = /\b[A-Z]{3,}\b/;
const PLEASE_RE = /\bplease\b/i;
const POSITIVE_RE = /\b(thanks|thank you|great|perfect)\b/i;

function frustrationScore(text: string, prevAssistantLen: number): number {
	let score = 0;
	if (CORRECTION_MARKERS.some((re) => re.test(text))) score += 2;
	if (REPEAT_BANG_RE.test(text)) score += 1;
	if (ALLCAPS_WORD_RE.test(text)) score += 1;
	if (PLEASE_RE.test(text)) score += 0.5; // supporting signal only — "please" alone must not trip frustration
	const words = text.split(/\s+/).filter(Boolean).length;
	if (words > 0 && words < SHORT_MESSAGE_WORDS && prevAssistantLen > LONG_EXCHANGE_CHARS) score += 1;
	return score;
}

/** Pure — analyzes one user message (+ the length of the assistant turn that
 *  preceded it) and returns the emotional signal. prevAssistantLen=0 means
 *  "no prior turn" (first message of a session), so the short-message rule
 *  never fires on an opening message. */
export function detectEmotionalSignal(userText: string, prevAssistantLen = 0): EmotionalContext {
	const t = (userText ?? "").trim();
	if (!t) return "neutral";
	if (frustrationScore(t, prevAssistantLen) >= 1) return "frustrated";
	if (POSITIVE_RE.test(t)) return "satisfied";
	return "neutral";
}

const FRUSTRATED_NOTE =
	"[Emotional awareness] The user seems frustrated. Be concise, acknowledge what went wrong, and focus on the solution. Avoid lengthy explanations.";
const SATISFIED_NOTE = "[Emotional awareness] The user is satisfied with the current approach. Continue in this style.";

// ══════════════════════════════════════════════════════════════════════════
// 2. Discretion
// ══════════════════════════════════════════════════════════════════════════

const MAX_NOTIFICATIONS_PER_HOUR = 3;
const DEEP_CONVERSATION_TURNS = 5;
const HOUR_MS = 3_600_000;

const SENSITIVE_PATTERNS: RegExp[] = [
	/\bpassword\b/i,
	/\bpasswd\b/i,
	/\bapi[_-]?key\b/i,
	/\bsecret[_-]?key\b/i,
	/\bprivate[_-]?key\b/i,
	/\baccess[_-]?token\b/i,
	/\bcredit\s*card\b/i,
	/\bcvv\b/i,
	/\bssn\b/i,
	/\bsocial\s+security\b/i,
	/\biban\b/i,
	/\bbank\s+account\b/i,
	/\b(?:\d[ -]?){13,19}\b/, // long digit run — card/account-number shaped
];

/** True if text looks like it carries a secret or a financial detail. Whole-signal
 *  block, not per-channel: Signal doesn't carry channel targeting at this layer, and
 *  refusing to propagate the signal at all is the safer reading of "never send
 *  sensitive content via Telegram." */
export function containsSensitiveContent(text: string): boolean {
	return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

export interface DiscretionOptions {
	now?: number;
	/** Turns since the last pause in the CURRENT session (proxy for "deep conversation"). */
	deepConversationTurns?: number;
	/** Timestamps (ms) of notifications already sent this hour; mutated in place. */
	sendLog?: number[];
	maxPerHour?: number;
	deepConversationThreshold?: number;
}

// Module-level discretion state (ephemeral — mirrors notify.ts's own per-process
// rate-limit posture, which also resets on restart).
const discretionState = {
	turnsSincePause: 0,
	sendLog: [] as number[],
	suppressedCount: 0,
};

/**
 * Filter proactive Signals before delivery (spec §3.2 discretion rules):
 * - drop anything that reads as a secret/financial detail, regardless of priority;
 * - suppress non-critical (priority>0) signals during a "deep conversation"
 *   (more than `deepConversationThreshold` turns since the last pause) — this is
 *   also how "don't volunteer information the user hasn't asked about" is
 *   enforced here: no topic classifier, just "don't interrupt an active thread";
 * - cap non-critical deliveries at `maxPerHour` (default 3) — "don't nag".
 * True interrupts (priority 0) bypass the deep-conversation and quota gates
 * (proactive.ts already lets them bypass quiet hours) but are NOT exempt from
 * the sensitive-content check.
 */
export function applyDiscretion(signals: Signal[], opts?: DiscretionOptions): Signal[] {
	const now = opts?.now ?? Date.now();
	const maxPerHour = opts?.maxPerHour ?? MAX_NOTIFICATIONS_PER_HOUR;
	const deepThreshold = opts?.deepConversationThreshold ?? DEEP_CONVERSATION_TURNS;
	const sendLog = opts?.sendLog ?? discretionState.sendLog;
	const deepTurns = opts?.deepConversationTurns ?? discretionState.turnsSincePause;

	while (sendLog.length && sendLog[0] < now - HOUR_MS) sendLog.shift();

	const out: Signal[] = [];
	for (const s of signals) {
		if (containsSensitiveContent(s.title) || containsSensitiveContent(s.body)) {
			discretionState.suppressedCount++;
			continue;
		}
		if (s.priority > 0) {
			if (deepTurns > deepThreshold) {
				discretionState.suppressedCount++;
				continue;
			}
			if (sendLog.length >= maxPerHour) {
				discretionState.suppressedCount++;
				continue;
			}
			sendLog.push(now);
		}
		out.push(s);
	}
	return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 3. Adaptability
// ══════════════════════════════════════════════════════════════════════════

export interface Correction {
	kind: "preference" | "style";
	value: string;
	/** Durable memory content — stored immediately, not deferred to agent_settled. */
	content: string;
	/** One-turn system-prompt note. */
	note: string;
}

function correctionNote(subject: string): string {
	return `[Correction applied] ${subject} Adjusted for this session.`;
}

/** Pure — same-session correction detector (spec §3.2). Returns null when the
 *  message doesn't match a known correction/style-adjustment pattern. */
export function detectCorrection(userText: string): Correction | null {
	const t = (userText ?? "").trim();
	if (!t) return null;

	let m = t.match(/\bno,?\s+use\s+([^.,;!?\n]{2,80})/i);
	if (m) {
		const value = m[1].trim();
		return {
			kind: "preference",
			value,
			content: `Corrected mid-session: use ${value} instead of the previous choice.`,
			note: correctionNote(`User prefers ${value}.`),
		};
	}

	m = t.match(/\balways\s+use\s+([^.,;!?\n]{2,80})/i);
	if (m) {
		const value = m[1].trim();
		return {
			kind: "preference",
			value,
			content: `Strong preference: always use ${value}.`,
			note: correctionNote(`User always wants ${value}.`),
		};
	}

	if (/\btoo\s+verbose\b/i.test(t) || /\btoo\s+long\b/i.test(t) || /\bbe\s+more\s+concise\b/i.test(t) || /\bshorter\b/i.test(t)) {
		return {
			kind: "style",
			value: "shorter",
			content: "User wants shorter, more concise responses.",
			note: correctionNote("User wants shorter responses."),
		};
	}

	if (/\bmore\s+detail(ed)?\b/i.test(t) || /\bmore\s+thorough\b/i.test(t) || /\bmore\s+verbose\b/i.test(t)) {
		return {
			kind: "style",
			value: "more detail",
			content: "User wants more detail in responses.",
			note: correctionNote("User wants more detail in responses."),
		};
	}

	return null;
}

// ══════════════════════════════════════════════════════════════════════════
// 4. Multi-tasking
// ══════════════════════════════════════════════════════════════════════════

export interface DelegationSignal {
	kind: "kanban-card" | "goal-research";
	key: string; // dedup key
	id: string; // card id or goal id
	title: string;
}

/** Pure, SQL-only — mirrors proactive.ts's gatherSignals shape/spirit (zero LLM cost). */
export function gatherDelegationSignals(db: DatabaseSync): DelegationSignal[] {
	const out: DelegationSignal[] = [];

	// Cards flagged for a subagent worker with none actually running — either
	// the assignee was set without going through the kanban tool's own
	// assign(who=subagent) (which spawns immediately), or a worker died
	// without clearing worker_child (process restart mid-run).
	const cards = db
		.prepare(
			"SELECT id, title FROM cards WHERE assignee = 'subagent' AND status IN ('todo','doing') " +
				"AND (worker_child IS NULL OR worker_child = '') ORDER BY updated_at LIMIT 3",
		)
		.all() as Array<{ id: string; title: string }>;
	for (const c of cards) out.push({ kind: "kanban-card", key: `card-${c.id}`, id: c.id, title: c.title });

	// Active goals nobody has made any progress on yet.
	const goals = db
		.prepare("SELECT id, text FROM goals WHERE status = 'active' AND (steps_taken IS NULL OR steps_taken = 0) ORDER BY created_at LIMIT 3")
		.all() as Array<{ id: string; text: string }>;
	for (const g of goals) out.push({ kind: "goal-research", key: `goal-${g.id}`, id: g.id, title: g.text });

	return out;
}

const MULTITASK_DEDUPE_MS = 30 * 60_000;
const multitaskAlerts = new Map<string, number>();
let multitaskSpawnCount = 0;

async function runMultitask(ctx: ExtensionContext | undefined): Promise<void> {
	if (!ctx || !ctx.isIdle()) return;
	let signals: DelegationSignal[];
	try {
		signals = gatherDelegationSignals(db_());
	} catch (e) {
		registry_().log("multitask", `sense failed: ${String(e)}`);
		return;
	}
	const now = Date.now();
	const due = signals.filter((s) => {
		const last = multitaskAlerts.get(s.key);
		return last === undefined || now - last >= MULTITASK_DEDUPE_MS;
	});
	if (!due.length) return;

	const target = due[0]; // one delegation action per idle tick — same conservative posture as proactive.tick()
	multitaskAlerts.set(target.key, now);

	if (target.kind === "kanban-card") {
		const card = getCard(target.id);
		if (!card) return;
		try {
			const r = await spawnCard(card, ctx.cwd, 900_000);
			registry_().log("multitask", `spawn ${target.id}: ${r.msg}`);
			if (r.ok) {
				multitaskSpawnCount++;
				// Report via notification, not chat — the finished report itself lands
				// on the card (kanban's own worker.ts already does that + a registry log).
				await sendNotification("Multi-tasking", `Started background work on kanban card ${target.id}: "${target.title}". Report lands on the card when it finishes.`);
			}
		} catch (e) {
			registry_().log("multitask", `spawn failed for ${target.id}: ${String(e)}`);
		}
		return;
	}

	// goal-research: no safe generic "research this goal" spawn mechanism exists
	// yet in this codebase (delegate_task's spawn logic is a tool-call closure,
	// not a reusable function) — surface it as a suggestion instead of inventing
	// new spawn infrastructure under time pressure.
	await sendNotification("Multi-tasking", `Goal "${target.title}" (${target.id}) has no progress yet. Consider delegate_task to research it in the background.`);
}

// ══════════════════════════════════════════════════════════════════════════
// Extension entry
// ══════════════════════════════════════════════════════════════════════════

export default function metaSkills(pi: ExtensionAPI): void {
	let emotionalContext: EmotionalContext = "neutral";
	let prevAssistantLen = 0;
	let pendingCorrectionNote: string | null = null;
	let correctionsThisSession: Array<{ at: number; content: string }> = [];
	let turnsSincePause = 0;
	let lastTurnAt = 0;
	const PAUSE_GAP_MS = 10 * 60_000;

	pi.on("session_start", () => {
		emotionalContext = "neutral";
		prevAssistantLen = 0;
		pendingCorrectionNote = null;
		correctionsThisSession = [];
		turnsSincePause = 0;
		lastTurnAt = 0;
		discretionState.turnsSincePause = 0;
		discretionState.sendLog = [];
		discretionState.suppressedCount = 0;
		multitaskAlerts.clear();
		multitaskSpawnCount = 0;
	});

	// Deep-conversation tracking for the Discretion engine — increments on every
	// real user turn, resets after a gap longer than PAUSE_GAP_MS.
	pi.on("before_agent_start", (event) => {
		if (!/^\[\d{2}:\d{2} proactive\]/.test(event.prompt ?? "")) {
			const now = Date.now();
			if (lastTurnAt && now - lastTurnAt > PAUSE_GAP_MS) turnsSincePause = 0;
			turnsSincePause += 1;
			lastTurnAt = now;
			discretionState.turnsSincePause = turnsSincePause;
		}

		// Emotional awareness — persists across turns while the signal stays non-neutral.
		if (emotionalContext === "frustrated") {
			registerInjection({ key: "meta-emotional", priority: PRIORITIES.META_EMOTIONAL, cacheable: false, content: `\n\n${FRUSTRATED_NOTE}` });
		} else if (emotionalContext === "satisfied") {
			registerInjection({ key: "meta-emotional", priority: PRIORITIES.META_EMOTIONAL, cacheable: false, content: `\n\n${SATISFIED_NOTE}` });
		} else {
			removeInjection("meta-emotional");
		}

		// Correction note — exactly ONE turn: registered here once (this call
		// consumes the pending flag), cleared on the following before_agent_start.
		if (pendingCorrectionNote) {
			registerInjection({ key: "meta-correction", priority: PRIORITIES.META_CORRECTION, cacheable: false, content: `\n\n${pendingCorrectionNote}` });
			pendingCorrectionNote = null;
		} else {
			removeInjection("meta-correction");
		}
		// NO return — buildSystemPrompt (index.ts) handles final assembly.
	});

	pi.on("turn_end", (event, ctx) => {
		try {
			const userEntry = lastUserEntry(ctx);
			if (userEntry) {
				emotionalContext = detectEmotionalSignal(userEntry.text, prevAssistantLen);

				const correction = detectCorrection(userEntry.text);
				if (correction) {
					const db = db_();
					const existing = recentMemories(db, 50);
					const dup = existing.find((e) => jaccard(e.content, correction.content) >= DUPLICATE_JACCARD);
					if (!dup) {
						rememberRow(db, {
							type: "preference",
							content: correction.content,
							confidence: 0.75,
							source: "agent",
							sourceSession: "meta-skills-adaptability",
						});
						try {
							fs.appendFileSync(homeFile("MEMORY.md"), `- [preference] ${correction.content}\n`);
						} catch {
							/* best effort */
						}
						logMem("meta-adaptability", correction.content.slice(0, 100));
					}
					pendingCorrectionNote = correction.note;
					correctionsThisSession.push({ at: Date.now(), content: correction.content });
				}
			}
			// This turn's assistant response length feeds the NEXT turn_end's
			// "short reply after a long exchange" comparison.
			prevAssistantLen = extractText((event.message as { content?: unknown } | undefined)?.content).length;
		} catch {
			/* meta-skills must never break the session — same posture as memory.ts's gate */
		}
	});

	pi.on("agent_settled", (_e, ctx) => {
		void runMultitask(ctx);
	});

	pi.registerCommand("meta-skills", {
		description: "Meta-skill behavioral engines: /meta-skills [emotional|discretion|corrections]",
		handler: async (args: string, ctx: ExtensionContext) => {
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

			if (sub === "emotional") {
				ctx.ui.notify(`Emotional context: ${emotionalContext}`, "info");
				return;
			}
			if (sub === "discretion") {
				const now = Date.now();
				const recent = discretionState.sendLog.filter((t) => t > now - HOUR_MS).length;
				ctx.ui.notify(
					[
						`Notifications sent this hour: ${recent}/${MAX_NOTIFICATIONS_PER_HOUR}`,
						`Suppressed (all-time this session): ${discretionState.suppressedCount}`,
						`Turns since last pause: ${turnsSincePause} (deep conversation: ${turnsSincePause > DEEP_CONVERSATION_TURNS ? "yes" : "no"})`,
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "corrections") {
				ctx.ui.notify(
					correctionsThisSession.length
						? correctionsThisSession.map((c) => `[${new Date(c.at).toISOString()}] ${c.content}`).join("\n")
						: "No corrections detected this session.",
					"info",
				);
				return;
			}

			// status (default, including unknown subcommands)
			ctx.ui.notify(
				[
					"Meta-skill engines:",
					`  emotional intelligence: ${emotionalContext}`,
					`  discretion: ${discretionState.sendLog.filter((t) => t > Date.now() - HOUR_MS).length}/${MAX_NOTIFICATIONS_PER_HOUR} sent this hour, ${discretionState.suppressedCount} suppressed`,
					`  adaptability: ${correctionsThisSession.length} correction(s) this session`,
					`  multi-tasking: ${multitaskSpawnCount} spawn(s), ${multitaskAlerts.size} candidate(s) tracked`,
				].join("\n"),
				"info",
			);
		},
	});
}
