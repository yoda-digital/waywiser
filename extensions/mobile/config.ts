/**
 * waywiser-*mobile config — ~/.waywiser/mobile.json read/write with defaults.
 * Same layered-defaults pattern as proactive.ts's getProactiveConfig.
 */
import * as path from "node:path";
import { readJSON, writeJSON, waywiserHome } from "../utils/state.js";
import type { MobileConfig } from "./types.js";

const DEFAULT_MOBILE_CONFIG: MobileConfig = {
	enabled: true,
	interactive: true,
	context: {
		battery: true,
		wifi: true,
		thermal: true,
		audio: true,
		network: true,
		ttlMs: 60_000,
	},
	wakeLock: { mode: "off", burstMaxMs: 30_000 },
	jobScheduler: { enabled: false, periodMs: 900_000 },
	channels: {
		critical: "waywiser-critical",
		proactive: "waywiser-proactive",
		multitask: "waywiser-multitask",
		approval: "waywiser-approval",
	},
	biometric: { gateAskUser: false },
	capture: { board: "default", type: "task" },
	actions: { defaultTTLMs: 3_600_000 },
};

export function mobileConfigFile(): string {
	return path.join(waywiserHome(), "mobile.json");
}

/** Deep-merged read — missing keys fall through to defaults. Safe on missing/malformed file. */
export function getMobileConfig(): MobileConfig {
	const raw = readJSON<Partial<MobileConfig>>(mobileConfigFile(), {});
	return {
		...DEFAULT_MOBILE_CONFIG,
		...raw,
		context: { ...DEFAULT_MOBILE_CONFIG.context, ...(raw.context ?? {}) },
		wakeLock: { ...DEFAULT_MOBILE_CONFIG.wakeLock, ...(raw.wakeLock ?? {}) },
		jobScheduler: { ...DEFAULT_MOBILE_CONFIG.jobScheduler, ...(raw.jobScheduler ?? {}) },
		channels: { ...DEFAULT_MOBILE_CONFIG.channels, ...(raw.channels ?? {}) },
		biometric: { ...DEFAULT_MOBILE_CONFIG.biometric, ...(raw.biometric ?? {}) },
		capture: { ...DEFAULT_MOBILE_CONFIG.capture, ...(raw.capture ?? {}) },
		actions: { ...DEFAULT_MOBILE_CONFIG.actions, ...(raw.actions ?? {}) },
		bins: { ...(DEFAULT_MOBILE_CONFIG.bins ?? {}), ...(raw.bins ?? {}) },
	};
}

export function setMobileConfig(patch: Partial<MobileConfig>): MobileConfig {
	const current = getMobileConfig();
	const next = { ...current, ...patch };
	// Preserve nested objects that patch didn't touch.
	if (patch.context) next.context = { ...current.context, ...patch.context };
	if (patch.wakeLock) next.wakeLock = { ...current.wakeLock, ...patch.wakeLock };
	if (patch.jobScheduler) next.jobScheduler = { ...current.jobScheduler, ...patch.jobScheduler };
	if (patch.channels) next.channels = { ...current.channels, ...patch.channels };
	if (patch.biometric) next.biometric = { ...current.biometric, ...patch.biometric };
	if (patch.capture) next.capture = { ...current.capture, ...patch.capture };
	if (patch.actions) next.actions = { ...current.actions, ...patch.actions };
	if (patch.bins) next.bins = { ...(current.bins ?? {}), ...patch.bins };
	writeJSON(mobileConfigFile(), next);
	return next;
}
