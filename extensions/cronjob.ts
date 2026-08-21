/**
 * waywiser-*cronjob — scheduled agent jobs.
 *
 * Two execution modes:
 * - mode="session" (default): in-memory timer; fires while pi is running by
 *   delivering the prompt to the agent (followUp). Persists across restarts in
 *   the DB; timers re-arm on session_start for jobs whose next fire time is near.
 * - mode="system": writes to ~/.waywiser/cron/system.cron.d-style file that the
 *   user points at their real cron; the waywiser-* CLI wrapper is the entry point.
 *   (Honest scope: this node does NOT daemonize — system mode is opt-in and
 *   documented, not silent magic.)
 *
 * Quiet hours (DND): a global "HH:MM-HH:MM" window (may wrap midnight;
 * stored in ~/.waywiser/quiet.json). A fire that lands inside the window is
 * DEFERRED to the window's end with no send in between — so an overnight
 * schedule collapses to one wake when quiet ends. Session-mode only: system-
 * mode jobs run under real cron (separate process) and are not gated here.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { db_, waywiserHome, shortId, registry_, readJSON, writeJSON } from "./utils/state.js";

const MIN_MS = 60_000; // 1 minute floor — matches waywiser-* (no sub-minute jobs)

// ── quiet hours (DND) — pure core + file-backed storage ─────────────────
const quietFile = (): string => path.join(waywiserHome(), "quiet.json");

export interface QuietWindow { start: string; end: string } // "HH:MM" local time

export function getQuiet(): QuietWindow | null {
	const q = readJSON<Partial<QuietWindow> | null>(quietFile(), null);
	if (q && parseHM(q.start ?? "") && parseHM(q.end ?? "") && q.start !== q.end) return { start: q.start, end: q.end };
	return null;
}

/** "HH:MM-HH:MM" → window, "off" → null. Error string on bad input. */
export function parseQuietSetting(raw: string): { ok: true; window: QuietWindow | null } | { ok: false; err: string } {
	const t = raw.trim();
	if (t === "" || t.toLowerCase() === "off") return { ok: true, window: null };
	const m = t.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
	if (!m) return { ok: false, err: `quiet window must be "HH:MM-HH:MM" (e.g. 22:00-07:00) or "off"` };
	if (!parseHM(m[1]) || !parseHM(m[2])) return { ok: false, err: `invalid time in "${t}"` };
	if (m[1] === m[2]) return { ok: false, err: `start and end must differ ("${m[1]}")` };
	return { ok: true, window: { start: m[1], end: m[2] } };
}

export function setQuiet(window: QuietWindow | null): void {
	if (window) writeJSON(quietFile(), window);
	else try { fs.rmSync(quietFile(), { force: true }); } catch { /* absence already means "off" */ }
}

export function parseHM(v: string): { h: number; m: number } | null {
	const m = (v ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!m) return null;
	const h = Number(m[1]), mi = Number(m[2]);
	return h <= 23 && mi <= 59 ? { h, m: mi } : null;
}

/** In-window, local time. Start-inclusive, end-exclusive. Wraps midnight
 *  (22:00-07:00 is active at 23:30 AND 05:59). start==end → never. */
export function inDnd(start: string, end: string, d: Date): boolean {
	const s = parseHM(start), e = parseHM(end);
	if (!s || !e) return false;
	const sm = s.h * 60 + s.m, em = e.h * 60 + e.m;
	if (sm === em) return false;
	const x = d.getHours() * 60 + d.getMinutes();
	return sm < em ? x >= sm && x < em : x >= sm || x < em;
}

/** ms from d until the window ends, or null when d is outside the window. */
export function msUntilDndEnd(start: string, end: string, d: Date): number | null {
	if (!inDnd(start, end, d)) return null;
	const s = parseHM(start)!, e = parseHM(end)!;
	const sm = s.h * 60 + s.m, em = e.h * 60 + e.m;
	const x = d.getHours() * 60 + d.getMinutes();
	const endToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), e.h, e.m, 0, 0).getTime();
	const ms = sm < em ? endToday : x < em ? endToday : endToday + 86_400_000;
	return Math.max(0, ms - d.getTime());
}

