/**
 * Write idempotency — operation journal and Google-compatible event IDs.
 *
 * Blueprint §20: idempotency is a correctness requirement, not optional.
 *
 * Google Calendar permits client-supplied Event IDs for create operations
 * to prevent duplicate creation in failure-after-commit scenarios.
 *
 * Event ID constraints (Google Calendar API):
 * - Characters: base32hex lowercase (a-v, 0-9)
 * - Length: 5-1024 characters
 * - Unique per calendar
 *
 * We generate a UUID-derived ID converted to the compatible alphabet.
 */
import { randomBytes, createHash } from "node:crypto";
import { db_ } from "../../../../extensions/utils/state.js";

// base32hex alphabet (RFC 4648 §7): 0-9, a-v
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** Convert arbitrary bytes to base32hex string. */
function toBase32Hex(buf: Buffer): string {
	let result = "";
	let bits = 0;
	let value = 0;
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			result += BASE32HEX[(value >>> bits) & 0x1f];
		}
	}
	if (bits > 0) {
		result += BASE32HEX[(value << (5 - bits)) & 0x1f];
	}
	return result;
}

/**
 * Generate a Google Calendar-compatible event ID.
 * Uses 16 random bytes → 26 base32hex characters (well within 5-1024 range).
 */
export function generateEventId(): string {
	return toBase32Hex(randomBytes(16));
}

/**
 * Hash a payload for dedup detection. Two create operations with the same
 * payload hash targeting the same calendar should be considered duplicates.
 */
export function hashPayload(payload: Record<string, unknown>): string {
	const stable = JSON.stringify(payload, Object.keys(payload).sort());
	return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

// ── Operation journal ───────────────────────────────────────────────

export type OperationState = "pending" | "success" | "failed" | "ambiguous";

export interface OperationRecord {
	operation_id: string;
	action: string;
	account: string;
	calendar_id: string;
	event_id: string | null;
	payload_hash: string;
	state: OperationState;
	result_event_id: string | null;
	ambiguous_success: boolean;
	created_at: string;
}

/** Create the operation journal table if it doesn't exist. */
export function initIdempotencyTable(): void {
	db_().exec(`
		CREATE TABLE IF NOT EXISTS calendar_operations (
			operation_id    TEXT PRIMARY KEY,
			action          TEXT NOT NULL,
			account         TEXT NOT NULL,
			calendar_id     TEXT NOT NULL,
			event_id        TEXT,
			payload_hash    TEXT NOT NULL,
			state           TEXT NOT NULL DEFAULT 'pending',
			result_event_id TEXT,
			ambiguous_success INTEGER NOT NULL DEFAULT 0,
			created_at      TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
}

/**
 * Check whether a semantically equivalent operation was already attempted.
 * Matches on (account, calendar_id, payload_hash, action) for creates.
 */
export function findExistingOperation(
	action: string,
	account: string,
	calendarId: string,
	payloadHash: string,
): OperationRecord | undefined {
	const row = db_()
		.prepare(
			`SELECT * FROM calendar_operations
			 WHERE action = ? AND account = ? AND calendar_id = ? AND payload_hash = ?
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.get(action, account, calendarId, payloadHash) as OperationRecord | undefined;
	return row;
}

/**
 * Record an operation attempt in the journal.
 */
export function logOperation(record: {
	operationId: string;
	action: string;
	account: string;
	calendarId: string;
	eventId: string | null;
	payloadHash: string;
	state: OperationState;
	resultEventId?: string | null;
	ambiguousSuccess?: boolean;
}): void {
	db_()
		.prepare(
			`INSERT INTO calendar_operations
			 (operation_id, action, account, calendar_id, event_id, payload_hash, state, result_event_id, ambiguous_success)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			record.operationId,
			record.action,
			record.account,
			record.calendarId,
			record.eventId,
			record.payloadHash,
			record.state,
			record.resultEventId ?? null,
			record.ambiguousSuccess ? 1 : 0,
		);
}

/**
 * Update an operation's state after execution completes.
 */
export function updateOperationState(
	operationId: string,
	state: OperationState,
	resultEventId?: string | null,
	ambiguousSuccess?: boolean,
): void {
	db_()
		.prepare(
			`UPDATE calendar_operations
			 SET state = ?, result_event_id = ?, ambiguous_success = ?
			 WHERE operation_id = ?`,
		)
		.run(state, resultEventId ?? null, ambiguousSuccess ? 1 : 0, operationId);
}
