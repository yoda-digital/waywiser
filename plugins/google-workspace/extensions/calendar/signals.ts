/**
 * Calendar → proactive SignalProvider.
 *
 * Reads from the materialized calendar_projection (SQL-only, zero network)
 * and emits proactive Signals for the OODA engine. Registered from
 * this plugin's index.ts via registerSignalProvider() — respects spec 08 §6
 * so extensions/proactive.ts stays agnostic to plugin-owned domains.
 *
 * Emits three signal types (parity with pre-refactor inline behavior):
 *   - calendar-meeting-soon  (P1, next 30 min)
 *   - calendar-conflicts     (P1, overlapping opaque events today)
 *   - calendar-overloaded    (P2, >4h meetings today)
 */
import type { DatabaseSync } from "node:sqlite";
import type { Signal, SignalProvider } from "../../../../extensions/proactive.js";

export const calendarSignalProvider: SignalProvider = (db: DatabaseSync): Signal[] => {
	const signals: Signal[] = [];

	// Meeting soon (next 30 minutes).
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
	} catch { /* calendar_projection table not initialized yet */ }

	// Conflicts (overlapping opaque events today).
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
	} catch { /* calendar_projection table not initialized yet */ }

	// Overloaded day (>4h meetings in working window).
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
	} catch { /* calendar_projection table not initialized yet */ }

	return signals;
};
