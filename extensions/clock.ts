/**
 * waywiser clock — status bar clock + system prompt time injection.
 *
 * Provides always-visible time in the TUI footer and injects temporal
 * context into the LLM system prompt so the model can reference time
 * naturally.
 *
 * Uses the latestCtx caching pattern (same as proactive.ts) to update
 * the status bar from a setInterval callback.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fmtTime, fmtDuration, userTz } from "./utils/time.js";
import { registerInjection, PRIORITIES } from "./utils/prompt-budget.js";

export default function clock(pi: ExtensionAPI): void {
	let latestCtx: ExtensionContext | undefined;
	let sessionStartAt: number = Date.now();

	const updateClock = (): void => {
		if (latestCtx) {
			latestCtx.ui.setStatus("waywiser:clock", `🕐 ${fmtTime(Date.now())}`);
		}
	};

	function buildTimeContext(): string {
		const now = new Date();
		const tz = userTz();
		const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
		const datePart = now.toLocaleDateString("en-US", {
			timeZone: tz,
			year: "numeric",
			month: "short",
			day: "numeric",
		});
		const timePart = fmtTime(Date.now());
		const elapsed = fmtDuration(Date.now() - sessionStartAt);

		return `\n[Time context]\nCurrent: ${dayName}, ${datePart} ${timePart} (${tz})\nSession active: ${elapsed}\n`;
	}

	pi.on("session_start", (_event, ctx) => {
		sessionStartAt = Date.now();
		// Grab ctx here too — otherwise the status bar is blank until the
		// user's first turn (before_agent_start), and the 1-min interval
		// no-ops the whole time because latestCtx is still undefined.
		latestCtx = ctx;
		updateClock();
	});

	pi.on("before_agent_start", (_event, ctx) => {
		latestCtx = ctx;
		updateClock();

		// Register volatile time injection — refreshed every turn
		registerInjection({
			key: "time-context",
			priority: PRIORITIES.TIME_CONTEXT,
			content: buildTimeContext(),
			cacheable: false,
		});
	});

	pi.on("agent_settled", (_event, ctx) => {
		latestCtx = ctx;
		updateClock();
	});

	// 1-minute idle clock — keeps the status bar current between turns
	const clockInterval = setInterval(updateClock, 60_000);
	(clockInterval as unknown as { unref?: () => void }).unref?.();

	pi.on("session_shutdown", () => {
		clearInterval(clockInterval);
	});
}
