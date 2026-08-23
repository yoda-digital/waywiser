/**
 * waywiser-*mobile/channels — provision Android notification channels
 * (spec 08 §11). Channels are Android 8+ constructs; users can then adjust
 * sound, vibration, importance, and DND behavior per channel from system
 * Settings — a much better UX than one-size-fits-all.
 *
 * Channel creation is idempotent (re-creating with the same id updates the
 * name only). We do it once per process (session-level cache) and never
 * block the extension load path on failure — a missing Termux:API or a
 * pre-Oreo device just means no channels, which the notification call
 * silently accepts.
 */
import { getMobileConfig } from "./config.js";
import { isTermuxAvailable, spawnTermux } from "./termux.js";

let provisioned = false;

/** For tests. */
export function resetChannelsProvisioning(): void { provisioned = false; }

const HUMAN_NAMES: Record<string, string> = {
	critical: "Waywiser • Critical",
	proactive: "Waywiser • Proactive",
	multitask: "Waywiser • Background work",
	approval: "Waywiser • Approvals",
};

export async function provisionChannels(): Promise<{ created: string[]; skipped: string[] }> {
	const cfg = getMobileConfig();
	if (provisioned) return { created: [], skipped: Object.values(cfg.channels) };
	if (!isTermuxAvailable()) {
		provisioned = true; // don't retry every call on non-Termux hosts
		return { created: [], skipped: Object.values(cfg.channels) };
	}

	const created: string[] = [];
	const skipped: string[] = [];
	for (const [key, id] of Object.entries(cfg.channels)) {
		const name = HUMAN_NAMES[key] ?? `Waywiser • ${key}`;
		const r = await spawnTermux("termux-notification-channel", [id, name]);
		if (r.ok) created.push(id);
		else skipped.push(`${id} (${r.error ?? "unknown"})`);
	}
	provisioned = true;
	return { created, skipped };
}
