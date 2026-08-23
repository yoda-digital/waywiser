/**
 * waywiser-*mobile — Termux-native integration entry (spec 08).
 *
 * Wires the mobile sub-modules into pi's extension surface:
 *  - registers a signal provider + a post-filter with proactive.ts
 *  - registers the interactive-notification action builder with notify.ts
 *  - drains the filesystem inbox on session_start (Doze-safe replay of any
 *    callbacks that fired while pi was asleep) and polls every 1s while
 *    the process is alive
 *  - keeps the mobile-context cache warm at the configured TTL
 *  - exposes `/mobile` for setup / status / test / install-shortcuts
 *
 * All behavior is gated on Termux:API availability — on desktop/CI the
 * extension registers but stays a no-op.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registry_, waywiserHome } from "../utils/state.js";
import { registerSignalProvider, registerPostFilter } from "../proactive.js";
import { registerTermuxActionBuilder, sendNotification, type NotifyAction } from "../notify.js";
import { getMobileConfig, setMobileConfig } from "./config.js";
import { isTermuxAvailable } from "./termux.js";
import { readMobileContext, lastMobileContext, clearMobileContextCache } from "./context.js";
import { drainMessages, sweepExpiredTokens } from "./inbox.js";
import { makeActionBuilder } from "./actions.js";
import { provisionChannels } from "./channels.js";
import { registerJob, cancelJob, listJobs } from "./jobscheduler.js";
import { withBurst, acquireWakeLock, releaseWakeLock } from "./wakelock.js";
import { mobileSignals, mobileDiscretion } from "./signals.js";
import { handleCapture } from "./capture.js";
import type { InboxMessage } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");

function findBin(name: string): string {
	// Prefer the shipped bin dir; fall back to PATH lookup.
	const shipped = path.join(packageRoot, "bin", name);
	if (fs.existsSync(shipped)) return shipped;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		try {
			const p = path.join(dir, name);
			if (fs.existsSync(p)) return p;
		} catch { /* ignore */ }
	}
	return shipped; // stable, even if it doesn't exist yet (bin/ ships in the package)
}

