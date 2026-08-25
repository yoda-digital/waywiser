/**
 * waywiser-*notify — notification bus.
 *
 * Delivers messages via desktop (`notify-send` on Linux, `osascript` on
 * macOS), a Telegram bot, or a webhook. Respects quiet hours from
 * ~/.waywiser/quiet.json (same "HH:MM-HH:MM" format cronjob's DND window
 * uses) and an in-memory per-hour rate limit. Exposes sendNotification() on
 * the shared registry so other extensions (cron, kanban, delegate) can push
 * notifications without importing this module directly.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { waywiserHome, readJSON, writeJSON, registry_ } from "./utils/state.js";
import { fmtStamp, fmtAge } from "./utils/time.js";

interface NotifyChannelDesktop {
	enabled: boolean;
}
interface NotifyChannelTelegram {
	enabled: boolean;
	token?: string;
	chatId?: string;
}
interface NotifyChannelWebhook {
	enabled: boolean;
	url?: string;
	headers?: Record<string, string>;
}
interface NotifyChannelTermux {
	enabled: boolean;
	appTitle?: string;
	id?: number;
	/** Maps urgency to physical signal strength (--priority/--sound/--vibrate/--icon/--channel/TTS). */
	escalate?: boolean;
	soundOnCritical?: boolean;
	vibratePattern?: string;
	criticalChannel?: string;
	ttsOnCritical?: boolean;
	/** Route by urgency to a distinct Android notification channel (created by mobile.channels.ts). */
	channelByUrgency?: { critical?: string; high?: string; normal?: string; low?: string };
	/** When true, wrap every notification with a "reply" Direct-Reply button (spec 08 §4). */
	interactive?: boolean;
	/** Absolute path to the `waywiser-reply` binary (populated by /mobile setup). */
	replyBin?: string;
	/** Absolute path to the `waywiser-do` binary. */
	doBin?: string;
}

/**
 * A per-notification action button. `label` shows on the button; `intent`
 * describes what should happen when it's tapped. The mobile extension issues
 * a one-shot inbox token and passes it to the fixed-shape shell command that
 * Android runs — user data is never interpolated into the action string.
 * `directReply` turns the button into an Android Direct-Reply input.
 */
export interface NotifyAction {
	label: string;
	intent: NotifyIntent;
	directReply?: boolean;
}

export type NotifyIntent =
	| { kind: "prompt"; prompt: string; label?: string }
	| { kind: "snooze"; minutes: number; original: { title: string; body: string } }
	| { kind: "dismiss" }
	| { kind: "approve"; requestId: string; requiresBiometric?: boolean }
	| { kind: "deny"; requestId: string }
	| { kind: "reply"; prompt: string }
	| { kind: "custom"; handler: string; payload?: Record<string, unknown> };

/**
 * Optional callback for a notification target. The mobile extension registers
 * its Termux argv builder here; when absent, notifications remain plain
 * (backward-compatible with prior notify.ts consumers). All action strings
 * returned by the builder are treated as opaque shell fragments — spec 08
 * §12 requires they contain only shell-safe tokens issued by the caller.
 */
export interface TermuxActionBuilder {
	buildArgs(actions: NotifyAction[], defaultTTLMs: number): string[];
	buildOnDelete?(intent?: NotifyIntent): string | undefined;
}

let termuxActionBuilder: TermuxActionBuilder | undefined;

export function registerTermuxActionBuilder(b: TermuxActionBuilder | undefined): void {
	termuxActionBuilder = b;
}
interface NotifyConfig {
	channels: {
		desktop?: NotifyChannelDesktop;
		telegram?: NotifyChannelTelegram;
		webhook?: NotifyChannelWebhook;
		termux?: NotifyChannelTermux;
	};
	default: string[];
	rateLimit?: number;
}

const DEFAULT_RATE_LIMIT = 10;
const DEFAULT_CONFIG: NotifyConfig = {
	channels: { desktop: { enabled: true } },
	default: ["desktop"],
	rateLimit: DEFAULT_RATE_LIMIT,
};

interface QuietWindow {
	start: string;
	end: string;
}

function notifyConfigFile(): string {
	return path.join(waywiserHome(), "notify.json");
}

function readNotifyConfig(): NotifyConfig {
	return readJSON<NotifyConfig>(notifyConfigFile(), DEFAULT_CONFIG);
}

function parseHM(v: string): { h: number; m: number } | null {
	const m = (v ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!m) return null;
	const h = Number(m[1]);
	const mi = Number(m[2]);
	return h <= 23 && mi <= 59 ? { h, m: mi } : null;
}

