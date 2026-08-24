/**
 * Semantic calendar tool — single tool registered with Pi.
 *
 * The model sees `calendar(action=..., ...)` with typed parameters.
 * This module dispatches to the correct gog invocation, normalizes
 * results, and returns formatted output.
 *
 * Blueprint §10: model does NOT see 27+ tools. Sees one coherent tool.
 * Blueprint §38: model never sees/constructs gog argv.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GogRunner } from "../../shared/gog-runner.js";
import type { GoogleWorkspaceConfig } from "../../shared/accounts.js";
import { resolveAccount } from "../../shared/accounts.js";
import { validateContract } from "../../shared/gog-contract.js";
import { toCalendarError, mapExitCode } from "../../shared/gog-errors.js";
import { CALENDAR_OPERATIONS, getOperationSpec } from "./operations.js";
import { buildGogInvocation } from "./invocation.js";
import { normalizeEvents } from "./normalize.js";
import { generateEventId, hashPayload, logOperation, updateOperationState, findExistingOperation } from "./idempotency.js";
import { getProjectionState } from "./projection.js";
import type { CalendarStatus, CalendarAccountStatus } from "./types.js";
import { registry_ } from "../../../../extensions/utils/state.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean };

function ok(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: {} };
}

function err(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}

/**
 * Register the semantic `calendar` tool with Pi.
 */