export default function mobile(pi: ExtensionAPI): void {
	const cfg = getMobileConfig();
	if (!cfg.enabled) {
		registry_().log("mobile", "disabled in mobile.json");
		return;
	}

	// ── bind action builder into notify.ts ──────────────────────────────
	const bins = {
		do: cfg.bins?.do ?? findBin("waywiser-do"),
		reply: cfg.bins?.reply ?? findBin("waywiser-reply"),
		approve: cfg.bins?.approve ?? findBin("waywiser-approve"),
	};
	try {
		if (cfg.interactive) registerTermuxActionBuilder(makeActionBuilder(bins));
	} catch (e) {
		process.stderr.write(`waywiser/mobile: action builder disabled — ${String(e)}\n`);
	}

	// ── proactive integration ───────────────────────────────────────────
	registerSignalProvider(() => mobileSignals());
	registerPostFilter((signals) => mobileDiscretion(signals));

	// ── context refresher ───────────────────────────────────────────────
	let ctxTimer: NodeJS.Timeout | undefined;
	const armContextRefresh = (): void => {
		if (ctxTimer) clearTimeout(ctxTimer);
		if (!isTermuxAvailable()) return;
		ctxTimer = setTimeout(() => {
			void readMobileContext().catch(() => undefined).then(armContextRefresh);
		}, Math.max(10_000, cfg.context.ttlMs));
		(ctxTimer as unknown as { unref?: () => void }).unref?.();
	};

	// ── inbox message router ────────────────────────────────────────────
	async function processMessage(msg: InboxMessage, ctx: ExtensionContext | undefined): Promise<void> {
		registry_().log("mobile", `inbox ${msg.kind} token=${msg.token.slice(0, 8)}…`);
		// Token was already redeemed by the callback binary — the intent is
		// encoded in the message itself (see bin/waywiser-*). We re-hydrate.
		if (!msg.token || typeof msg.token !== "string") return;

		try {
			switch (msg.kind) {
				case "reply": {
					const text = msg.payload ?? "";
					if (!text.trim()) break;
					pi.sendUserMessage(`[reply] ${text}`, { deliverAs: "followUp" });
					break;
				}
				case "do": {
					// Payload carries the intent JSON serialized by waywiser-do.
					const intent = msg.extra?.intent ? safeJsonParse(msg.extra.intent) : null;
					if (intent && typeof intent === "object" && "kind" in intent) {
						await dispatchIntent(pi, intent as { kind: string; [k: string]: unknown });
					}
					break;
				}
				case "approve":
				case "deny": {
					// Permission engine hook — best effort. If no listener is
					// registered, log and drop.
					const reg = registry_() as unknown as { permissionCallback?: (req: string, ok: boolean) => void };
					if (typeof reg.permissionCallback === "function") {
						reg.permissionCallback(msg.extra?.requestId ?? msg.token, msg.kind === "approve");
					} else {
						registry_().log("mobile", `no permissionCallback registered — ${msg.kind} for ${msg.extra?.requestId ?? msg.token} discarded`);
					}
					break;
				}
				case "capture": {
					const source = (msg.extra?.source as "stt" | "share" | "manual") ?? "manual";
					await handleCapture(msg.payload ?? "", source);
					break;
				}
			}
		} catch (e) {
			registry_().log("mobile", `inbox processing failed: ${String(e)}`);
		}
		void ctx; // reserved for future UI feedback
	}

	async function dispatchIntent(pi: ExtensionAPI, intent: { kind: string; [k: string]: unknown }): Promise<void> {
		switch (intent.kind) {
			case "prompt":
				if (typeof intent.prompt === "string") pi.sendUserMessage(String(intent.prompt), { deliverAs: "followUp" });
				return;
			case "snooze": {
				const minutes = Number(intent.minutes ?? 60);
				const orig = intent.original as { title?: string; body?: string } | undefined;
				setTimeout(() => {
					void sendNotification(orig?.title ?? "Snoozed", orig?.body ?? "Reminder", ["termux"], { urgency: "normal" });
				}, Math.max(60_000, minutes * 60_000)).unref?.();
				return;
			}
			case "dismiss":
				return;
			default:
				return;
		}
	}

	let drainTimer: NodeJS.Timeout | undefined;
	const armDrain = (ctx?: ExtensionContext): void => {
		if (drainTimer) clearTimeout(drainTimer);
		drainTimer = setTimeout(async () => {
			try {
				const msgs = drainMessages();
				for (const m of msgs) await processMessage(m, ctx);
				// Housekeeping: sweep expired tokens roughly every 10 drains.
				if (Math.random() < 0.1) sweepExpiredTokens();
			} catch (e) {
				registry_().log("mobile", `drain failed: ${String(e)}`);
			}
			armDrain(ctx);
		}, 1_000);
		(drainTimer as unknown as { unref?: () => void }).unref?.();
	};

	// ── lifecycle ───────────────────────────────────────────────────────
	pi.on("session_start", (_e, ctx) => {
		// Drain anything that arrived while the process was down (Doze wake, etc.).
		const initial = drainMessages();
		for (const m of initial) void processMessage(m, ctx);
		if (cfg.wakeLock.mode === "always") void acquireWakeLock();
		void provisionChannels().catch(() => undefined);
		armDrain(ctx);
		armContextRefresh();
	});

	// Prefer pi's session_shutdown for orderly cleanup; keep process-level
	// hooks as a fallback for hard exits (SIGKILL from Android low-mem killer
	// isn't catchable — in that case Termux:API releases the wake-lock when
	// its own service is unbound).
	const cleanup = (): void => {
		if (drainTimer) { clearTimeout(drainTimer); drainTimer = undefined; }
		if (ctxTimer) { clearTimeout(ctxTimer); ctxTimer = undefined; }
		if (cfg.wakeLock.mode === "always") void releaseWakeLock();
	};
	pi.on("session_shutdown", cleanup);
	process.once("exit", cleanup);
	process.once("SIGINT", cleanup);
	process.once("SIGTERM", cleanup);

	// ── /mobile command ─────────────────────────────────────────────────
	pi.registerCommand("mobile", {
		description: "Mobile (Termux): /mobile status | setup | test | tick | install-shortcuts | context | wake on|off",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() ?? "";

			if (sub === "status" || sub === "") {
				const c = getMobileConfig();
				const mctx = lastMobileContext();
				const lines = [
					`Termux:API available: ${isTermuxAvailable() ? "yes" : "no"}`,
					`Interactive notifications: ${c.interactive ? "on" : "off"}`,
					`Wake-lock mode: ${c.wakeLock.mode}`,
					`Job-scheduler: ${c.jobScheduler.enabled ? `on (period ${Math.round(c.jobScheduler.periodMs / 60_000)}m)` : "off"}`,
					`Biometric gating: ${c.biometric.gateAskUser ? "on" : "off"}`,
					`Channels: ${Object.values(c.channels).join(", ")}`,
					`Last context: ${mctx?.available ? `battery ${mctx.battery?.percentage ?? "?"}% @ ${mctx.battery?.temperatureC?.toFixed?.(1) ?? "?"}°C, wifi ${mctx.wifi?.ssid ?? "-"}` : "unavailable"}`,
					`Bins: do=${bins.do}, reply=${bins.reply}, approve=${bins.approve}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "setup") {
				await runSetup(ctx);
				return;
			}

			if (sub === "test") {
				const kind = parts[1] ?? "buttons";
				await runTest(kind);
				ctx.ui.notify(`Test '${kind}' fired via termux-notification (if available).`, "info");
				return;
			}

			if (sub === "context") {
				clearMobileContextCache();
				const snap = await readMobileContext();
				ctx.ui.notify(JSON.stringify(snap, null, 2), "info");
				return;
			}

			if (sub === "tick") {
				const bin = findBin("waywiser-tick");
				if (!fs.existsSync(bin)) {
					ctx.ui.notify(`bin/waywiser-tick not found at ${bin}. Run /mobile setup first.`, "warning");
					return;
				}
				const { spawn } = await import("node:child_process");
				const child = spawn(bin, ["--once"], { stdio: "ignore", detached: true });
				child.unref();
				ctx.ui.notify(`Standalone tick launched (pid ${child.pid}).`, "info");
				return;
			}

			if (sub === "install-shortcuts") {
				const r = await installShortcuts();
				ctx.ui.notify(r.summary, r.ok ? "info" : "warning");
				return;
			}

			if (sub === "wake") {
				const mode = parts[1] ?? "";
				if (mode === "on") {
					const ok = await acquireWakeLock();
					ctx.ui.notify(ok ? "Wake-lock acquired." : "Failed to acquire wake-lock.", ok ? "info" : "warning");
				} else if (mode === "off") {
					const ok = await releaseWakeLock();
					ctx.ui.notify(ok ? "Wake-lock released." : "Failed to release wake-lock.", ok ? "info" : "warning");
				} else {
					ctx.ui.notify("Usage: /mobile wake on|off", "info");
				}
				return;
			}

			ctx.ui.notify("Usage: /mobile [status|setup|test|tick|install-shortcuts|context|wake on|off]", "info");
		},
	});

	pi.registerTool({
		name: "mobile_context",
		label: "Mobile context",
		description:
			"Read the current mobile-device context (battery, wifi, thermal). Returns { available, battery: {percentage, temperatureC, charging}, wifi: {ssid,rssi}, network }. Use before deciding to run heavy work.",
		parameters: Type.Object({
			fresh: Type.Optional(Type.Boolean({ description: "Bypass the TTL cache and re-probe now (default false)." })),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			if (params.fresh) clearMobileContextCache();
			const snap = await readMobileContext();
			return { content: [{ type: "text" as const, text: JSON.stringify(snap, null, 2) }], details: snap as unknown as Record<string, unknown> };
		},
	});

	pi.registerTool({
		name: "mobile_burst",
		label: "Mobile: burst wake-lock",
		description: "Run a short block of work under a bounded wake-lock. Acquires termux-wake-lock, sleeps briefly to hold, then releases. Use before triggering background delegation on battery.",
		parameters: Type.Object({
			holdMs: Type.Number({ description: "Milliseconds to hold the wake-lock (1000–30000). Capped by mobile.wakeLock.burstMaxMs.", minimum: 1_000, maximum: 30_000 }),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			await withBurst(async () => {
				await new Promise((r) => setTimeout(r, params.holdMs));
			});
			return { content: [{ type: "text" as const, text: `Held wake-lock for ${params.holdMs}ms.` }], details: {} };
		},
	});
}

// ── /mobile setup helpers ─────────────────────────────────────────────────

async function runSetup(ctx: ExtensionContext): Promise<void> {
	const cfg = getMobileConfig();
	const bins = {
		do: findBin("waywiser-do"),
		reply: findBin("waywiser-reply"),
		approve: findBin("waywiser-approve"),
		capture: findBin("waywiser-capture"),
		tick: findBin("waywiser-tick"),
	};
	setMobileConfig({ bins });
	const chanRes = await provisionChannels().catch((e) => ({ created: [], skipped: [String(e)] }));
	let jobMsg = "job-scheduler not enabled — set jobScheduler.enabled=true in mobile.json to enable Doze-safe fallback.";
	if (cfg.jobScheduler.enabled) {
		const r = await registerJob(bins.tick);
		jobMsg = r.ok ? `job-scheduler registered (tick every ${Math.round(cfg.jobScheduler.periodMs / 60_000)}m).` : `job-scheduler registration failed: ${r.error}`;
	}
	ctx.ui.notify(
		[
			`Mobile setup complete.`,
			`Bin paths recorded: ${Object.entries(bins).map(([k, v]) => `${k}=${v}`).join(", ")}`,
			`Channels: created=${chanRes.created.join(",") || "none"}, skipped=${chanRes.skipped.join(",") || "none"}`,
			jobMsg,
			`Next: '/mobile install-shortcuts' to copy widget scripts into ~/.shortcuts.`,
		].join("\n"),
		"info",
	);
}

async function runTest(kind: string): Promise<void> {
	if (kind === "buttons") {
		const actions: NotifyAction[] = [
			{ label: "Done", intent: { kind: "prompt", prompt: "Marked done from notification." } },
			{ label: "Snooze 1h", intent: { kind: "snooze", minutes: 60, original: { title: "Waywiser test", body: "Snoozed test" } } },
			{ label: "Reply", intent: { kind: "reply", prompt: "test reply" }, directReply: true },
		];
		await sendNotification("Waywiser test", "Tap a button.", ["termux"], { bypassQuiet: true, urgency: "normal", actions }).catch(() => undefined);
		return;
	}
	if (kind === "critical") {
		await sendNotification("Waywiser critical test", "This is a critical-channel test.", ["termux"], { bypassQuiet: true, urgency: "critical" }).catch(() => undefined);
		return;
	}
	await sendNotification("Waywiser test", `unknown test kind '${kind}'`, ["termux"], { bypassQuiet: true, urgency: "normal" }).catch(() => undefined);
}

async function installShortcuts(): Promise<{ ok: boolean; summary: string }> {
	const src = path.join(packageRoot, "config", "shortcuts");
	const dst = path.join(os.homedir(), ".shortcuts");
	try { fs.mkdirSync(dst, { recursive: true }); } catch { /* ignore */ }
	const copied: string[] = [];
	const skipped: string[] = [];
	if (!fs.existsSync(src)) return { ok: false, summary: `no shortcuts dir at ${src}` };
	for (const entry of fs.readdirSync(src)) {
		const s = path.join(src, entry);
		const d = path.join(dst, entry);
		if (fs.existsSync(d)) { skipped.push(entry); continue; }
		try {
			fs.copyFileSync(s, d);
			try { fs.chmodSync(d, 0o755); } catch { /* ignore */ }
			copied.push(entry);
		} catch (e) {
			skipped.push(`${entry} (${String(e)})`);
		}
	}
	return { ok: true, summary: `Shortcuts installed to ${dst}: copied=${copied.join(",") || "none"}; skipped=${skipped.join(",") || "none"}. Tap the Termux:Widget on your homescreen to pick them.` };
}

function safeJsonParse(s: string): unknown {
	try { return JSON.parse(s); } catch { return null; }
}