/** Same window semantics as cronjob's inDnd(): start-inclusive, end-exclusive, wraps midnight. */
function isInQuietHours(): boolean {
	const quiet = readJSON<Partial<QuietWindow> | null>(path.join(waywiserHome(), "quiet.json"), null);
	if (!quiet) return false;
	const s = parseHM(quiet.start ?? "");
	const e = parseHM(quiet.end ?? "");
	if (!s || !e) return false;
	const sm = s.h * 60 + s.m;
	const em = e.h * 60 + e.m;
	if (sm === em) return false;
	const now = new Date();
	const x = now.getHours() * 60 + now.getMinutes();
	return sm < em ? x >= sm && x < em : x >= sm || x < em;
}

// In-memory rate limiting: per-process counter, resets on restart. Honest
// scope — this is a single long-lived pi process's send history, not a
// durable cross-restart ledger.
const sendLog: number[] = [];

function pruneSendLog(): void {
	const hourAgo = Date.now() - 3_600_000;
	while (sendLog.length && sendLog[0] < hourAgo) sendLog.shift();
}

function isRateLimited(limit: number): boolean {
	pruneSendLog();
	return sendLog.length >= limit;
}

function sendsThisHour(): number {
	pruneSendLog();
	return sendLog.length;
}

async function sendDesktop(
	title: string,
	body: string,
): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve) => {
		let child;
		if (os.platform() === "darwin") {
			const script =
				`display notification ${JSON.stringify(body)} ` +
				`with title ${JSON.stringify(title)}`;
			child = spawn("osascript", ["-e", script], { stdio: "ignore" });
		} else {
			child = spawn("notify-send", [title, body], { stdio: "ignore" });
		}
		child.on("error", (err) => {
			resolve({ ok: false, error: err.message });
		});
		child.on("close", (code) => {
			resolve(
				code === 0
					? { ok: true }
					: { ok: false, error: `exit code ${code}` },
			);
		});
	});
}

