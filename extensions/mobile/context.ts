/**
 * waywiser-*mobile/context — cached mobile-context sensor (spec 08 §5).
 *
 * Reads battery / wifi / audio / network state via termux-* helpers, in
 * parallel, with a hard per-probe timeout. Results are cached with a TTL
 * (default 60s) so the OODA loop and discretion filters never trigger a
 * probe burst on every tick.
 *
 * Every getter is opt-in via mobile.json. When Termux:API is unavailable
 * (desktop, CI, missing app), readMobileContext() returns a stable
 * `{available:false}` snapshot — callers should treat this as "no signal",
 * not as an error.
 */
import { getMobileConfig } from "./config.js";
import { isTermuxAvailable, spawnTermuxJson } from "./termux.js";
import type {
	AudioReading,
	BatteryReading,
	MobileContext,
	NetworkReading,
	WifiReading,
} from "./types.js";

let cached: { at: number; value: MobileContext } | undefined;

/** For tests: drop the cache. */
export function clearMobileContextCache(): void {
	cached = undefined;
}

/** For tests: inject a fake cached snapshot so downstream modules that read
 *  `lastMobileContext()` see it. Not exported from the extension entry — used
 *  by test/mobile/signals.test.ts only. */
export function __setMobileContextForTests(value: MobileContext | null): void {
	cached = value ? { at: Date.now(), value } : undefined;
}

interface RawBattery {
	percentage?: number;
	temperature?: number;
	status?: string;
	plugged?: string;
	health?: string;
}

interface RawWifi {
	ssid?: string;
	bssid?: string;
	frequency_mhz?: number;
	link_speed_mbps?: number;
	rssi?: number;
	supplicant_state?: string;
}

interface RawAudio {
	AUDIOFOCUS?: string;
	MICROPHONE?: string;
	SOUNDPOOL?: string;
	AUDIOCABLE?: string;
	// Termux JSON keys vary by device; we defensively spread + regex the raw JSON below.
	[k: string]: unknown;
}

/**
 * Pure — parse battery JSON into our normalized shape. Public for tests.
 * Termux emits { percentage, temperature (°C), status ("CHARGING"|...), plugged, health }.
 */
export function parseBattery(raw: RawBattery | null): BatteryReading | undefined {
	if (!raw || typeof raw.percentage !== "number") return undefined;
	const status = String(raw.status ?? "");
	return {
		percentage: raw.percentage,
		temperatureC: typeof raw.temperature === "number" ? raw.temperature : Number.NaN,
		// Anchor the match — "DISCHARGING" contains "CHARGING" as a substring.
		charging: /^(CHARGING|FULL)$/i.test(status) || (raw.plugged !== undefined && raw.plugged !== "UNPLUGGED"),
		status,
		health: raw.health,
		plugged: raw.plugged,
	};
}

/** Pure — normalize a termux-wifi-connectioninfo JSON blob. */
export function parseWifi(raw: RawWifi | null): WifiReading | undefined {
	if (!raw) return undefined;
	// SSID comes back as `<unknown ssid>` when location permission is missing
	// (Android's own gate). Treat that as "unknown" so heuristics don't lock
	// onto a bogus stable value.
	const ssid = typeof raw.ssid === "string" && !/unknown/i.test(raw.ssid) ? raw.ssid.replace(/^"|"$/g, "") : undefined;
	return {
		ssid,
		bssid: typeof raw.bssid === "string" && raw.bssid !== "02:00:00:00:00:00" ? raw.bssid : undefined,
		frequencyMhz: typeof raw.frequency_mhz === "number" ? raw.frequency_mhz : undefined,
		linkSpeedMbps: typeof raw.link_speed_mbps === "number" ? raw.link_speed_mbps : undefined,
		rssi: typeof raw.rssi === "number" ? raw.rssi : undefined,
	};
}

/** Rough network summary — Termux doesn't expose a single "type" field, so
 *  we infer from wifi presence + telephony cellinfo if we have it. */
export function inferNetwork(wifi: WifiReading | undefined): NetworkReading {
	if (wifi?.ssid || wifi?.bssid) return { type: "wifi", metered: false };
	// termux-telephony-cellinfo returns [] when disabled/airplane; treat
	// missing wifi as cellular only if we know we have a signal. To keep
	// this cheap (no extra probe), default to "unknown".
	return { type: "unknown", metered: true };
}

export function parseAudio(raw: RawAudio | null): AudioReading | undefined {
	if (!raw) return undefined;
	// Termux emits several fields depending on the OS version. We match by
	// regex to stay robust: any key mentioning HEADSET/HEADPHONES + value
	// "on"/"true" → connected; same for BT.
	const flatten = JSON.stringify(raw).toLowerCase();
	return {
		headphonesConnected: /"[^"]*(headset|headphone)[^"]*"\s*:\s*"?(on|true|connected)/i.test(flatten),
		bluetoothConnected: /"[^"]*(bluetooth|bt)[^"]*"\s*:\s*"?(on|true|connected)/i.test(flatten),
	};
}

/**
 * Read the current mobile context. Cached to `ttlMs` — subsequent calls
 * within the window return the memoized snapshot without spawning anything.
 */
export async function readMobileContext(now = Date.now()): Promise<MobileContext> {
	const cfg = getMobileConfig();
	if (cached && now - cached.at < cfg.context.ttlMs) return cached.value;

	if (!isTermuxAvailable()) {
		const value: MobileContext = { available: false, atMs: now };
		cached = { at: now, value };
		return value;
	}

	const jobs: Promise<void>[] = [];
	const snapshot: MobileContext = { available: true, atMs: now };

	if (cfg.context.battery || cfg.context.thermal) {
		jobs.push(
			spawnTermuxJson<RawBattery>("termux-battery-status", []).then((raw) => {
				snapshot.battery = parseBattery(raw);
			}),
		);
	}
	if (cfg.context.wifi) {
		jobs.push(
			spawnTermuxJson<RawWifi>("termux-wifi-connectioninfo", []).then((raw) => {
				snapshot.wifi = parseWifi(raw);
			}),
		);
	}
	if (cfg.context.audio) {
		jobs.push(
			spawnTermuxJson<RawAudio>("termux-audio-info", []).then((raw) => {
				snapshot.audio = parseAudio(raw);
			}),
		);
	}

	await Promise.allSettled(jobs);
	if (cfg.context.network) snapshot.network = inferNetwork(snapshot.wifi);

	cached = { at: now, value: snapshot };
	return snapshot;
}

/** Synchronous accessor — returns the last cached snapshot without probing.
 *  Used by hot paths (proactive post-filter) that must be fast. */
export function lastMobileContext(): MobileContext | null {
	return cached?.value ?? null;
}
