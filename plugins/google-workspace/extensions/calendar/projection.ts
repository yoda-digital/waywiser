/**
 * Materialized projection — a bounded, read-only, disposable local view
 * of Google Calendar events for the proactive engine.
 *
 * Blueprint §27-29:
 * - Projection is NOT a sync engine, NOT bi-directional
 * - Google + gog remain source of truth
 * - SENSE reads from projection (SQL-only, zero network)
 * - Refresh is bounded full-window replacement with transactional semantics
 * - Failed fetch retains last-good snapshot, marks stale
 *
 * Default window: now - 24h → now + 14d
 * Default refresh: every 15 minutes
 */
import { randomBytes } from "node:crypto";
import { db_ } from "../../../../extensions/utils/state.js";
import type { GogRunner } from "../../shared/gog-runner.js";
import type { GoogleWorkspaceConfig } from "../../shared/accounts.js";
import { buildGogInvocation } from "./invocation.js";
import { CALENDAR_OPERATIONS } from "./operations.js";
import { normalizeEvents } from "./normalize.js";

let projectionTimer: NodeJS.Timeout | undefined;
let lastRefreshAt: number | undefined;

// ── Schema ──────────────────────────────────────────────────────────

/** Create projection tables if they don't exist (idempotent). */
export function initProjectionTables(): void {
	db_().exec(`
		CREATE TABLE IF NOT EXISTS calendar_projection (
			provider        TEXT NOT NULL,
			account         TEXT NOT NULL,
			calendar_id     TEXT NOT NULL,
			event_id        TEXT NOT NULL,
			summary         TEXT,
			description     TEXT,
			location        TEXT,
			start_at        TEXT,
			end_at          TEXT,
			start_date      TEXT,
			end_date        TEXT,
			all_day         INTEGER NOT NULL DEFAULT 0,
			status          TEXT,
			event_type      TEXT,
			transparency    TEXT,
			recurring_event_id TEXT,
			original_start     TEXT,
			updated_at      TEXT,
			snapshot_id     TEXT NOT NULL,
			projected_at    TEXT NOT NULL,
			raw_json        TEXT,
			PRIMARY KEY (provider, account, calendar_id, event_id)
		);

		CREATE INDEX IF NOT EXISTS calendar_projection_time
		ON calendar_projection(account, start_at, end_at);

		CREATE TABLE IF NOT EXISTS calendar_projection_state (
			provider        TEXT NOT NULL,
			account         TEXT NOT NULL,
			last_success_at TEXT,
			last_attempt_at TEXT,
			snapshot_id     TEXT,
			stale           INTEGER NOT NULL DEFAULT 1,
			last_error      TEXT,
			PRIMARY KEY(provider, account)
		);
	`);
}

// ── Refresh ─────────────────────────────────────────────────────────

/**
 * Refresh the materialized projection for a single account.
 *
 * Transactional snapshot semantics (blueprint §29):
 * 1. Fetch full bounded snapshot
 * 2. On success: BEGIN → write new rows → delete old rows → update state → COMMIT
 * 3. On failure: retain last-good data, mark stale, store error
 */
