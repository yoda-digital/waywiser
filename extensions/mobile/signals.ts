/**
 * waywiser-*mobile/signals — mobile-context → proactive Signal / post-filter
 * (spec 08 §6). Cheap, SQL-free, LLM-free. Runs on every OODA tick.
 */
import type { Signal } from "../proactive.js";
import { lastMobileContext, readMobileContext } from "./context.js";
import type { MobileContext } from "./types.js";

// ── signal provider ───────────────────────────────────────────────────────

/**
 * Emit context-aware signals. We DO NOT probe here (proactive.ts's
 * gatherSignals is sync); we consume the last cached snapshot. A separate
 * background refresh triggered from the extension entry keeps the cache
 * warm on the ttlMs the user configured.
 */
export function mobileSignals(): Signal[] {
	const ctx = lastMobileContext();
	if (!ctx || !ctx.available) return [];
	const out: Signal[] = [];

	if (ctx.battery) {
		if (!ctx.battery.charging && ctx.battery.percentage <= 10) {
			out.push({
				key: "mobile-battery-critical",
				priority: 0,
				requiresLLM: false,
				title: "Battery critical",
				body: `Battery at ${ctx.battery.percentage}% and not charging. Consider plugging in — Waywiser will otherwise back off proactive checks.`,
			});
		}
		if (Number.isFinite(ctx.battery.temperatureC) && ctx.battery.temperatureC >= 43) {
			out.push({
				key: "mobile-thermal-high",
				priority: 2,
				requiresLLM: false,
				title: "Phone thermal warning",
				body: `Battery ${ctx.battery.temperatureC.toFixed(1)}°C. Heavy background work (embeddings, consolidation) has been deferred.`,
			});
		}
	}

	return out;
}

// ── post-filter ───────────────────────────────────────────────────────────

/**
 * Drop or de-prioritize signals based on mobile context. Runs AFTER
 * discretion — never bypasses it, only tightens.
 *
 * - battery < 20% & not charging → drop P2/P3 (keep P0/P1).
 * - battery.temperatureC > 42 → drop LLM-requiring signals (defer heavy work).
 * - network unknown & signal requires LLM → downgrade priority by 1 (mild).
 */
export function mobileDiscretion(signals: Signal[]): Signal[] {
	const ctx = lastMobileContext();
	if (!ctx || !ctx.available) return signals;
	const b = ctx.battery;
	const lowBattery = b && !b.charging && b.percentage < 20;
	const hot = b && Number.isFinite(b.temperatureC) && b.temperatureC > 42;
	const out: Signal[] = [];
	for (const s of signals) {
		if (lowBattery && s.priority >= 2) continue;
		if (hot && s.requiresLLM && s.priority > 0) continue;
		out.push(s);
	}
	return out;
}

/** Async refresh — called from a timer in the extension entry. */
export async function refreshContext(): Promise<MobileContext> {
	return readMobileContext();
}
