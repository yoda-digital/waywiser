/**
 * waywiser tui-stamps — prefixes user + assistant markdown with a
 * dim [HH:MM] stamp via pi.registerMarkdownTransformer. Streaming-safe:
 * caches the stamp per message so it doesn't jitter as tokens arrive.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fmtStamp } from "./utils/time.js";
import { readJSON } from "./utils/state.js";

const DEFAULT_CAP = 64;
const KEY_PREFIX_LEN = 40;

export function _stampKey(messageType: string, md: string): string {
	return `${messageType}|${md.slice(0, KEY_PREFIX_LEN)}`;
}

export function _makeStampCache(cap: number = DEFAULT_CAP) {
	// Insertion-order Map used as LRU: delete-then-set on hit refreshes recency.
	const m = new Map<string, number>();
	return {
		get(key: string, nowMs: number): number {
			const existing = m.get(key);
			if (existing !== undefined) {
				m.delete(key);
				m.set(key, existing);
				return existing;
			}
			m.set(key, nowMs);
			while (m.size > cap) {
				const oldest = m.keys().next().value;
				if (oldest === undefined) break;
				m.delete(oldest);
			}
			return nowMs;
		},
		evictPrefix(prefix: string): void {
			for (const k of Array.from(m.keys())) {
				if (k.startsWith(prefix)) m.delete(k);
			}
		},
		clear(): void {
			m.clear();
		},
		size(): number {
			return m.size;
		},
	};
}

export function _renderStampPrefix(nowMs: number, style: "code" | "plain"): string {
	const stamp = fmtStamp(nowMs);
	return style === "code" ? `\`[${stamp}]\` ` : `[${stamp}] `;
}

function configFile(): string {
	const home = process.env.WAYWISER_HOME || path.join(process.env.HOME || ".", ".waywiser");
	return path.join(home, "config.json");
}

export function _loadConfig(): { enabled: boolean; style: "code" | "plain" } {
	try {
		const cfg = readJSON<{ tuiStamps?: { enabled?: unknown; style?: unknown } }>(configFile(), {});
		const enabled = cfg.tuiStamps?.enabled === false ? false : true;
		const rawStyle = cfg.tuiStamps?.style;
		const style: "code" | "plain" = rawStyle === "plain" ? "plain" : "code";
		return { enabled, style };
	} catch {
		return { enabled: true, style: "code" };
	}
}

// Extension factory (wired in Task 3).
export default function tuiStamps(pi: ExtensionAPI): void {
	const cache = _makeStampCache();
	let cfg = _loadConfig();

	pi.on("session_start", () => {
		cache.clear();
		cfg = _loadConfig();
	});

	pi.on("before_agent_start", () => {
		cfg = _loadConfig();
	});

	pi.on("message_end", (event) => {
		const msg = (event as unknown as { message?: { content?: unknown } }).message;
		const content = typeof msg?.content === "string" ? msg.content : "";
		if (!content) return;
		for (const t of ["user", "assistant"]) {
			cache.evictPrefix(_stampKey(t, content));
		}
	});

	pi.registerMarkdownTransformer((md, mtCtx) => {
		try {
			if (!cfg.enabled) return md;
			if (mtCtx.messageType === "assistant-thinking") return md;
			if (mtCtx.messageType !== "user" && mtCtx.messageType !== "assistant") return md;
			const key = _stampKey(mtCtx.messageType, md);
			const stamp = cache.get(key, Date.now());
			return `${_renderStampPrefix(stamp, cfg.style)}${md}`;
		} catch (err) {
			process.stderr.write(`waywiser: tui-stamps transformer error: ${err instanceof Error ? err.message : String(err)}\n`);
			return md;
		}
	});
}
