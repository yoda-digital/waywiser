/**
 * Google Calendar extension — plugin entry point.
 *
 * Loaded by Pi via bin/waywiser plugin discovery:
 *   plugins/google-workspace/extensions/calendar/index.ts
 *
 * Responsibilities:
 * - Register the risk classifier for the "calendar" tool
 * - Initialize SQLite tables (projection + idempotency)
 * - Register the semantic calendar tool
 * - Start the projection refresh timer when agent is idle
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolRiskClassifier } from "../../../../extensions/utils/tool-policy.js";
import { loadGoogleWorkspaceConfig } from "../../shared/accounts.js";
import { ProductionGogRunner } from "../../shared/gog-runner.js";
import { CALENDAR_OPERATIONS } from "./operations.js";
import { registerCalendarTool } from "./tool.js";
import { initProjectionTables, startProjectionTimer, stopProjectionTimer } from "./projection.js";
import { initIdempotencyTable } from "./idempotency.js";

export default async function calendarExtension(pi: ExtensionAPI): Promise<void> {
	const config = loadGoogleWorkspaceConfig();
	const runner = new ProductionGogRunner({
		binary: config.gogBinary,
		stdoutCap: config.calendar.limits.stdoutBytes,
		stderrCap: config.calendar.limits.stderrBytes,
	});

	// Register risk classifier for the calendar tool (blueprint §4.1).
	// The permission system calls this to classify calendar(action=X)
	// into the correct RiskClass. Unknown actions → "unclassified" → blocked.
	registerToolRiskClassifier("calendar", (input) => {
		const action = String(input.action ?? "");
		if (action === "status") return "read_only";
		const spec = CALENDAR_OPERATIONS[action as keyof typeof CALENDAR_OPERATIONS];
		if (!spec) return "unclassified";
		return spec.risk;
	});

	// Initialize SQLite tables (idempotent)
	initProjectionTables();
	initIdempotencyTable();

	// Register the semantic calendar tool
	registerCalendarTool(pi, runner, config);

	// Start projection refresh timer when agent is idle (if enabled)
	if (config.calendar.projection.enabled) {
		pi.on("agent_settled", () => {
			startProjectionTimer(runner, config);
		});
	}

	// Clean up on shutdown
	pi.on("session_shutdown", () => {
		stopProjectionTimer();
	});
}
