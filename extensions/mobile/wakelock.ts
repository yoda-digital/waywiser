/**
 * waywiser-*mobile/wakelock — burst / always / off (spec 08 §10).
 *
 * `burst` mode is bounded: acquire → run inner promise → release in a
 * `finally`, with a hard timeout that forces release even if the inner work
 * hangs. `always` is a session-scoped acquire on load, release on
 * `session_end` (or process exit).
 *
 * termux-wake-lock is idempotent on the app side (multiple acquires do NOT
 * stack) so we don't ref-count here.
 */
import { getMobileConfig } from "./config.js";
import { isTermuxAvailable, spawnTermux } from "./termux.js";

let acquired = false;

export async function acquireWakeLock(): Promise<boolean> {
	if (!isTermuxAvailable()) return false;
	const r = await spawnTermux("termux-wake-lock", []);
	if (r.ok) acquired = true;
	return r.ok;
}

export async function releaseWakeLock(): Promise<boolean> {
	if (!isTermuxAvailable()) return false;
	const r = await spawnTermux("termux-wake-unlock", []);
	if (r.ok) acquired = false;
	return r.ok;
}

/** Run `work` under a bounded wake-lock burst. Always releases. */
export async function withBurst<T>(work: () => Promise<T>): Promise<T> {
	const cfg = getMobileConfig();
	if (cfg.wakeLock.mode !== "burst" && cfg.wakeLock.mode !== "always") {
		return work();
	}
	const alreadyHeld = acquired || cfg.wakeLock.mode === "always";
	if (!alreadyHeld) await acquireWakeLock();
	const timeout = setTimeout(() => {
		// Hard bound: if the work hangs longer than burstMaxMs, force release
		// so we don't leak a background foreground service.
		if (!alreadyHeld) void releaseWakeLock();
	}, Math.max(1_000, cfg.wakeLock.burstMaxMs ?? 30_000));
	(timeout as unknown as { unref?: () => void }).unref?.();
	try {
		return await work();
	} finally {
		clearTimeout(timeout);
		if (!alreadyHeld) await releaseWakeLock();
	}
}

export function isHeld(): boolean { return acquired; }
