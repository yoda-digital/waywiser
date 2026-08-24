/**
 * Calendar extension types — single source of truth for the semantic
 * contract between the model, the plugin, and the gog adapter.
 *
 * The model sees `calendar(action=..., ...)` with typed parameters.
 * The plugin translates to the correct gog invocation.
 */

// ── Risk class (must match the extended permissions RiskClass) ───────
export type RiskClass =
	| "read_only"
	| "write_local"
	| "process_exec"
	| "communication"
	| "network"
	| "scheduling"
	| "mcp_read"
	| "mcp_write"
	| "unclassified";

// ── Calendar actions ────────────────────────────────────────────────
export type CalendarAction =
	// Read / query
	| "status"
	| "calendars"
	| "acl"
	| "alias_list"
	| "events"
	| "event"
	| "event_raw"
	| "freebusy"
	| "propose_time"
	| "colors"
	| "conflicts"
	| "changed"
	| "search"
	| "time"
	| "users"
	| "team"
	// Local configuration writes
	| "alias_set"
	| "alias_unset"
	// Calendar / list management
	| "subscribe"
	| "unsubscribe"
	| "create_calendar"
	| "delete_calendar"
	// Event mutations
	| "create"
	| "update"
	| "move"
	| "delete"
	| "respond"
	| "focus_time"
	| "out_of_office"
	| "working_location";

// ── Operation manifest spec ─────────────────────────────────────────
export interface CalendarOperationSpec {
	action: CalendarAction;
	/** The gog subcommand segments, e.g. ["calendar", "events"] */
	gogCommand: string[];
	/** Dotted exact command ID, e.g. "calendar.events" */
	exactCommand: string;
	risk: RiskClass;
	mode: "read" | "local_write" | "remote_write";
	readonly: boolean;
	wrapUntrusted: boolean;
	requiresAuth: boolean;
	requiresWriteReady: boolean;
	supportsDryRun: boolean;
	timeoutMs: number;
}

// ── Normalized calendar event (blueprint §15) ───────────────────────
export interface CalendarEvent {
	provider: "google";
	account: string;
	calendarId: string;
	id: string;
	iCalUID?: string;
	summary?: string;
	description?: string;
	location?: string;
	allDay: boolean;
	start: {
		date?: string;
		dateTime?: string;
		timeZone?: string;
	};
	end: {
		date?: string;
		dateTime?: string;
		timeZone?: string;
	};
	status?: string;
	visibility?: string;
	transparency?: string;
	eventType?: string;
	creator?: {
		email?: string;
		self?: boolean;
	};
	organizer?: {
		email?: string;
		self?: boolean;
	};
	attendees?: Array<{
		email: string;
		displayName?: string;
		responseStatus?: string;
		optional?: boolean;
		self?: boolean;
	}>;
	recurrence?: string[];
	recurringEventId?: string;
	originalStartTime?: string;
	conference?: {
		type?: "meet" | "zoom" | "other";
		url?: string;
	};
	updatedAt?: string;
	htmlLink?: string;
}

// ── Calendar status (blueprint §8) ──────────────────────────────────
export interface CalendarAccountStatus {
	account: string;
	authenticated: boolean;
	calendarReadable: boolean;
	calendarWritable: boolean;
	reason?: string;
}

export interface CalendarStatus {
	installed: boolean;
	compatible: boolean;
	schemaVersion?: number;
	build?: string;
	configured: boolean;
	accounts: CalendarAccountStatus[];
	readReady: boolean;
	writeReady: boolean;
	projection?: {
		enabled: boolean;
		lastSuccessAt?: string;
		stale: boolean;
	};
}

// ── Approval lease (blueprint §4.5) ─────────────────────────────────
export interface ApprovalLease {
	id: string;
	tool: string;
	actions: string[];
	account?: string;
	calendarIds?: string[];
	origin:
		| { type: "cron"; id: string }
		| { type: "proactive"; id: string }
		| { type: "interactive-session"; id: string };
	validFrom: string;
	validUntil?: string;
	maxExecutions?: number;
	executions: number;
	constraints?: Record<string, unknown>;
}
