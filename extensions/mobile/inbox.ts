/**
 * waywiser-*mobile/inbox — one-shot token store + filesystem message queue
 * (spec 08 §4). Lives entirely in ~/.waywiser/mobile/:
 *
 *   tokens/<tok>.json   — intent metadata written when a notification is
 *                          minted; consumed exactly once by the callback
 *   msgs/<seq>.json     — messages appended by bin/waywiser-{do,reply,approve,capture};
 *                          picked up by the running pi process's watcher
 *
 * The watcher polls (fs.watch has known reliability issues on Android SAF)
 * every 1s while the process is alive, drains msgs/ into handlers, and
 * unlinks each file post-processing. On Waywiser start we also drain any
 * messages received while the process was down (Doze-safe: the phone can
 * fire a callback that queues into msgs/ even if pi is asleep — pi picks
 * it up when it wakes).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { waywiserHome } from "../utils/state.js";
import type { InboxMessage, InboxTokenFile, NotifyIntent } from "./types.js";

// ── paths ────────────────────────────────────────────────────────────────

export function inboxRoot(): string {
	return path.join(waywiserHome(), "mobile");
}
export function tokensDir(): string { return path.join(inboxRoot(), "tokens"); }
export function msgsDir(): string { return path.join(inboxRoot(), "msgs"); }

function ensureDirs(): void {
	fs.mkdirSync(tokensDir(), { recursive: true });
	fs.mkdirSync(msgsDir(), { recursive: true });
}

// ── token issue/redeem ───────────────────────────────────────────────────

/** Mint a token and persist its intent to tokens/<tok>.json. */
export function issueToken(intent: NotifyIntent, ttlMs: number, source?: { title: string; body: string }): string {
	ensureDirs();
	const token = randomBytes(16).toString("hex");
	const record: InboxTokenFile = {
		token,
		intent,
		issuedAtMs: Date.now(),
		expiresAtMs: Date.now() + Math.max(60_000, ttlMs),
		source,
	};
	writeAtomic(path.join(tokensDir(), `${token}.json`), JSON.stringify(record));
	return token;
}

/** Consume a token — returns the intent and deletes the file. Returns null
 *  when the token is missing, malformed, or expired. */
export function redeemToken(token: string): InboxTokenFile | null {
	const file = path.join(tokensDir(), `${token}.json`);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	let parsed: InboxTokenFile;
	try {
		parsed = JSON.parse(raw) as InboxTokenFile;
	} catch {
		try { fs.unlinkSync(file); } catch { /* ignore */ }
		return null;
	}
	// One-shot: delete BEFORE returning so a double-firing callback is idempotent.
	try { fs.unlinkSync(file); } catch { /* ignore */ }
	if (parsed.expiresAtMs && Date.now() > parsed.expiresAtMs) return null;
	return parsed;
}

/** Sweep expired tokens (best-effort housekeeping). */
export function sweepExpiredTokens(now = Date.now()): number {
	ensureDirs();
	let removed = 0;
	for (const entry of fs.readdirSync(tokensDir())) {
		if (!entry.endsWith(".json")) continue;
		const p = path.join(tokensDir(), entry);
		try {
			const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as InboxTokenFile;
			if (parsed.expiresAtMs && now > parsed.expiresAtMs) {
				fs.unlinkSync(p);
				removed++;
			}
		} catch {
			try { fs.unlinkSync(p); removed++; } catch { /* ignore */ }
		}
	}
	return removed;
}

// ── message queue (written by callback binaries) ─────────────────────────

/** Append an inbox message. Used by bin/waywiser-{do,reply,approve,capture}. */
export function enqueueMessage(msg: Omit<InboxMessage, "receivedAtMs">): string {
	ensureDirs();
	const full: InboxMessage = { ...msg, receivedAtMs: Date.now() };
	// Monotonic-ish filename: ts + short random suffix — avoids collision when
	// two callbacks arrive in the same millisecond.
	const name = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.json`;
	writeAtomic(path.join(msgsDir(), name), JSON.stringify(full));
	return name;
}

/** Drain the message queue — returns all pending messages, ordered by receivedAtMs. */
export function drainMessages(): InboxMessage[] {
	ensureDirs();
	const out: Array<{ name: string; msg: InboxMessage }> = [];
	for (const entry of fs.readdirSync(msgsDir())) {
		if (!entry.endsWith(".json")) continue;
		const p = path.join(msgsDir(), entry);
		try {
			const msg = JSON.parse(fs.readFileSync(p, "utf-8")) as InboxMessage;
			out.push({ name: entry, msg });
		} catch {
			try { fs.unlinkSync(p); } catch { /* ignore */ }
		}
	}
	out.sort((a, b) => a.msg.receivedAtMs - b.msg.receivedAtMs);
	for (const { name } of out) {
		try { fs.unlinkSync(path.join(msgsDir(), name)); } catch { /* ignore */ }
	}
	return out.map((o) => o.msg);
}

// ── atomic write helper ──────────────────────────────────────────────────

function writeAtomic(file: string, data: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}
