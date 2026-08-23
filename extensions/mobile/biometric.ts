/**
 * waywiser-*mobile/biometric — thin wrapper around termux-fingerprint.
 *
 * Direct callers use `verify()` for a synchronous check inside pi. Most
 * biometric gating happens INSIDE the notification action string (see
 * actions.ts) — this module exists for cases where the permission engine
 * or an extension wants to gate a purely-in-process action.
 *
 * Failure of any kind (no sensor, cancelled, timeout, missing helper) is
 * reported as `false`. Callers must treat a false result as an explicit
 * deny, never as "unknown".
 */
import { isTermuxAvailable, spawnTermuxJson } from "./termux.js";

interface FingerprintResult {
	auth_result?: string; // "AUTH_RESULT_SUCCESS" | "AUTH_RESULT_FAILURE" | ...
	failed_attempts?: number;
	errors?: string[];
}

export async function verify(title = "Waywiser approval", timeoutMs = 15_000): Promise<boolean> {
	if (!isTermuxAvailable()) return false;
	const raw = await spawnTermuxJson<FingerprintResult>("termux-fingerprint", ["-t", title], { timeoutMs });
	if (!raw) return false;
	return raw.auth_result === "AUTH_RESULT_SUCCESS";
}
