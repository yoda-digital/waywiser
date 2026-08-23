/**
 * waywiser-*mobile — shared type surface for the Termux-native extension family.
 * Kept in one file so notify.ts + proactive.ts + individual sub-modules can
 * import types without pulling their runtime dependencies (fs, spawn, etc.).
 */
import type { NotifyAction, NotifyIntent } from "../notify.js";

export type { NotifyAction, NotifyIntent };

// ── config ────────────────────────────────────────────────────────────────

export interface MobileConfig {
	enabled: boolean;
	interactive: boolean;
	context: MobileContextConfig;
	wakeLock: { mode: "off" | "burst" | "always"; burstMaxMs?: number };
	jobScheduler: { enabled: boolean; periodMs: number };
	channels: {
		critical: string;
		proactive: string;
		multitask: string;
		approval: string;
	};
	biometric: { gateAskUser: boolean };
	capture: { board: string; type: string };
	actions: { defaultTTLMs: number };
	/** Absolute paths to bin/ callback wrappers, populated by /mobile setup. */
	bins?: {
		reply?: string;
		do?: string;
		approve?: string;
		capture?: string;
		tick?: string;
	};
}

export interface MobileContextConfig {
	battery: boolean;
	wifi: boolean;
	thermal: boolean;
	audio: boolean;
	network: boolean;
	ttlMs: number;
}

// ── live context snapshot ─────────────────────────────────────────────────

export interface MobileContext {
	available: boolean;
	atMs: number;
	battery?: BatteryReading;
	wifi?: WifiReading;
	network?: NetworkReading;
	audio?: AudioReading;
}

export interface BatteryReading {
	percentage: number;
	temperatureC: number;
	charging: boolean;
	status: string;
	health?: string;
	plugged?: string;
}

export interface WifiReading {
	ssid?: string;
	bssid?: string;
	frequencyMhz?: number;
	linkSpeedMbps?: number;
	rssi?: number;
}

export interface NetworkReading {
	type: "wifi" | "cellular" | "none" | "unknown";
	metered: boolean;
}

export interface AudioReading {
	headphonesConnected: boolean;
	bluetoothConnected: boolean;
}

// ── inbox ─────────────────────────────────────────────────────────────────

export interface InboxTokenFile {
	token: string;
	intent: NotifyIntent;
	issuedAtMs: number;
	expiresAtMs: number;
	/** Title/body of the notification this token was minted for — for provenance. */
	source?: { title: string; body: string };
}

export interface InboxMessage {
	token: string;
	kind: "do" | "reply" | "approve" | "deny" | "capture";
	receivedAtMs: number;
	/** Only present for reply/capture kinds — the raw user text or share payload. */
	payload?: string;
	/** Optional secondary payload (e.g. share-sheet URL vs. text). */
	extra?: Record<string, string>;
}
