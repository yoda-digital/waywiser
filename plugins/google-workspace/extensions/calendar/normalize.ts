/**
 * Normalize raw gog JSON output → CalendarEvent.
 *
 * Blueprint §15-16: no hidden "intelligent" conversion. Timezone metadata
 * is preserved. All-day events are detected from date-only fields. DST is
 * delegated to Google/gog.
 *
 * The tool does NOT return direct CLI upstream structure. Raw API payload
 * is only available through action=event_raw.
 */
import type { CalendarEvent } from "./types.js";

/** Raw event shape from gog --json calendar events/event output. */
interface RawGogEvent {
	id?: string;
	iCalUID?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: { date?: string; dateTime?: string; timeZone?: string };
	end?: { date?: string; dateTime?: string; timeZone?: string };
	status?: string;
	visibility?: string;
	transparency?: string;
	eventType?: string;
	creator?: { email?: string; self?: boolean };
	organizer?: { email?: string; self?: boolean; displayName?: string };
	attendees?: Array<{
		email?: string;
		displayName?: string;
		responseStatus?: string;
		optional?: boolean;
		self?: boolean;
	}>;
	recurrence?: string[];
	recurringEventId?: string;
	originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
	conferenceData?: {
		conferenceSolution?: { name?: string };
		entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
	};
	updated?: string;
	htmlLink?: string;
	[key: string]: unknown;
}

/**
 * Normalize a batch of raw gog event objects to CalendarEvent[].
 * calendarId and account are injected from context (not in gog output).
 */
export function normalizeEvents(
	raw: unknown,
	account: string,
	calendarId: string,
): CalendarEvent[] {
	if (!raw || typeof raw !== "object") return [];

	// gog outputs either an array or an object with an "items" array
	let items: RawGogEvent[];
	if (Array.isArray(raw)) {
		items = raw;
	} else if (Array.isArray((raw as Record<string, unknown>).items)) {
		items = (raw as Record<string, unknown>).items as RawGogEvent[];
	} else {
		// Single event (from calendar event command)
		items = [raw as RawGogEvent];
	}

	return items
		.filter((item) => item && typeof item === "object" && item.id)
		.map((item) => normalizeEvent(item, account, calendarId));
}

/** Normalize a single raw gog event to CalendarEvent. */
export function normalizeEvent(
	raw: RawGogEvent,
	account: string,
	calendarId: string,
): CalendarEvent {
	const allDay = !!(raw.start?.date && !raw.start?.dateTime);

	// Conference detection
	let conference: CalendarEvent["conference"];
	if (raw.conferenceData?.entryPoints?.length) {
		const videoEntry = raw.conferenceData.entryPoints.find(
			(ep) => ep.entryPointType === "video",
		);
		if (videoEntry?.uri) {
			const name = (raw.conferenceData.conferenceSolution?.name ?? "").toLowerCase();
			let type: "meet" | "zoom" | "other" = "other";
			if (name.includes("zoom") || videoEntry.uri.includes("zoom.us")) {
				type = "zoom";
			} else if (name.includes("meet") || videoEntry.uri.includes("meet.google.com")) {
				type = "meet";
			}
			conference = { type, url: videoEntry.uri };
		}
	}

	// Attendees normalization — filter out entries without email
	const attendees = raw.attendees
		?.filter((a) => a.email)
		.map((a) => ({
			email: a.email!,
			displayName: a.displayName,
			responseStatus: a.responseStatus,
			optional: a.optional,
			self: a.self,
		}));

	return {
		provider: "google",
		account,
		calendarId,
		id: raw.id ?? "",
		iCalUID: raw.iCalUID,
		summary: raw.summary,
		description: raw.description,
		location: raw.location,
		allDay,
		start: {
			date: raw.start?.date,
			dateTime: raw.start?.dateTime,
			timeZone: raw.start?.timeZone,
		},
		end: {
			date: raw.end?.date,
			dateTime: raw.end?.dateTime,
			timeZone: raw.end?.timeZone,
		},
		status: raw.status,
		visibility: raw.visibility,
		transparency: raw.transparency,
		eventType: raw.eventType,
		creator: raw.creator ? { email: raw.creator.email, self: raw.creator.self } : undefined,
		organizer: raw.organizer ? { email: raw.organizer.email, self: raw.organizer.self } : undefined,
		attendees: attendees?.length ? attendees : undefined,
		recurrence: raw.recurrence,
		recurringEventId: raw.recurringEventId,
		originalStartTime: raw.originalStartTime?.dateTime ?? raw.originalStartTime?.date,
		conference,
		updatedAt: raw.updated,
		htmlLink: raw.htmlLink,
	};
}