interface CronState {
	job: {
		id: string;
		name?: string;
		schedule: string;
		prompt: string;
		mode: string;
		enabled: number;
	};
	timer?: NodeJS.Timeout;
	nextAt?: number;
	carryoverText?: string;
}

export default function cronjob(pi: ExtensionAPI): void {
	const states = new Map<string, CronState>();
	let latestCtx: ExtensionContext | undefined;

	/**
	 * Minimal cron expression parser: five fields "minute hour dom month dow",
	 * each field supporting star, plain number, ranges A-B, step wildcards, and
	 * comma lists. Sixth field (seconds) must be 0 or star only.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function parseCron(expr: string): ((d: Date) => number) {
		const parts = expr.trim().split(/\s+/);
		if (parts.length === 6) {
			const s = parts[0];
			if (s !== "0" && s !== "*") throw new Error(`second field must be 0 or * (got "${s}")`);
			parts.shift();
		}
		if (parts.length !== 5) throw new Error(`schedule must be a 5-field cron expression (m h dom mon dow), got: "${expr}"`);
		const field: Array<Set<number>> = [];
		const minRanges = [
			[0, 59], // minute
			[0, 23], // hour
			[1, 31], // day of month
			[1, 12], // month
			[0, 7], // day of week (0 and 7 = Sunday)
		];
		parts.forEach((p, i) => {
			const [lo, hi] = minRanges[i];
			const set = new Set<number>();
			for (const chunk of p.split(",")) {
				const m = chunk.match(/^\*\/(\d+)$/);
				if (m) {
					const step = Number(m[1]);
					if (!Number.isInteger(step) || step <= 0) throw new Error(`bad step in "${chunk}"`);
					for (let v = lo; v <= hi; v += step) set.add(v);
					continue;
				}
				if (chunk === "*") {
					for (let v = lo; v <= hi; v++) set.add(v);
					continue;
				}
				const range = chunk.match(/^(\d+)-(\d+)$/);
				if (range) {
					const a = Number(range[1]);
					const b = Number(range[2]);
					if (a < lo || b > hi || a > b) throw new Error(`range "${chunk}" outside ${lo}-${hi}`);
					for (let v = a; v <= b; v++) set.add(v);
					continue;
				}
				const single = chunk.match(/^\d+$/);
				if (single) {
					const v = Number(chunk);
					if (v < lo || v > hi) throw new Error(`value "${chunk}" outside ${lo}-${hi}`);
					set.add(v);
					continue;
				}
				throw new Error(`cannot parse cron field "${chunk}"`);
			}
			field.push(set);
		});
		return (d: Date): number => {
			for (let ms = d.getTime() + 60_000; ms < d.getTime() + 400 * 86_400_000; ms += 60_000) {
				const c = new Date(ms);
				const dowOk = field[4].has(c.getDay()) || (c.getDay() === 0 && field[4].has(7));
				if (field[0].has(c.getMinutes()) && field[1].has(c.getHours()) && field[2].has(c.getDate()) && field[3].has(c.getMonth() + 1) && dowOk) {
					return ms;
				}
			}
			throw new Error(`cron expression "${expr}" matches no time in 400 days (check dom/dow interaction)`);
		};
	}

	const fireJob = (id: string): void => {
		const state = states.get(id);
		if (!state) return;
		// Quiet-hours (DND) gate: a fire inside the window is deferred to the
		// window's end (one wake, not N). Prompt persists in state/DB, so the
		// deferral loses nothing. System-mode jobs don't pass through here.
		const q = state.job.mode === "session" ? getQuiet() : null;
		if (q && inDnd(q.start, q.end, new Date())) {
			const ms = msUntilDndEnd(q.start, q.end, new Date()) ?? 0;
			registry_().log("cron", `defer ${id} (${state.job.name ?? state.job.schedule}): quiet hours ${q.start}-${q.end}; firing at window end`);
			if (state.timer) clearTimeout(state.timer);
			state.timer = setTimeout(() => fireJob(id), Math.min(ms, 2 ** 31 - 1));
			(state.timer as unknown as { unref?: () => void }).unref?.();
			return;
		}
		registry_().log("cron", `fire ${id} (${state.job.name ?? state.job.schedule})`);
		let text = state.job.prompt;
		const savedCarryover = state.carryoverText;
		if (state.carryoverText) {
			text += `\n\n[waywiser-*cron carryover — state from your previous run; continue from here]\n${state.carryoverText}`;
			state.carryoverText = undefined;
		}
		const ctx = latestCtx;
		try {
			pi.sendUserMessage(`[cronjob ${id}${state.job.name ? `: ${state.job.name}` : ""}] ${text}`, {
				deliverAs: "followUp",
			});
		} catch {
			state.carryoverText = savedCarryover; // restore on delivery failure
			ctx?.ui?.notify?.(`cron job ${id} fired but agent is unavailable; carryover preserved for next fire`, "warning");
		}
		// Re-arm.
		try {
			const next = nextFire(state.job.schedule);
			if (next.d) {
				state.nextAt = next.d.getTime();
				if (state.timer) clearTimeout(state.timer);
				const delay = Math.max(0, next.d.getTime() - Date.now());
				state.timer = setTimeout(() => fireJob(id), delay);
				(state.timer as unknown as { unref?: () => void }).unref?.();
			} else {
				// One-shot (@ISO) fires EXACTLY once: disarm and persist disabled so
				// session_start cannot resurrect it. Re-arming with the same past
				// instant was an infinite 0ms fire loop (verified: ~9k fires in 105s).
				if (state.timer) clearTimeout(state.timer);
				state.timer = undefined;
				state.nextAt = next.at!;
				state.job.enabled = 0;
			}
		} catch (e) {
			process.stderr.write(`waywiser/cron: re-arm failed for ${id}: ${e instanceof Error ? e.message : String(e)}\n`);
		}
			db_().prepare("UPDATE cronjobs SET enabled = ?, last_run = datetime('now') WHERE id = ?").run(state.job.enabled ?? 1, id);
	};

	/** Returns either a concrete Date (recurring) or a one-shot epoch ms (at). */
	function nextFire(schedule: string): { d?: Date; at?: number } {
		// One-shot: "@<ISO time>"
		const at = schedule.match(/^@(.+)$/);
		if (at) {
			const t = Date.parse(at[1]);
			if (Number.isNaN(t)) throw new Error(`bad @time "${at[1]}"`);
			return { at: t };
		}
		return { d: new Date(nextFireMillis(schedule)()) };
	}
	const nextFireMillis = (expr: string): (() => number) => parseCron(expr);

	pi.on("session_start", () => {
		// Re-arm persisted jobs.
		try {
			const rows = db_().prepare("SELECT id, name, schedule, prompt, mode, enabled FROM cronjobs WHERE enabled = 1").all() as Array<
				Record<string, unknown>
			>;
			for (const row of rows) {
				const id = String(row.id);
				if (states.has(id)) continue;
				const state: CronState = {
					job: {
						id,
						name: row.name as string | undefined,
						schedule: String(row.schedule),
						prompt: String(row.prompt),
						mode: String(row.mode || "session"),
						enabled: Number(row.enabled) || 1,
					},
				};
				states.set(id, state);
				if (state.job.mode === "session") {
					try {
						const nf = nextFire(state.job.schedule);
						const when = nf.d?.getTime() ?? nf.at!;
						if (when > Date.now()) {
							// eslint-disable-next-line no-async-promise-executor
							state.timer = setTimeout(() => fireJob(id), Math.min(when - Date.now(), 2 ** 31 - 1));
						}
					} catch {
						/* past one-shot: leave it; user can remove it */
					}
				}
			}
		} catch (e) {
			process.stderr.write(`waywiser/cron: failed to restore cron jobs from DB: ${e instanceof Error ? e.message : String(e)}\n`);
		}
	});

	pi.registerTool({
		name: "cronjob",
		label: "Cron Job",
		description:
			"Schedule recurring or one-shot agent jobs. action=schedule (5-field cron expr or @ISO-time; min 1m interval; mode=session fires while pi runs, mode=system writes the system-cron file), list, remove(id), run_now(id), pause(id), resume(id). Jobs persist across pi restarts; session-mode timers re-arm on session_start. quiet / set_quiet(window) manage the quiet-hours window: fires landing inside it are deferred to the window end (session-mode only).",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("schedule"), Type.Literal("list"), Type.Literal("remove"), Type.Literal("run_now"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("quiet"), Type.Literal("set_quiet")]),
			schedule: Type.Optional(Type.String({ description: "For schedule: 'm h dom mon dow' cron or @ISO-8601 time" })),
			prompt: Type.Optional(Type.String({ description: "For schedule: the prompt the job injects" })),
			name: Type.Optional(Type.String({ description: "For schedule: friendly name" })),
			mode: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("system")])),
			id: Type.Optional(Type.String({ description: "For remove/run_now/pause/resume" })),
				window: Type.Optional(Type.String({ description: "For set_quiet: 'HH:MM-HH:MM' (may wrap midnight, e.g. 22:00-07:00) or 'off'" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, _signal, _update, ctx: ExtensionContext) {
			latestCtx = ctx;
			switch (p.action) {
				case "schedule": {
					const schedule = (p.schedule ?? "").trim();
					const prompt = (p.prompt ?? "").trim();
					if (!schedule || !prompt) return mk("schedule requires schedule + prompt", true);
					const mode = p.mode ?? "session";
					// Validate & compute next fire.
					let whenLabel: string;
					try {
						const nf = nextFire(schedule);
						whenLabel = (nf.d ?? new Date(nf.at!)).toISOString();
					} catch (e) {
						return mk(`schedule rejected: ${String(e)}`, true);
					}
					const id = shortId("cj");
					if (mode === "system") {
						const m = schedule.match(/^(\S+) (\S+) (\S+) (\S+) (\S+)$/);
						if (schedule.startsWith("@") || !m) {
							return mk("mode=system requires a 5-field cron expression (one-shot @times are session-mode only)", true);
						}
						const dir = path.join(waywiserHome(), "cron");
						fs.mkdirSync(dir, { recursive: true });
						const file = path.join(dir, `${id}.cron`);
						const cronLine = `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]} pi -p "${(p.name ? p.name + ": " : "") + prompt.replace(/"/g, '\\"')}"`;
						fs.appendFileSync(file, `${p.name ? `# ${p.name}\n` : ""}${cronLine}\n`);
						db_().prepare("INSERT INTO cronjobs (id, name, schedule, prompt, mode) VALUES (?,?,?,?,?)").run(id, p.name ?? null, schedule, prompt, mode);
						return mk(`Scheduled (mode=system) job ${id}: "${p.name ?? id}" at ${whenLabel}\nCron entry written to ${file}.\nNOTE: this file must be referenced by real system cron (e.g. via crontab include or a service). It is opt-in, not auto-activated.`);
					}
					// session mode
					db_().prepare("INSERT INTO cronjobs (id, name, schedule, prompt, mode) VALUES (?,?,?,?,?)").run(id, p.name ?? null, schedule, prompt, mode);
					const state: CronState = { job: { id, name: p.name, schedule, prompt, mode, enabled: 1 } };
					states.set(id, state);
					try {
						const nf = nextFire(schedule);
						const when = nf.d?.getTime() ?? nf.at!;
						if (when <= Date.now()) return mk(`schedule "${schedule}" next fire is in the past; nothing scheduled.`, true);
						// eslint-disable-next-line no-async-promise-executor
						state.timer = setTimeout(() => fireJob(id), Math.min(when - Date.now(), 2 ** 31 - 1));
					} catch (e) {
						return mk(`schedule rejected: ${String(e)}`, true);
					}
					if (state.timer) {
						(state.timer as unknown as { unref?: () => void }).unref?.();
					}
					registry_().log("cron", `schedule ${id} "${p.name ?? id}" @ ${whenLabel}`);
					return mk(`Scheduled session job ${id}: "${p.name ?? id}" — next fire ${whenLabel}. Fires while pi is running; the prompt is injected as a follow-up.`);
				}
				case "list": {
					const rows = db_().prepare("SELECT id, name, schedule, prompt, mode, enabled, last_run FROM cronjobs ORDER BY id").all() as Array<
						Record<string, unknown>
					>;
					if (!rows.length) return mk("No cron jobs.");
					return mk(
						rows
							.map((r) => `[${r.id}] ${r.enabled ? "on " : "off "} (${r.mode}) "${r.name ?? ""}": ${r.schedule} — ${String(r.prompt).slice(0, 60)}${r.last_run ? ` (last: ${r.last_run})` : ""}`)
							.join("\n"),
					);
				}
				case "remove": {
					const st = states.get(p.id ?? "");
					if (st?.timer) clearTimeout(st.timer);
					states.delete(p.id ?? "");
					const r = db_().prepare("DELETE FROM cronjobs WHERE id = ?").run(p.id ?? "");
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					return (r.changes as any) ? mk(`Removed cron job ${p.id}.`) : mk(`no cron job ${p.id}`, true);
				}
				case "quiet": {
					const q = getQuiet();
					return mk(q ? `quiet hours: ${q.start}-${q.end} (session-mode fires inside are deferred to ${q.end})` : "quiet hours: off (all fires deliver immediately)");
				}
				case "set_quiet": {
					const r = parseQuietSetting(p.window ?? "");
					if (!r.ok) return mk(`set_quiet: ${r.err}`, true);
					setQuiet(r.window);
					return mk(r.window ? `quiet hours set: ${r.window.start}-${r.window.end} (session-mode only; system-cron jobs are NOT gated)` : "quiet hours cleared — all session-mode fires deliver immediately.");
				}
				case "run_now": {
					const st = states.get(p.id ?? "");
					if (!st) return mk(`no cron job ${p.id}`, true);
					fireJob(p.id!);
					return mk(`Cron job ${p.id} fired now.`);
				}
				case "pause": {
					const st = states.get(p.id ?? "");
					if (!st) return mk(`no cron job ${p.id}`, true);
					if (st.timer) clearTimeout(st.timer);
					db_().prepare("UPDATE cronjobs SET enabled = 0 WHERE id = ?").run(p.id!);
					st.job.enabled = 0;
					return mk(`Paused cron job ${p.id}.`);
				}
				case "resume": {
					const st = states.get(p.id ?? "");
					if (!st) return mk(`no cron job ${p.id}`, true);
					db_().prepare("UPDATE cronjobs SET enabled = 1 WHERE id = ?").run(p.id!);
					st.job.enabled = 1;
					try {
						const nf = nextFire(st.job.schedule);
						const when = nf.d?.getTime() ?? nf.at!;
						if (when > Date.now()) {
							// eslint-disable-next-line no-async-promise-executor
							st.timer = setTimeout(() => fireJob(p.id!), Math.min(when - Date.now(), 2 ** 31 - 1));
						}
					} catch {
						/* past one-shot */
					}
					return mk(`Resumed cron job ${p.id}.`);
				}
			}
		},
	});

	pi.registerCommand("cron", {
		description: "List cron jobs and manage quiet hours (waywiser-*). /cron quiet | /cron quiet HH:MM-HH:MM | /cron quiet off",
		handler: async (args, ctx) => {
			const q = (win: QuietWindow | null): void =>
				ctx.ui.notify(win ? `quiet hours: ${win.start}-${win.end} (session-mode fires are deferred to window end)` : "quiet hours: off", "info");
			const a = args.trim();
			if (a.toLowerCase().startsWith("quiet")) {
				const arg = a.split(/\s+/).slice(1).join(" ");
				if (arg) {
					const r = parseQuietSetting(arg);
					if (!r.ok) {
						ctx.ui.notify(`quiet: ${r.err}`, "error");
						q(getQuiet());
						return;
					}
					setQuiet(r.window);
				}
				q(getQuiet());
				return;
			}
			const rows = db_().prepare("SELECT id, name, schedule, mode, enabled FROM cronjobs").all() as Array<Record<string, unknown>>;
			ctx.ui.notify(rows.length ? rows.map((r) => `[${r.id}] ${r.enabled ? "on" : "off"} (${r.mode}) ${r.name ?? ""}: ${r.schedule}`).join("\n") : "No cron jobs.", "info");
			q(getQuiet());
		},
	});
}

function mk(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}
