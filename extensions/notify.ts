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
interface NotifyConfig {
	channels: {
		desktop?: NotifyChannelDesktop;
		telegram?: NotifyChannelTelegram;
		webhook?: NotifyChannelWebhook;
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
				text: `*${escapeMarkdown(title)}*\n${escapeMarkdown(body)}`,
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

async function sendWebhook(url: string, headers: Record<string, string> | undefined, title: string, body: string): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(headers ?? {}) },
			body: JSON.stringify({ title, body, timestamp: new Date().toISOString(), source: "waywiser" }),
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
	opts?: { bypassQuiet?: boolean },
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
			result = await sendWebhook(config.channels.webhook.url, config.channels.webhook.headers, title, body);
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
			"Send a notification to the user via configured channels (desktop, Telegram, webhook). Use this to deliver reminders, alerts, or results that need attention. Respects quiet hours (DND) unless urgency=critical.",
		parameters: Type.Object({
			title: Type.String({ description: "Short notification title" }),
			body: Type.String({ description: "Notification body text" }),
			channels: Type.Optional(
				Type.Array(Type.String(), {
					description: "Specific channel names to use: 'desktop', 'telegram', 'webhook' (default: configured defaults)",
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

				const defaults: string[] = [];
				if (config.channels.desktop?.enabled) defaults.push("desktop");
				if (config.channels.telegram?.enabled) defaults.push("telegram");
				if (config.channels.webhook?.enabled) defaults.push("webhook");
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
