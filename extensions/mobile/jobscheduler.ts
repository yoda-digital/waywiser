/**
 * waywiser-*mobile/jobscheduler — register the Doze-safe fallback tick
 * (spec 08 §7). Uses Android's JobScheduler via termux-job-scheduler, so
 * the wake survives Doze and Adaptive Battery. Minimum period is 15 min
 * (Android N constraint).
 *
 * The scheduled script (bin/waywiser-tick) runs standalone — no pi, no
 * LLM. It reads waywiser.db, computes P0 signals, and fires notifications
 * for any that haven't been alerted in the last hour. When the live pi
 * process is running, the same signals will also be surfaced through the
 * regular OODA tick; the standalone script self-dedupes on the same
 * alerts file so the user never sees duplicates.
 */
import { getMobileConfig } from "./config.js";
import { isTermuxAvailable, spawnTermux } from "./termux.js";

const DEFAULT_JOB_ID = 8291; // arbitrary stable ID for the waywiser tick job

export async function registerJob(binPath: string, jobId = DEFAULT_JOB_ID): Promise<{ ok: boolean; error?: string }> {
	if (!isTermuxAvailable()) return { ok: false, error: "termux-api not available" };
	const cfg = getMobileConfig();
	if (!cfg.jobScheduler.enabled) return { ok: false, error: "jobScheduler disabled in mobile.json" };
	const period = Math.max(900_000, cfg.jobScheduler.periodMs);
	const r = await spawnTermux("termux-job-scheduler", [
		"--script", binPath,
		"--job-id", String(jobId),
		"--period-ms", String(period),
		"--persisted", "true",
		"--battery-not-low", "true",
	]);
	return { ok: r.ok, error: r.error };
}

export async function cancelJob(jobId = DEFAULT_JOB_ID): Promise<boolean> {
	if (!isTermuxAvailable()) return false;
	const r = await spawnTermux("termux-job-scheduler", ["--cancel", String(jobId)]);
	return r.ok;
}

export async function listJobs(): Promise<string> {
	if (!isTermuxAvailable()) return "";
	const r = await spawnTermux("termux-job-scheduler", ["--pending"]);
	return r.stdout;
}