export function registerCalendarTool(
	pi: ExtensionAPI,
	runner: GogRunner,
	config: GoogleWorkspaceConfig,
): void {
	pi.registerTool({
		name: "calendar",
		label: "Calendar",
		description:
			"Google Calendar integration. Query events, check availability, manage " +
			"events, RSVP, focus time, out-of-office, and working location. " +
			"Read operations are unrestricted. Write operations require approval.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "The calendar operation to perform.",
					enum: [
						"status", "calendars", "acl", "alias_list",
						"events", "event", "event_raw",
						"freebusy", "propose_time", "colors", "conflicts",
						"changed", "search", "time", "users", "team",
						"alias_set", "alias_unset",
						"subscribe", "unsubscribe", "create_calendar", "delete_calendar",
						"create", "update", "move", "delete",
						"respond", "focus_time", "out_of_office", "working_location",
					],
				},
				account: { type: "string", description: "Account email or alias. Uses default if omitted." },
				calendar: { type: "string", description: "Calendar ID, name, or alias. Defaults to 'primary'." },
				event_id: { type: "string", description: "Event ID (for event, event_raw, update, move, delete, respond, propose_time)." },
				// Time range
				from: { type: "string", description: "Start time (RFC3339, date, or relative: now, today, tomorrow, monday)." },
				to: { type: "string", description: "End time (same formats as from)." },
				today: { type: "boolean", description: "Show today only." },
				tomorrow: { type: "boolean", description: "Show tomorrow only." },
				week: { type: "boolean", description: "Show this week." },
				days: { type: "number", description: "Window length in days from 'from' or today." },
				// Query / search
				query: { type: "string", description: "Free text search query." },
				// Pagination
				max: { type: "number", description: "Max results (default 10)." },
				all_pages: { type: "boolean", description: "Fetch all pages." },
				// Event creation / update
				summary: { type: "string", description: "Event title." },
				description: { type: "string", description: "Event description." },
				location: { type: "string", description: "Event location." },
				attendees: { type: "string", description: "Comma-separated attendee emails (modifiers: ;optional, ;comment=TEXT)." },
				all_day: { type: "boolean", description: "All-day event." },
				recurrence: { type: "string", description: "RRULE for recurring events." },
				reminders: { type: "string", description: "Custom reminders (e.g. popup:30m, email:1d)." },
				color: { type: "string", description: "Event color ID (1-11)." },
				visibility: { type: "string", description: "Visibility: default, public, private, confidential." },
				transparency: { type: "string", description: "Show as: opaque (busy) or transparent (free)." },
				send_updates: { type: "string", description: "Notification mode for attendees: all, externalOnly, none." },
				with_meet: { type: "boolean", description: "Create Google Meet conference." },
				with_zoom: { type: "boolean", description: "Create Zoom conference." },
				timezone: { type: "string", description: "IANA timezone." },
				// RSVP
				response: { type: "string", description: "RSVP response: accepted, declined, tentative." },
				// Move
				destination_calendar: { type: "string", description: "Destination calendar ID for move." },
				// Focus time / OOO / working location
				focus_auto_decline: { type: "boolean", description: "Auto-decline meetings during focus time." },
				focus_decline_message: { type: "string", description: "Auto-decline message for focus time." },
				focus_chat_status: { type: "string", description: "Chat status during focus time." },
				ooo_auto_decline: { type: "boolean", description: "Auto-decline meetings when OOO." },
				ooo_decline_message: { type: "string", description: "Auto-decline message for OOO." },
				working_location_type: { type: "string", description: "Working location type: homeOffice, officeLocation, customLocation." },
				working_office_label: { type: "string", description: "Office label for working location." },
				// Alias
				alias_name: { type: "string", description: "Alias name for alias_set/alias_unset." },
				alias_target: { type: "string", description: "Calendar ID target for alias_set." },
				// Calendar management
				calendar_name: { type: "string", description: "Calendar name for create_calendar / subscribe." },
				// delete / update scope for recurring
				scope: { type: "string", description: "Recurring event scope: this, all, future." },
				// Misc filters
				event_types: { type: "string", description: "Filter by event types (comma-separated)." },
				all_calendars: { type: "boolean", description: "Fetch from all calendars." },
				fields: { type: "string", description: "Comma-separated fields to return." },
				sort: { type: "string", description: "Sort by: start, end, summary, calendar." },
				// Group email for team
				group_email: { type: "string", description: "Workspace group email for team action." },
				// Guests
				guests_can_invite: { type: "boolean" },
				guests_can_modify: { type: "boolean" },
				guests_can_see_others: { type: "boolean" },
			},
			required: ["action"],
		},
		executionMode: "sequential",

		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ToolResult> {
			const action = String(params.action ?? "");

			// ── status (meta-action, no single gog command) ──────────
			if (action === "status") {
				return handleStatus(runner, config, signal);
			}

			const spec = getOperationSpec(action);
			if (!spec) {
				return err(`Unknown calendar action: "${action}". Use calendar action=status to see available actions.`);
			}

			// ── Account resolution ──────────────────────────────────
			let resolvedAccount: string | undefined;
			if (spec.requiresAuth) {
				const resolution = resolveAccount(config, params.account as string | undefined);
				if (!resolution.resolved) {
					return err(resolution.message);
				}
				resolvedAccount = resolution.email;
			}

			const calendarId = (params.calendar as string) ?? config.calendar.defaultCalendar;

			// ── Build operation-specific args ────────────────────────
			const opArgs = buildOperationArgs(action, params, calendarId);

			// ── Write authorization pipeline (blueprint §18) ────────
			if (spec.mode === "remote_write") {
				// Dry-run validation first (if supported and configured)
				if (spec.supportsDryRun && config.calendar.safety.dryRunWrites) {
					const dryInvocation = buildGogInvocation(spec, resolvedAccount, opArgs, { dryRun: true, signal });
					const dryResult = await runner.run(dryInvocation);
					if (dryResult.exitCode !== 0) {
						const calError = toCalendarError(dryResult.exitCode, dryResult.stderr);
						return err(`Dry-run validation failed: ${calError.message} [${calError.code}]`);
					}
				}

				// For creates: idempotency setup
				let operationId: string | undefined;
				let eventId: string | undefined;
				if (action === "create" || action === "focus_time" || action === "out_of_office" || action === "working_location") {
					const payloadHash = hashPayload(params as Record<string, unknown>);
					const existing = findExistingOperation(action, resolvedAccount!, calendarId, payloadHash);
					if (existing && existing.state === "success") {
						return ok(`Event already created (idempotent match). Event ID: ${existing.result_event_id}`);
					}
					operationId = `calop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
					eventId = generateEventId();

					logOperation({
						operationId,
						action,
						account: resolvedAccount!,
						calendarId,
						eventId,
						payloadHash,
						state: "pending",
					});
				}

				// Execute the actual mutation
				const invocation = buildGogInvocation(spec, resolvedAccount, opArgs, { signal });
				const result = await runner.run(invocation);

				// Log trace
				registry_().log("calendar", JSON.stringify({
					kind: "calendar",
					operationId,
					action,
					account: resolvedAccount,
					calendarId,
					risk: spec.risk,
					exitCode: result.exitCode,
					durationMs: result.durationMs,
					result: result.exitCode === 0 ? "success" : mapExitCode(result.exitCode),
				}));

				if (result.exitCode !== 0) {
					if (operationId) {
						updateOperationState(operationId, "failed");
					}
					const calError = toCalendarError(result.exitCode, result.stderr);
					return err(`Calendar ${action} failed: ${calError.message} [${calError.code}]`);
				}

				// Update idempotency journal
				if (operationId) {
					let resultEventId: string | null = null;
					try {
						const parsed = JSON.parse(result.stdout);
						resultEventId = parsed?.id ?? null;
					} catch { /* best effort */ }
					updateOperationState(operationId, "success", resultEventId);
				}

				// Normalize and return
				try {
					const parsed = JSON.parse(result.stdout);
					return ok(JSON.stringify(parsed, null, 2));
				} catch {
					return ok(result.stdout || "Operation completed successfully.");
				}
			}

			// ── Read / local_write path ─────────────────────────────
			const invocation = buildGogInvocation(spec, resolvedAccount, opArgs, { signal });
			const result = await runner.run(invocation);

			// Log trace
			registry_().log("calendar", JSON.stringify({
				kind: "calendar",
				action,
				account: resolvedAccount,
				calendarId,
				risk: spec.risk,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
			}));

			if (result.exitCode !== 0) {
				// Exit code 3 = empty results — not an error for reads
				if (result.exitCode === 3) {
					return ok("No results found.");
				}
				const calError = toCalendarError(result.exitCode, result.stderr);
				return err(`Calendar ${action} failed: ${calError.message} [${calError.code}]`);
			}

			// Normalize output for event-returning actions
			if (["events", "event", "search", "changed", "team", "conflicts"].includes(action)) {
				try {
					const parsed = JSON.parse(result.stdout);
					const events = normalizeEvents(parsed, resolvedAccount ?? "", calendarId);
					return ok(JSON.stringify(events, null, 2));
				} catch {
					return err("Failed to parse calendar response as JSON (malformed_adapter_output).");
				}
			}

			// For other reads, pass through structured JSON
			try {
				const parsed = JSON.parse(result.stdout);
				return ok(JSON.stringify(parsed, null, 2));
			} catch {
				return ok(result.stdout || "Operation completed.");
			}
		},
	});
}

// ── Status handler ──────────────────────────────────────────────────

async function handleStatus(
	runner: GogRunner,
	config: GoogleWorkspaceConfig,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const status: CalendarStatus = {
		installed: false,
		compatible: false,
		configured: config.accounts.length > 0,
		accounts: [],
		readReady: false,
		writeReady: false,
	};

	// 1. Resolve binary
	let binaryPath: string;
	try {
		const { execSync } = await import("node:child_process");
		binaryPath = execSync(`which ${config.gogBinary}`, { encoding: "utf-8" }).trim();
		status.installed = true;
	} catch {
		return ok(JSON.stringify(status, null, 2));
	}

	// 2. Capability contract
	const contract = await validateContract(runner, binaryPath);
	status.compatible = contract.compatible;
	status.schemaVersion = contract.schemaVersion;
	status.build = contract.build;

	if (!contract.compatible) {
		return ok(JSON.stringify({
			...status,
			incompatible: {
				missing: contract.missing,
				message: "Installed gog does not satisfy the Calendar capability contract.",
			},
		}, null, 2));
	}

	// 3. Per-account readiness
	for (const acct of config.accounts) {
		const acctStatus: CalendarAccountStatus = {
			account: acct.email,
			authenticated: false,
			calendarReadable: false,
			calendarWritable: false,
		};

		// Check auth via a minimal read (list calendars)
		const checkInvocation = buildGogInvocation(CALENDAR_OPERATIONS.calendars, acct.email, [], { signal });
		try {
			const result = await runner.run(checkInvocation);
			if (result.exitCode === 0) {
				acctStatus.authenticated = true;
				acctStatus.calendarReadable = true;
				// Assume writable if readable (actual write scope check requires a write attempt)
				acctStatus.calendarWritable = true;
			} else if (result.exitCode === 4) {
				acctStatus.reason = "Authentication required. Run: gog auth add";
			} else if (result.exitCode === 6) {
				acctStatus.authenticated = true;
				acctStatus.reason = "Permission denied — insufficient Calendar scopes.";
			} else {
				acctStatus.reason = `Readiness check failed with exit code ${result.exitCode}`;
			}
		} catch (e) {
			acctStatus.reason = `Check failed: ${e instanceof Error ? e.message : String(e)}`;
		}

		status.accounts.push(acctStatus);
	}

	status.readReady = status.accounts.some((a) => a.calendarReadable);
	status.writeReady = status.accounts.some((a) => a.calendarWritable);

	// 4. Projection state
	if (config.calendar.projection.enabled && config.accounts.length > 0) {
		const primaryAccount = config.accounts.find((a) => a.default)?.email ?? config.accounts[0].email;
		const projState = getProjectionState(primaryAccount);
		status.projection = {
			enabled: true,
			lastSuccessAt: projState?.lastSuccessAt ?? undefined,
			stale: projState?.stale ?? true,
		};
	}

	return ok(JSON.stringify(status, null, 2));
}

// ── Argument builders ───────────────────────────────────────────────

function buildOperationArgs(
	action: string,
	params: Record<string, unknown>,
	calendarId: string,
): string[] {
	const args: string[] = [];

	switch (action) {
		case "calendars":
		case "colors":
		case "time":
		case "users":
		case "alias_list":
			// No positional args needed
			break;

		case "acl":
			args.push(calendarId);
			break;

		case "events": {
			if (params.all_calendars) {
				args.push("--all");
			} else {
				args.push(calendarId);
			}
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			if (params.today) args.push("--today");
			if (params.tomorrow) args.push("--tomorrow");
			if (params.week) args.push("--week");
			if (params.days) args.push("--days", String(params.days));
			if (params.query) args.push("--query", String(params.query));
			if (params.max) args.push("--max", String(params.max));
			if (params.all_pages) args.push("--all-pages");
			if (params.event_types) args.push("--event-types", String(params.event_types));
			if (params.fields) args.push("--fields", String(params.fields));
			if (params.sort) args.push("--sort", String(params.sort));
			if (params.timezone) args.push("--timezone", String(params.timezone));
			break;
		}

		case "event":
			args.push(calendarId, String(params.event_id ?? ""));
			break;

		case "event_raw":
			args.push(calendarId, String(params.event_id ?? ""));
			break;

		case "freebusy":
			if (params.calendar) args.push(calendarId);
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			if (params.days) args.push("--days", String(params.days));
			break;

		case "conflicts":
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			if (params.days) args.push("--days", String(params.days));
			break;

		case "changed":
			args.push(calendarId);
			if (params.max) args.push("--max", String(params.max));
			break;

		case "search":
			args.push(String(params.query ?? ""));
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			if (params.max) args.push("--max", String(params.max));
			break;

		case "team":
			args.push(String(params.group_email ?? ""));
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			break;

		case "propose_time":
			args.push(calendarId, String(params.event_id ?? ""));
			break;

		// ── Local writes ────────────────────────────────────────
		case "alias_set":
			args.push(String(params.alias_name ?? ""), String(params.alias_target ?? calendarId));
			break;

		case "alias_unset":
			args.push(String(params.alias_name ?? ""));
			break;

		// ── Calendar management ─────────────────────────────────
		case "subscribe":
			args.push(String(params.calendar_name ?? calendarId));
			break;

		case "unsubscribe":
			args.push(calendarId);
			break;

		case "create_calendar":
			args.push(String(params.calendar_name ?? params.summary ?? ""));
			break;

		case "delete_calendar":
			args.push(calendarId);
			break;

		// ── Event mutations ─────────────────────────────────────
		case "create": {
			args.push(calendarId);
			if (params.summary) args.push("--summary", String(params.summary));
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			if (params.timezone) args.push("--timezone", String(params.timezone));
			if (params.description) args.push("--description", String(params.description));
			if (params.location) args.push("--location", String(params.location));
			if (params.attendees) args.push("--attendees", String(params.attendees));
			if (params.all_day) args.push("--all-day");
			if (params.recurrence) args.push("--rrule", String(params.recurrence));
			if (params.reminders) args.push("--reminder", String(params.reminders));
			if (params.color) args.push("--event-color", String(params.color));
			if (params.visibility) args.push("--visibility", String(params.visibility));
			if (params.transparency) args.push("--transparency", String(params.transparency));
			if (params.send_updates) args.push("--send-updates", String(params.send_updates));
			if (params.with_meet) args.push("--with-meet");
			if (params.with_zoom) args.push("--with-zoom");
			if (params.guests_can_invite) args.push("--guests-can-invite");
			if (params.guests_can_modify) args.push("--guests-can-modify");
			if (params.guests_can_see_others) args.push("--guests-can-see-others");
			if (params.event_types) args.push("--event-type", String(params.event_types));
			break;
		}

		case "update": {
			args.push(calendarId, String(params.event_id ?? ""));
			if (params.summary) args.push("--summary", String(params.summary));
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			if (params.timezone) args.push("--timezone", String(params.timezone));
			if (params.description) args.push("--description", String(params.description));
			if (params.location) args.push("--location", String(params.location));
			if (params.attendees) args.push("--attendees", String(params.attendees));
			if (params.color) args.push("--event-color", String(params.color));
			if (params.visibility) args.push("--visibility", String(params.visibility));
			if (params.transparency) args.push("--transparency", String(params.transparency));
			if (params.send_updates) args.push("--send-updates", String(params.send_updates));
			if (params.recurrence) args.push("--rrule", String(params.recurrence));
			if (params.reminders) args.push("--reminder", String(params.reminders));
			if (params.scope) args.push(`--scope=${String(params.scope)}`);
			break;
		}

		case "move":
			args.push(calendarId, String(params.event_id ?? ""), String(params.destination_calendar ?? ""));
			if (params.send_updates) args.push("--send-updates", String(params.send_updates));
			break;

		case "delete":
			args.push(calendarId, String(params.event_id ?? ""));
			if (params.send_updates) args.push("--send-updates", String(params.send_updates));
			break;

		case "respond":
			args.push(calendarId, String(params.event_id ?? ""));
			if (params.response) args.push(`--${String(params.response)}`);
			if (params.send_updates) args.push("--send-updates", String(params.send_updates));
			break;

		case "focus_time": {
			args.push(calendarId);
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			if (params.timezone) args.push("--timezone", String(params.timezone));
			if (params.summary) args.push("--summary", String(params.summary));
			if (params.focus_auto_decline) args.push("--focus-auto-decline");
			if (params.focus_decline_message) args.push("--focus-decline-message", String(params.focus_decline_message));
			if (params.focus_chat_status) args.push("--focus-chat-status", String(params.focus_chat_status));
			break;
		}

		case "out_of_office": {
			args.push(calendarId);
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			if (params.timezone) args.push("--timezone", String(params.timezone));
			if (params.summary) args.push("--summary", String(params.summary));
			if (params.ooo_auto_decline) args.push("--ooo-auto-decline");
			if (params.ooo_decline_message) args.push("--ooo-decline-message", String(params.ooo_decline_message));
			break;
		}

		case "working_location": {
			args.push(calendarId);
			if (params.from) args.push("--from", String(params.from));
			if (params.to) args.push("--to", String(params.to));
			if (params.timezone) args.push("--timezone", String(params.timezone));
			if (params.working_location_type) args.push("--working-location-type", String(params.working_location_type));
			if (params.working_office_label) args.push("--working-office-label", String(params.working_office_label));
			break;
		}

		default:
			break;
	}

	return args;
}
