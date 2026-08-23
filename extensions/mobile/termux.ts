/**
 * waywiser-*mobile/termux — safe wrapper around Termux:API CLI helpers.
 *
 * All spawns use argv arrays (never a shell string). Availability is
 * probed once and cached — repeated failures on non-Termux hosts don't
 * spam the log. `spawnTermuxJson` waits for stdout and parses JSON with
 * a hard 3s timeout so a wedged helper cannot block the OODA tick.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PROBE_BINARIES = ["termux-battery-status"] as const;
const DEFAULT_TIMEOUT_MS = 3_000;

let availabilityCache: boolean | undefined;

/** True when Termux:API helpers are usable. Cached — probes once per process. */
export function isTermuxAvailable(): boolean {
	if (availabilityCache !== undefined) return availabilityCache;
	// PATH inspection first (fast, no fork). Fall back to a stat check on the
	// standard Termux prefix so we work when the invoker's PATH is minimal.
	const paths = (process.env.PATH ?? "").split(":");
	const prefixBin = process.env.PREFIX ? path.join(process.env.PREFIX, "bin") : "/data/data/com.termux/files/usr/bin";
	const searchIn = [...new Set([...paths, prefixBin])];
	for (const bin of PROBE_BINARIES) {
		for (const dir of searchIn) {
			try {
				const p = path.join(dir, bin);
				if (fs.existsSync(p)) {
					availabilityCache = true;
					return true;
				}
			} catch { /* ignore */ }
		}
	}
	availabilityCache = false;
	return false;
}

/** For tests: reset the availability cache. */
export function resetTermuxAvailability(): void {
	availabilityCache = undefined;
}

export interface TermuxSpawnOptions {
	timeoutMs?: number;
	/** Optional stdin string. Used by e.g. `termux-notification --content -`. */
	stdin?: string;
}

/** Spawn a termux-* binary, resolving with the stdout string on exit 0. */
export function spawnTermux(bin: string, args: string[], opts?: TermuxSpawnOptions): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			try { child.kill("SIGTERM"); } catch { /* ignore */ }
			resolve({ ok: false, stdout, stderr, error: `timeout after ${opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` });
		}, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		(timeout as unknown as { unref?: () => void }).unref?.();
		child.stdout?.on("data", (d) => { stdout += d.toString(); });
		child.stderr?.on("data", (d) => { stderr += d.toString(); });
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({ ok: false, stdout, stderr, error: err.message });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({ ok: code === 0, stdout, stderr, error: code === 0 ? undefined : `exit ${code}` });
		});
		if (opts?.stdin !== undefined) {
			try { child.stdin?.end(opts.stdin); } catch { /* ignore — child may have died */ }
		}
	});
}

/** Convenience: spawn + JSON.parse stdout. Returns null on any failure. */
export async function spawnTermuxJson<T>(bin: string, args: string[], opts?: TermuxSpawnOptions): Promise<T | null> {
	if (!isTermuxAvailable()) return null;
	const r = await spawnTermux(bin, args, opts);
	if (!r.ok || !r.stdout.trim()) return null;
	try {
		return JSON.parse(r.stdout) as T;
	} catch {
		return null;
	}
}