export async function refreshProjectionForAccount(
	runner: GogRunner,
	config: GoogleWorkspaceConfig,
	account: string,
): Promise<{ success: boolean; eventCount: number; error?: string }> {
	const d = db_();
	const snapshotId = randomBytes(8).toString("hex");
	const now = new Date().toISOString();
	const proj = config.calendar.projection;

	// Build time window
	const from = new Date(Date.now() - proj.pastHours * 3600_000).toISOString();
	const to = new Date(Date.now() + proj.futureDays * 86_400_000).toISOString();

	// Fetch events via gog
	const spec = CALENDAR_OPERATIONS.events;
	const invocation = buildGogInvocation(spec, account, [
		config.calendar.defaultCalendar,
		"--from", from,
		"--to", to,
		"--all-pages",
		`--max=${config.calendar.limits.maxPageResults}`,
	]);

	let result;
	try {
		result = await runner.run(invocation);
	} catch (e) {
		const errMsg = `spawn failed: ${e instanceof Error ? e.message : String(e)}`;
		d.prepare(
			`INSERT OR REPLACE INTO calendar_projection_state
			 (provider, account, last_attempt_at, stale, last_error)
			 VALUES ('google', ?, ?, 1, ?)`,
		).run(account, now, errMsg);
		return { success: false, eventCount: 0, error: errMsg };
	}

	// Record attempt
	d.prepare(
		`INSERT OR REPLACE INTO calendar_projection_state
		 (provider, account, last_attempt_at, stale, last_error, snapshot_id, last_success_at)
		 VALUES ('google', ?, ?,
		   COALESCE((SELECT stale FROM calendar_projection_state WHERE provider='google' AND account=?), 1),
		   CASE WHEN ? = 0 THEN NULL ELSE ? END,
		   COALESCE((SELECT snapshot_id FROM calendar_projection_state WHERE provider='google' AND account=?), ''),
		   (SELECT last_success_at FROM calendar_projection_state WHERE provider='google' AND account=?)
		 )`,
	).run(account, now, account, result.exitCode, result.stderr, account, account);

	if (result.exitCode !== 0 && result.exitCode !== 3) {
		// Non-success, non-empty — retain last-good snapshot, mark stale
		const errMsg = result.stderr.trim().split("\n")[0] || `exit code ${result.exitCode}`;
		d.prepare(
			`UPDATE calendar_projection_state SET stale = 1, last_error = ?
			 WHERE provider = 'google' AND account = ?`,
		).run(errMsg, account);
		return { success: false, eventCount: 0, error: errMsg };
	}

	// Parse events
	let parsed: unknown;
	try {
		parsed = result.exitCode === 3 ? [] : JSON.parse(result.stdout);
	} catch {
		const errMsg = "malformed JSON from gog";
		d.prepare(
			`UPDATE calendar_projection_state SET stale = 1, last_error = ?
			 WHERE provider = 'google' AND account = ?`,
		).run(errMsg, account);
		return { success: false, eventCount: 0, error: errMsg };
	}

	const events = normalizeEvents(parsed, account, config.calendar.defaultCalendar);

	// Transactional replacement
	const insertStmt = d.prepare(
		`INSERT OR REPLACE INTO calendar_projection
		 (provider, account, calendar_id, event_id, summary, description, location,
		  start_at, end_at, start_date, end_date, all_day, status, event_type,
		  transparency, recurring_event_id, original_start, updated_at,
		  snapshot_id, projected_at, raw_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	// Use a manual transaction
	d.exec("BEGIN");
	try {
		// Delete old rows for this account within the projection horizon
		d.prepare(
			`DELETE FROM calendar_projection
			 WHERE provider = 'google' AND account = ?`,
		).run(account);

		// Insert new rows
		for (const ev of events) {
			insertStmt.run(
				"google",
				account,
				ev.calendarId,
				ev.id,
				ev.summary ?? null,
				ev.description ?? null,
				ev.location ?? null,
				ev.start.dateTime ?? null,
				ev.end.dateTime ?? null,
				ev.start.date ?? null,
				ev.end.date ?? null,
				ev.allDay ? 1 : 0,
				ev.status ?? null,
				ev.eventType ?? null,
				ev.transparency ?? null,
				ev.recurringEventId ?? null,
				ev.originalStartTime ?? null,
				ev.updatedAt ?? null,
				snapshotId,
				now,
				null, // raw_json omitted for space; available via event_raw action
			);
		}

		// Update state
		d.prepare(
			`INSERT OR REPLACE INTO calendar_projection_state
			 (provider, account, last_success_at, last_attempt_at, snapshot_id, stale, last_error)
			 VALUES ('google', ?, ?, ?, ?, 0, NULL)`,
		).run(account, now, now, snapshotId);

		d.exec("COMMIT");
	} catch (e) {
		d.exec("ROLLBACK");
		const errMsg = `transaction failed: ${e instanceof Error ? e.message : String(e)}`;
		return { success: false, eventCount: 0, error: errMsg };
	}

	lastRefreshAt = Date.now();
	return { success: true, eventCount: events.length };
}

/**
 * Refresh projection for all configured accounts.
 */
export async function refreshProjection(
	runner: GogRunner,
	config: GoogleWorkspaceConfig,
): Promise<void> {
	for (const acct of config.accounts) {
		try {
			await refreshProjectionForAccount(runner, config, acct.email);
		} catch (e) {
			// Best-effort per account
			process.stderr.write(
				`waywiser: calendar projection refresh failed for ${acct.email}: ${e instanceof Error ? e.message : String(e)}\n`,
			);
		}
	}
}

// ── Timer ───────────────────────────────────────────────────────────

export function startProjectionTimer(
	runner: GogRunner,
	config: GoogleWorkspaceConfig,
): void {
	if (projectionTimer) return; // already running
	if (!config.accounts.length) return; // no accounts

	const intervalMs = config.calendar.projection.refreshMinutes * 60_000;
	const needsRefresh = !lastRefreshAt || Date.now() - lastRefreshAt > intervalMs;

	if (needsRefresh) {
		refreshProjection(runner, config).catch((e) => {
			process.stderr.write(
				`waywiser: calendar projection refresh failed: ${e instanceof Error ? e.message : String(e)}\n`,
			);
		});
	}

	projectionTimer = setTimeout(() => {
		projectionTimer = undefined;
		startProjectionTimer(runner, config);
	}, intervalMs);
	(projectionTimer as unknown as { unref?: () => void }).unref?.();
}

export function stopProjectionTimer(): void {
	if (projectionTimer) {
		clearTimeout(projectionTimer);
		projectionTimer = undefined;
	}
}

/**
 * Get projection state for an account.
 */
export function getProjectionState(account: string): {
	lastSuccessAt: string | null;
	stale: boolean;
	lastError: string | null;
} | undefined {
	const row = db_()
		.prepare(
			`SELECT last_success_at, stale, last_error
			 FROM calendar_projection_state
			 WHERE provider = 'google' AND account = ?`,
		)
		.get(account) as { last_success_at: string | null; stale: number; last_error: string | null } | undefined;

	if (!row) return undefined;
	return {
		lastSuccessAt: row.last_success_at,
		stale: row.stale === 1,
		lastError: row.last_error,
	};
}
