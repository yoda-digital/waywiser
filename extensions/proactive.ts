/**
 * waywiser-*proactive — continuous proactive cognition engine.
 *
 * An OODA loop (Observe-Orient-Decide-Act) that ticks every 15 minutes
 * during active hours (30 min during quiet hours). On each tick, it:
 * 1. SENSE: SQL-only signal gathering (zero LLM cost)
 * 2. ORIENT: priority scoring + deduplication (+ quiet-hours gating)
 * 3. DECIDE + ACT: notify (desktop/Telegram, no LLM) or trigger agent turn
 *
 * The engine is driven by setTimeout, armed at agent_settled, cleared at
 * before_agent_start. This means:
 * - Between user interactions → engine ticks
 * - During user interaction → engine pauses
 * - User input always takes priority over proactive actions
 *
 * Self-triggering mechanism (proven by cronjob.ts): pi.sendUserMessage(text,
 * { deliverAs: "followUp" }) starts a full agent turn when idle, or queues
 * as a follow-up when streaming. Idle detection uses the cached-ctx pattern
 * (ctx is only available inside event handlers, not timer callbacks).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { db_, waywiserHome, readJSON, writeJSON, registry_ } from "./utils/state.js";
import { getQuiet, inDnd } from "./cronjob.js";
import { sendNotification } from "./notify.js";
import { applyDiscretion } from "./meta-skills.js";

// ── signal model ─────────────────────────────────────────────────────────

/** priority: 0 = interrupt, 1 = next-turn, 2 = briefing, 3 = background */
export interface Signal {
	key: string; // dedup key — stable per signal TYPE, not per item
	priority: 0 | 1 | 2 | 3;
	title: string; // notification title
	body: string; // notification body, or the agent prompt for turn-triggering signals
	requiresLLM: boolean; // true → sendUserMessage (agent turn); false → sendNotification
}

// ── config (~/.waywiser/config.json { "proactive": {...} }) ────────────────

export interface ProactiveConfig {
	enabled: boolean;
	tickActiveMs: number;
	tickQuietMs: number;
	dedupeWindowMs: number;
}

const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
	enabled: true,
	tickActiveMs: 15 * 60_000, // 15 min
	tickQuietMs: 30 * 60_000, // 30 min
	dedupeWindowMs: 60 * 60_000, // 1 hour
};

function configFile(): string {
	return path.join(waywiserHome(), "config.json");
}

export function getProactiveConfig(): ProactiveConfig {
	const full = readJSON<Record<string, unknown>>(configFile(), {});
	const raw = (full.proactive ?? {}) as Partial<ProactiveConfig>;
	return {
		enabled: raw.enabled !== false,
		tickActiveMs: typeof raw.tickActiveMs === "number" && raw.tickActiveMs > 0 ? raw.tickActiveMs : DEFAULT_PROACTIVE_CONFIG.tickActiveMs,
		tickQuietMs: typeof raw.tickQuietMs === "number" && raw.tickQuietMs > 0 ? raw.tickQuietMs : DEFAULT_PROACTIVE_CONFIG.tickQuietMs,
		dedupeWindowMs: typeof raw.dedupeWindowMs === "number" && raw.dedupeWindowMs > 0 ? raw.dedupeWindowMs : DEFAULT_PROACTIVE_CONFIG.dedupeWindowMs,
	};
}

/** Merge a patch into the persisted proactive config, preserving sibling
 *  top-level keys in config.json (executeCode, maxConcurrentChildren, ...). */
export function setProactiveConfig(patch: Partial<ProactiveConfig>): void {
	const file = configFile();
	const full = readJSON<Record<string, unknown>>(file, {});
	full.proactive = { ...getProactiveConfig(), ...patch };
	writeJSON(file, full);
}

// ── SENSE: SQL-only signal gathering (zero LLM cost) ────────────────────