/** Escape for Telegram's legacy Markdown parse_mode (not MarkdownV2). */
function escapeMarkdown(s: string): string {
	return s.replace(/([*_`[])/g, "\\$1");
}

async function sendTelegram(token: string, chatId: string, title: string, body: string): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId,
				text: `*${escapeMarkdown(title)}*\n_${fmtStamp(Date.now())}_\n${escapeMarkdown(body)}`,
				parse_mode: "Markdown",
			}),
		});
		if (res.ok) return { ok: true };
		const errBody = await res.text().catch(() => "");
		return { ok: false, error: `HTTP ${res.status}: ${errBody.slice(0, 200)}` };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Termux:API — system notification (requires the Termux:API app enabled).
 * When escalate is on (default), urgency maps to real physical signal:
 * critical -> priority max + sound + vibrate pattern + error icon + optional TTS,
 * normal/high -> priority high; low -> priority low. Stable per-urgency ids
 * keep the notification shade from accumulating duplicates.
 *
 * When `actions` are provided AND a TermuxActionBuilder is registered (mobile
 * extension), the notification becomes interactive: button-actions run fixed-
 * shape shell commands that redeem one-shot inbox tokens. Spec 08 §4/§12.
 */
async function sendTermux(
	title: string,
	body: string,
	urgency: string,
	appTitle?: string,
	cfg?: NotifyChannelTermux,
	actions?: NotifyAction[],
	actionTTLMs?: number,
): Promise<{ ok: boolean; error?: string }> {
	const escalate = cfg?.escalate !== false;
	const args = ["--title", appTitle && appTitle.trim() ? appTitle : title, "--content", body];
	const id = cfg?.id !== undefined ? String(cfg.id) : `way-${urgency}`;
	if (cfg?.id === undefined || escalate) args.push("--id", id);
	if (escalate) {
		if (urgency === "critical") {
			args.push("--priority", "max", "--icon", "error");
			if (cfg?.soundOnCritical !== false) args.push("--sound");
			if (cfg?.vibratePattern) args.push("--vibrate", cfg.vibratePattern);
			else args.push("--vibrate", "300,150,300,150,600");
		} else if (urgency === "low") {
			args.push("--priority", "low");
		} else {
			args.push("--priority", "high", "--icon", "important_suggestions");
		}
		if (urgency === "critical" && cfg?.ttsOnCritical !== false) {
			const tts = spawn("termux-tts-speak", [title], { stdio: "ignore" });
			tts.on("error", () => undefined); // no engine/no-op: fine
		}
	}
	// Channel routing (spec 08 §11): urgency-specific channel first, legacy
	// criticalChannel fallback for backwards compatibility.
	const chan = cfg?.channelByUrgency?.[urgency as keyof NonNullable<NotifyChannelTermux["channelByUrgency"]>];
	if (chan) args.push("--channel", chan);
	else if (urgency === "critical" && cfg?.criticalChannel) args.push("--channel", cfg.criticalChannel);

	// Interactive layer (spec 08 §4). When the mobile extension has registered
	// its builder AND actions are provided (or interactive=true), append
	// --button*-action / --action / --on-delete flags. When no builder is
	// registered, actions are silently ignored — desktop/CI keep working.
	if (termuxActionBuilder) {
		const effectiveActions = actions ?? [];
		if (effectiveActions.length || cfg?.interactive) {
			try {
				const extraArgs = termuxActionBuilder.buildArgs(effectiveActions, actionTTLMs ?? 3_600_000);
				args.push(...extraArgs);
			} catch (e) {
				// Never let action wiring block the notification itself.
				process.stderr.write(`waywiser/notify: action builder failed: ${String(e)}\n`);
			}
		}
	}

	return new Promise((resolve) => {
		const child = spawn("termux-notification", args, { stdio: "ignore" });
		child.on("error", (err) => resolve({ ok: false, error: err.message }));
		child.on("close", (code) =>
			resolve(code === 0 ? { ok: true } : { ok: false, error: `exit code ${code}` }),
		);
	});
}

export function buildWebhookPayload(title: string, body: string, level: string, nowMs: number = Date.now()): Record<string, unknown> {
	const iso = new Date(nowMs).toISOString();
	return {
		title,
		body,
		level,
		iso,
		timestamp: iso,
		source: "waywiser",
		human: fmtStamp(nowMs),
		age: fmtAge(nowMs),
	};
}

async function sendWebhook(url: string, headers: Record<string, string> | undefined, title: string, body: string, level: string = "normal"): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(headers ?? {}) },
			body: JSON.stringify(buildWebhookPayload(title, body, level)),
		});
		if (res.ok) return { ok: true };
		return { ok: false, error: `HTTP ${res.status}` };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export interface NotifyResult {
	sent: string[];
	failed: string[];
}

/**
 * Deliver a notification via the given channels (or the configured
 * defaults). Silently suppressed during quiet hours unless bypassQuiet is
 * set. Every attempt (successful or not) is logged to the journey table.
 */
export async function sendNotification(
	title: string,
	body: string,
	channels?: string[],
	opts?: {
		bypassQuiet?: boolean;
		urgency?: string;
		/** Interactive buttons — honored only by channels that support them (termux for now). */
		actions?: NotifyAction[];
		/** Override the default 1h token TTL for this notification's actions. */
		actionTTLMs?: number;
	},
): Promise<NotifyResult> {
	const config = readNotifyConfig();

	if (!opts?.bypassQuiet && isInQuietHours()) return { sent: [], failed: [] };
	const limit = config.rateLimit ?? DEFAULT_RATE_LIMIT;
	if (isRateLimited(limit)) return { sent: [], failed: [`rate-limited (${limit}/hour reached — wait or increase rateLimit in ~/.waywiser/notify.json)`] };

	const targets = channels && channels.length ? channels : (config.default?.length ? config.default : DEFAULT_CONFIG.default);
	const sent: string[] = [];
	const failed: string[] = [];

	for (const ch of targets) {
		let result: { ok: boolean; error?: string } = { ok: false };
		if (ch === "desktop" && config.channels.desktop?.enabled) {
			result = await sendDesktop(title, body);
		} else if (ch === "telegram" && config.channels.telegram?.enabled && config.channels.telegram.token && config.channels.telegram.chatId) {
			result = await sendTelegram(config.channels.telegram.token, config.channels.telegram.chatId, title, body);
		} else if (ch === "webhook" && config.channels.webhook?.enabled && config.channels.webhook.url) {
			result = await sendWebhook(config.channels.webhook.url, config.channels.webhook.headers, title, body, String(opts?.urgency ?? "normal"));
		} else if (ch === "termux" && config.channels.termux?.enabled) {
			result = await sendTermux(
				title,
				body,
				String(opts?.urgency ?? "normal"),
				config.channels.termux.appTitle,
				config.channels.termux,
				opts?.actions,
				opts?.actionTTLMs,
			);
		} else {
			failed.push(`${ch} (not configured/enabled)`);
			continue;
		}
		if (result.ok) sent.push(ch);
		else failed.push(result.error ? `${ch}: ${result.error}` : ch);
	}

	if (sent.length) sendLog.push(Date.now());
	registry_().log("notify", `[${sent.join(",") || "none"}] ${title}: ${body.slice(0, 100)}`);

	return { sent, failed };
}

export default function notify(pi: ExtensionAPI): void {
	// Cross-extension use (cron/kanban/delegate can call this without an
	// import cycle). Not part of WaywiserRegistry's declared shape, hence the cast.
	(registry_() as unknown as { notify: typeof sendNotification }).notify = sendNotification;

	pi.registerTool({
		name: "notify",
		label: "Notify",
		description:
			"Send a notification to the user via configured channels (desktop, Telegram, webhook, termux). Use this to deliver reminders, alerts, or results that need attention. Respects quiet hours (DND) unless urgency=critical.",
		parameters: Type.Object({
			title: Type.String({ description: "Short notification title" }),
			body: Type.String({ description: "Notification body text" }),
			channels: Type.Optional(
				Type.Array(Type.String(), {
					description: "Specific channel names to use: 'desktop', 'telegram', 'webhook', 'termux' (default: configured defaults)",
				}),
			),
			urgency: Type.Optional(
				Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("critical")], {
					description: "Urgency level — 'critical' bypasses quiet hours",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const result = await sendNotification(params.title, params.body, params.channels, {
				bypassQuiet: params.urgency === "critical",
				urgency: params.urgency ?? "normal",
			});
			if (!result.sent.length && !result.failed.length) {
				return {
					content: [{ type: "text" as const, text: "Notification suppressed (quiet hours active). Use urgency: critical to override." }],
					details: {},
				};
			}
			if (!result.sent.length) {
				return {
					content: [{ type: "text" as const, text: `Failed to deliver via: ${result.failed.join(", ")}. Check /notify setup.` }],
					details: {},
					isError: true,
				};
			}
			const text = `Notification sent via: ${result.sent.join(", ")}${result.failed.length ? ` (failed: ${result.failed.join(", ")})` : ""}`;
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});

	pi.registerCommand("notify", {
		description: "Manage notifications: /notify test | /notify setup | /notify status",
		handler: async (args: string, ctx: ExtensionContext) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";

			if (sub === "test") {
				const r = await sendNotification("Waywiser Test", "If you see this, notifications work.", undefined, { bypassQuiet: true });
				ctx.ui.notify(`Test: sent=${r.sent.join(",") || "none"} failed=${r.failed.join(",") || "none"}`, r.sent.length ? "info" : "warning");
				return;
			}

			if (sub === "setup") {
				if (!ctx.hasUI) {
					ctx.ui.notify("Interactive setup needs dialog-capable UI (TUI/RPC). Edit ~/.waywiser/notify.json directly instead (see config/notify.example.json).", "warning");
					return;
				}
				const config = readNotifyConfig();

				const wantDesktop = await ctx.ui.confirm("Notify setup", "Enable desktop notifications (notify-send / osascript)?");
				config.channels.desktop = { enabled: wantDesktop };

				const wantTelegram = await ctx.ui.confirm("Notify setup", "Enable a Telegram bot channel?");
				if (wantTelegram) {
					const token = await ctx.ui.input("Telegram bot token", "123456:ABC-DEF...");
					const chatId = await ctx.ui.input("Telegram chat id", "e.g. 123456789");
					config.channels.telegram = { enabled: Boolean(token && chatId), token: token ?? "", chatId: chatId ?? "" };
				} else {
					config.channels.telegram = { ...(config.channels.telegram ?? {}), enabled: false };
				}

				const wantWebhook = await ctx.ui.confirm("Notify setup", "Enable a webhook channel?");
				if (wantWebhook) {
					const url = await ctx.ui.input("Webhook URL", "https://example.com/webhook");
					config.channels.webhook = { enabled: Boolean(url), url: url ?? "", headers: config.channels.webhook?.headers ?? {} };
				} else {
					config.channels.webhook = { ...(config.channels.webhook ?? {}), enabled: false };
				}

				const wantTermux = await ctx.ui.confirm("Notify setup", "Enable the Termux:API channel (system notifications via termux-notification)?");
				if (wantTermux) {
					const appTitle = await ctx.ui.input("Notification header (short, shown in status bar)", "Waywiser");
					config.channels.termux = { enabled: true, appTitle: (appTitle ?? "").trim() || "Waywiser" };
				} else {
					config.channels.termux = { ...(config.channels.termux ?? {}), enabled: false };
				}

				const defaults: string[] = [];
				if (config.channels.desktop?.enabled) defaults.push("desktop");
				if (config.channels.telegram?.enabled) defaults.push("telegram");
				if (config.channels.webhook?.enabled) defaults.push("webhook");
				if (config.channels.termux?.enabled) defaults.push("termux");
				config.default = defaults.length ? defaults : ["desktop"];

				writeJSON(notifyConfigFile(), config);
				ctx.ui.notify(`Notify config saved to ${notifyConfigFile()}. Defaults: ${config.default.join(", ")}. Try /notify test.`, "info");
				return;
			}

			// status (default, including unknown subcommands)
			const config = readNotifyConfig();
			ctx.ui.notify(
				[
					`Channels: ${JSON.stringify(config.channels, null, 2)}`,
					`Default: ${(config.default ?? []).join(", ") || "desktop"}`,
					`Rate limit: ${config.rateLimit ?? DEFAULT_RATE_LIMIT}/hour`,
					`Sends this hour: ${sendsThisHour()}`,
				].join("\n"),
				"info",
			);
		},
	});
}
