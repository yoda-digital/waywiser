/**
 * waywiser-*mobile/capture — voice + share-sheet ingest.
 *
 * The mobile extension registers a `capture` intent handler that:
 *  - takes the raw text payload (from STT or the share sheet),
 *  - persists a fact into memories via rememberRow,
 *  - creates a kanban card on the configured board when the payload is
 *    long enough to look like a task,
 *  - fires a confirmation notification.
 *
 * The actual STT / share-sheet plumbing lives in bin/waywiser-capture; this
 * module is what pi runs when the resulting inbox message arrives.
 */
import { db_, rememberRow } from "../utils/state.js";
import { sendNotification } from "../notify.js";
import { getMobileConfig } from "./config.js";
import { nextCardId } from "../kanban/shared.js";

interface CaptureResult {
	memoryId?: number;
	cardId?: string;
}

const CARD_HINTS = /^(TODO|task|remind|schedule|@)/i;

export async function handleCapture(payload: string, source: "stt" | "share" | "manual" = "manual"): Promise<CaptureResult> {
	const cfg = getMobileConfig();
	const text = payload.trim();
	if (!text) return {};

	const db = db_();
	const memoryId = rememberRow(db, {
		type: "note",
		content: text,
		confidence: 0.7,
		source: "user",
		sourceSession: `mobile-capture:${source}`,
	});

	let cardId: string | undefined;
	if (text.length > 12 && (CARD_HINTS.test(text) || source === "share")) {
		try {
			cardId = nextCardId();
			db.prepare(
				"INSERT INTO cards (id, board_id, title, type, status, priority, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(cardId, cfg.capture.board, text.slice(0, 200), cfg.capture.type, "todo", "med", source === "share" ? `Captured via share sheet.` : `Captured via ${source}.`);
		} catch (e) {
			cardId = undefined;
			process.stderr.write(`waywiser/mobile: capture card create failed: ${String(e)}\n`);
		}
	}

	await sendNotification(
		"Captured",
		cardId ? `Saved as memory + kanban card ${cardId}.` : `Saved as memory (${memoryId}).`,
		["termux"],
		{ bypassQuiet: true, urgency: "low" },
	).catch(() => undefined);

	return { memoryId, cardId };
}