/**
 * Gather proactive signals purely from SQLite + the filesystem. No LLM
 * calls, no network calls. Safe to run on every tick.
 */
export function gatherSignals(db: DatabaseSync, opts?: { lastAgentStartAt?: number; now?: Date }): Signal[] {
	const signals: Signal[] = [];
	const now = opts?.now ?? new Date();

	// 1. Overdue kanban cards.
	const overdue = db
		.prepare("SELECT id, title, due FROM cards WHERE due IS NOT NULL AND due < datetime('now') AND status NOT IN ('done') ORDER BY due LIMIT 5")
		.all() as Array<{ id: string; title: string; due: string }>;
	if (overdue.length) {
		signals.push({
			key: "overdue-cards",
			priority: 1,
			requiresLLM: true,
			title: "Overdue cards",
			body: `${overdue.length} card(s) overdue: ${overdue.map((c) => `${c.title} (due ${c.due})`).join(", ")}`,
		});
	}

	// 2. Goals past deadline — a true interrupt (P0), delivered without an LLM call.
	const pastDeadline = db
		.prepare("SELECT id, text, deadline FROM goals WHERE deadline IS NOT NULL AND deadline < datetime('now') AND status = 'active' ORDER BY deadline LIMIT 3")
		.all() as Array<{ id: string; text: string; deadline: string }>;
	if (pastDeadline.length) {
		signals.push({
			key: "goals-overdue",
			priority: 0,
			requiresLLM: false,
			title: "Goal deadline passed",
			body: `${pastDeadline.length} goal(s) past deadline: ${pastDeadline.map((g) => `${g.text} (${g.deadline})`).join("; ")}`,
		});
	}

	// 3. Goals near step budget (>80% of max_steps consumed).
	const nearBudget = db
		.prepare("SELECT id, text, steps_taken, max_steps FROM goals WHERE status = 'active' AND max_steps > 0 AND steps_taken > max_steps * 0.8")
		.all() as Array<{ id: string; text: string; steps_taken: number; max_steps: number }>;
	if (nearBudget.length) {
		signals.push({
			key: "goals-near-budget",
			priority: 1,
			requiresLLM: true,
			title: "Goal budget warning",
			body: `${nearBudget.length} goal(s) near step budget: ${nearBudget.map((g) => `${g.text} (${g.steps_taken}/${g.max_steps})`).join("; ")}`,
		});
	}

	// 4. Cron jobs disabled outside of an intentional one-shot completion
	//    (@ISO schedules disable themselves by design after firing once —
	//    excluding them keeps this signal focused on actual auto-pauses/
	//    manual pauses worth a second look, not routine one-shot cleanup).
	const pausedCron = db
		.prepare("SELECT id, name FROM cronjobs WHERE enabled = 0 AND schedule NOT LIKE '@%'")
		.all() as Array<{ id: string; name: string | null }>;
	if (pausedCron.length) {
		signals.push({
			key: "cron-paused",
			priority: 1,
			requiresLLM: true,
			title: "Cron jobs paused",
			body: `${pausedCron.length} cron job(s) disabled (auto-paused after repeated failures, or manually paused): ${pausedCron.map((c) => c.name ?? c.id).join(", ")}`,
		});
	}

	// 5. Brain evolution candidates awaiting review.
	try {
		const dir = path.join(waywiserHome(), "skills", "candidates");
		const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
		if (files.length) {
			signals.push({
				key: "evolution-candidates",
				priority: 2,
				requiresLLM: true,
				title: "Skill candidates pending review",
				body: `${files.length} evolution candidate(s) waiting in ~/.waywiser/skills/candidates/ — review and promote or discard.`,
			});
		}
	} catch {
		/* best effort — a broken candidates dir must not break the tick */
	}

	// 6. User absence check-in. Priority 2 (briefing bucket), so quiet-hours
	//    gating in orient() already restricts this to active hours.
	if (opts?.lastAgentStartAt) {
		const hoursSince = (now.getTime() - opts.lastAgentStartAt) / 3_600_000;
		if (hoursSince > 4) {
			signals.push({
				key: "user-absence",
				priority: 2,
				requiresLLM: true,
				title: "Check-in",
				body: `It has been ${hoursSince.toFixed(1)}h since the last interaction. Consider a brief check-in / status update for the user.`,
			});
		}
	}

	// 7. Calendar: meeting soon (next 30 minutes).
	// Reads from materialized projection (SQL-only, zero network).
	// Gracefully skipped if calendar_projection table doesn't exist (plugin not installed).
	try {
		const meetingSoon = db
			.prepare(
				`SELECT event_id, summary, start_at, calendar_id, account
				 FROM calendar_projection
				 WHERE start_at > datetime('now')
				   AND start_at <= datetime('now', '+30 minutes')
				   AND status != 'cancelled'
				   AND transparency != 'transparent'
				 ORDER BY start_at LIMIT 3`,
			)
			.all() as Array<{ event_id: string; summary: string; start_at: string; calendar_id: string; account: string }>;
		if (meetingSoon.length) {
			signals.push({
				key: "calendar-meeting-soon",
				priority: 1,
				requiresLLM: true,
				title: "Meeting soon",
				body: `${meetingSoon.length} meeting(s) starting within 30 minutes: ${meetingSoon.map((e) => `${e.summary ?? "(no title)"} at ${e.start_at}`).join(", ")}`,
			});
		}
	} catch { /* calendar_projection table may not exist — plugin not installed */ }

	// 8. Calendar: conflicts (overlapping opaque events today).
	try {
		const conflicts = db
			.prepare(
				`SELECT a.summary AS a_summary, b.summary AS b_summary, a.start_at, a.end_at
				 FROM calendar_projection a
				 JOIN calendar_projection b ON a.account = b.account
				   AND a.event_id < b.event_id
				   AND a.start_at < b.end_at AND a.end_at > b.start_at
				 WHERE a.start_at >= datetime('now', 'start of day')
				   AND a.start_at < datetime('now', '+1 day', 'start of day')
				   AND a.status != 'cancelled' AND b.status != 'cancelled'
				   AND a.transparency != 'transparent' AND b.transparency != 'transparent'
				   AND a.all_day = 0 AND b.all_day = 0
				 LIMIT 5`,
			)
			.all() as Array<{ a_summary: string; b_summary: string; start_at: string; end_at: string }>;
		if (conflicts.length) {
			signals.push({
				key: "calendar-conflicts",
				priority: 1,
				requiresLLM: true,
				title: "Calendar conflicts",
				body: `${conflicts.length} conflict(s) today: ${conflicts.map((c) => `"${c.a_summary ?? "?"}" overlaps "${c.b_summary ?? "?"}"`).join("; ")}`,
			});
		}
	} catch { /* calendar_projection table may not exist */ }

	// 9. Calendar: overloaded day (>4h meetings in working window).
	try {
		const meetingMinutes = db
			.prepare(
				`SELECT SUM(
				   (julianday(MIN(end_at, datetime('now', '+1 day', 'start of day'))) -
				    julianday(MAX(start_at, datetime('now', 'start of day')))) * 24 * 60
				 ) AS total_minutes
				 FROM calendar_projection
				 WHERE start_at < datetime('now', '+1 day', 'start of day')
				   AND end_at > datetime('now', 'start of day')
				   AND status != 'cancelled'
				   AND transparency != 'transparent'
				   AND all_day = 0`,
			)
			.get() as { total_minutes: number | null } | undefined;
		if (meetingMinutes?.total_minutes && meetingMinutes.total_minutes > 240) {
			signals.push({
				key: "calendar-overloaded",
				priority: 2,
				requiresLLM: true,
				title: "Overloaded day",
				body: `${Math.round(meetingMinutes.total_minutes)} minutes of meetings today (${(meetingMinutes.total_minutes / 60).toFixed(1)}h). Consider blocking focus time or rescheduling.`,
			});
		}
	} catch { /* calendar_projection table may not exist */ }

	return signals;
}

// ── ORIENT: priority scoring + deduplication (pure logic) ───────────────

/**
 * Filter signals against the dedup window and (optionally) quiet hours,
 * then sort by priority ascending. Signals that pass the filter are
 * immediately recorded into `lastAlerts` — orient() decides what gets
 * surfaced, so a signal counted here won't be reconsidered again until the
 * dedupe window elapses, even if delivery later fails (tick() undoes this
 * on a delivery failure so retries aren't blocked for a full hour).
 */
export function orient(
	signals: Signal[],
	lastAlerts: Map<string, number>,
	dedupeWindowMs: number,
	opts?: { quiet?: boolean; now?: number },
): Signal[] {
	const now = opts?.now ?? Date.now();
	const quiet = opts?.quiet ?? false;
	const out: Signal[] = [];
	for (const s of signals) {
		if (quiet && s.priority > 0) continue; // quiet hours: only true interrupts (P0) surface
		const last = lastAlerts.get(s.key);
		if (last !== undefined && now - last < dedupeWindowMs) continue; // deduped
		lastAlerts.set(s.key, now);
		out.push(s);
	}
	return out.sort((a, b) => a.priority - b.priority);
}

// ── extension entry ──────────────────────────────────────────────────────

export default function proactive(pi: ExtensionAPI): void {
	let latestCtx: ExtensionContext | undefined;
	let proactiveTimer: NodeJS.Timeout | undefined;
	let lastAgentStartAt = Date.now(); // baseline: "now" so a fresh session doesn't false-positive on absence
	let lastTickAt: number | undefined;
	let lastSignalCount = 0;
	const lastAlerts = new Map<string, number>(); // dedup: key → timestamp

	const isQuietNow = (): boolean => {
		const q = getQuiet();
		return q ? inDnd(q.start, q.end, new Date()) : false;
	};

	const clearTimer = (): void => {
		if (proactiveTimer) {
			clearTimeout(proactiveTimer);
			proactiveTimer = undefined;
		}
	};

	const armTimer = (): void => {
		clearTimer();
		const cfg = getProactiveConfig();
		if (!cfg.enabled) return; // disabled — no timer at all until re-enabled
		const interval = isQuietNow() ? cfg.tickQuietMs : cfg.tickActiveMs;
		proactiveTimer = setTimeout(() => {
			tick().catch((e) => registry_().log("proactive", `tick failed: ${String(e)}`));
		}, interval);
		(proactiveTimer as unknown as { unref?: () => void }).unref?.();
	};

	/** force=true (used by `/proactive tick`) bypasses the enabled/idle gates for testing. */
	const tick = async (opts?: { force?: boolean }): Promise<void> => {
		lastTickAt = Date.now();
		const cfg = getProactiveConfig();
		if (!opts?.force) {
			if (!cfg.enabled) return; // no re-arm — stays fully off
			if (!latestCtx?.isIdle?.()) {
				armTimer(); // user took over — re-check next interval
				return;
			}
		}

		let signals: Signal[];
		try {
			signals = gatherSignals(db_(), { lastAgentStartAt });
		} catch (e) {
			registry_().log("proactive", `sense failed: ${String(e)}`);
			armTimer();
			return;
		}

		const prioritized = orient(signals, lastAlerts, cfg.dedupeWindowMs, { quiet: isQuietNow() });
		// Discretion (spec 07 §3.2): never propagate sensitive content, don't nag
		// (max 3/hour), don't interrupt a deep conversation with non-critical signals.
		const discreet = applyDiscretion(prioritized);
		lastSignalCount = discreet.length;

		for (const signal of discreet) {
			if (!signal.requiresLLM) {
				// P0 interrupts always bypass quiet hours (they already passed the
				// quiet gate above for P0 by construction); notify-only signals never
				// occupy the model.
				await sendNotification(signal.title, signal.body, undefined, { bypassQuiet: signal.priority === 0 });
				registry_().log("proactive", `notify [${signal.key}] ${signal.title}`);
				continue;
			}
			try {
				pi.sendUserMessage(`[proactive] ${signal.body}`, { deliverAs: "followUp" });
				registry_().log("proactive", `turn [${signal.key}] ${signal.title}`);
				break; // one agent turn per tick (no priority system for queued messages)
			} catch (e) {
				// Compaction in progress / no model configured — don't burn the
				// dedupe window on a signal that never actually reached the user.
				lastAlerts.delete(signal.key);
				registry_().log("proactive", `turn delivery failed [${signal.key}]: ${String(e)}`);
			}
		}

		armTimer();
	};

	pi.on("agent_settled", (_e, ctx) => {
		latestCtx = ctx;
		armTimer();
	});

	pi.on("before_agent_start", (event, ctx) => {
		latestCtx = ctx;
		// Don't let our own proactive-triggered turns reset the absence clock.
		if (!event.prompt?.startsWith("[proactive]")) lastAgentStartAt = Date.now();
		clearTimer(); // user (or a triggered turn) is active — pause proactive
	});

	pi.registerCommand("proactive", {
		description: "Proactive engine: /proactive [status|on|off|tick|signals]",
		handler: async (args, ctx) => {
			latestCtx = ctx; // keep the cached ctx fresh (same idiom as cronjob's tool execute())
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			const cfg = getProactiveConfig();

			if (sub === "on") {
				setProactiveConfig({ enabled: true });
				armTimer();
				ctx.ui.notify("Proactive engine enabled.", "info");
				return;
			}
			if (sub === "off") {
				setProactiveConfig({ enabled: false });
				clearTimer();
				ctx.ui.notify("Proactive engine disabled.", "info");
				return;
			}
			if (sub === "tick") {
				ctx.ui.notify("Forcing an immediate proactive tick...", "info");
				await tick({ force: true });
				ctx.ui.notify(`Tick complete. ${lastSignalCount} signal(s) surfaced.`, "info");
				return;
			}
			if (sub === "signals") {
				let signals: Signal[];
				try {
					signals = gatherSignals(db_(), { lastAgentStartAt });
				} catch (e) {
					ctx.ui.notify(`signal scan failed: ${String(e)}`, "error");
					return;
				}
				// Preview against a throwaway dedup map + discretion sendLog so this
				// doesn't consume the real dedupe window or notification quota for
				// signals that haven't actually been acted on.
				const preview = orient(signals, new Map(), cfg.dedupeWindowMs, { quiet: isQuietNow() });
				const previewDiscreet = applyDiscretion(preview, { sendLog: [] });
				ctx.ui.notify(
					previewDiscreet.length
						? previewDiscreet.map((s) => `P${s.priority} [${s.requiresLLM ? "turn" : "notify"}] ${s.title}: ${s.body}`).join("\n")
						: "No pending signals.",
					"info",
				);
				return;
			}

			// status (default, including unknown subcommands)
			const lines = [
				`Proactive engine: ${cfg.enabled ? "ON" : "OFF"}`,
				`Tick interval: ${cfg.tickActiveMs / 60_000}min active / ${cfg.tickQuietMs / 60_000}min quiet`,
				`Dedup window: ${cfg.dedupeWindowMs / 60_000}min`,
				`Last tick: ${lastTickAt ? new Date(lastTickAt).toISOString() : "never"}`,
				`Next tick: ${proactiveTimer ? "armed (agent idle)" : "not armed (agent busy, or disabled)"}`,
				`Quiet hours now: ${isQuietNow() ? "yes" : "no"}`,
				`Last scan surfaced: ${lastSignalCount} signal(s)`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
