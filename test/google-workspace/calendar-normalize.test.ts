import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-cal-norm-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

const { normalizeEvent, normalizeEvents } = jiti("../../plugins/google-workspace/extensions/calendar/normalize.ts") as {
  normalizeEvent: (raw: Record<string, unknown>, account: string, calendarId: string) => {
    provider: string;
    account: string;
    calendarId: string;
    id: string;
    iCalUID?: string;
    summary?: string;
    description?: string;
    location?: string;
    allDay: boolean;
    start: { date?: string; dateTime?: string; timeZone?: string };
    end: { date?: string; dateTime?: string; timeZone?: string };
    status?: string;
    visibility?: string;
    transparency?: string;
    eventType?: string;
    creator?: { email?: string; self?: boolean };
    organizer?: { email?: string; self?: boolean };
    attendees?: Array<{ email: string; displayName?: string; responseStatus?: string; optional?: boolean; self?: boolean }>;
    recurrence?: string[];
    recurringEventId?: string;
    originalStartTime?: string;
    conference?: { type?: string; url?: string };
    updatedAt?: string;
    htmlLink?: string;
  };
  normalizeEvents: (raw: unknown, account: string, calendarId: string) => Array<Record<string, unknown>>;
};

describe("normalizeEvent", () => {
  test("timed event normalization", () => {
    const raw = {
      id: "evt123",
      iCalUID: "uid@google.com",
      summary: "Team Standup",
      description: "Daily sync",
      location: "Room A",
      start: { dateTime: "2026-08-25T09:00:00+03:00", timeZone: "Europe/Chisinau" },
      end: { dateTime: "2026-08-25T09:30:00+03:00", timeZone: "Europe/Chisinau" },
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
      updated: "2026-08-24T10:00:00Z",
      htmlLink: "https://calendar.google.com/event?id=evt123",
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.provider, "google");
    assert.equal(event.account, "me@example.com");
    assert.equal(event.calendarId, "primary");
    assert.equal(event.id, "evt123");
    assert.equal(event.iCalUID, "uid@google.com");
    assert.equal(event.summary, "Team Standup");
    assert.equal(event.description, "Daily sync");
    assert.equal(event.location, "Room A");
    assert.equal(event.allDay, false);
    assert.equal(event.start.dateTime, "2026-08-25T09:00:00+03:00");
    assert.equal(event.start.timeZone, "Europe/Chisinau");
    assert.equal(event.end.dateTime, "2026-08-25T09:30:00+03:00");
    assert.equal(event.status, "confirmed");
    assert.equal(event.visibility, "default");
    assert.equal(event.transparency, "opaque");
    assert.equal(event.updatedAt, "2026-08-24T10:00:00Z");
    assert.equal(event.htmlLink, "https://calendar.google.com/event?id=evt123");
  });

  test("all-day event", () => {
    const raw = {
      id: "allday1",
      summary: "Vacation",
      start: { date: "2026-08-25" },
      end: { date: "2026-08-27" },
      status: "confirmed",
      eventType: "default",
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.allDay, true);
    assert.equal(event.start.date, "2026-08-25");
    assert.equal(event.end.date, "2026-08-27");
    assert.equal(event.start.dateTime, undefined);
    assert.equal(event.end.dateTime, undefined);
  });

  test("timezone preservation", () => {
    const raw = {
      id: "tz1",
      summary: "Cross-tz meeting",
      start: { dateTime: "2026-08-25T16:00:00-04:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-08-25T17:00:00-04:00", timeZone: "America/New_York" },
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.start.timeZone, "America/New_York");
    assert.equal(event.end.timeZone, "America/New_York");
  });

  test("attendees normalization", () => {
    const raw = {
      id: "att1",
      summary: "With attendees",
      start: { dateTime: "2026-08-25T10:00:00Z" },
      end: { dateTime: "2026-08-25T11:00:00Z" },
      attendees: [
        { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted", self: false },
        { email: "me@example.com", responseStatus: "needsAction", self: true, optional: true },
      ],
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.ok(event.attendees);
    assert.equal(event.attendees.length, 2);
    assert.equal(event.attendees[0].email, "alice@example.com");
    assert.equal(event.attendees[0].displayName, "Alice");
    assert.equal(event.attendees[0].responseStatus, "accepted");
    assert.equal(event.attendees[1].self, true);
    assert.equal(event.attendees[1].optional, true);
  });

  test("organizer extraction", () => {
    const raw = {
      id: "org1",
      summary: "Organized event",
      start: { dateTime: "2026-08-25T10:00:00Z" },
      end: { dateTime: "2026-08-25T11:00:00Z" },
      organizer: { email: "boss@example.com", self: false },
      creator: { email: "boss@example.com", self: false },
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.ok(event.organizer);
    assert.equal(event.organizer.email, "boss@example.com");
    assert.ok(event.creator);
    assert.equal(event.creator.email, "boss@example.com");
  });

  test("recurring instance", () => {
    const raw = {
      id: "rec1_20260825T090000Z",
      summary: "Weekly standup",
      start: { dateTime: "2026-08-25T09:00:00Z" },
      end: { dateTime: "2026-08-25T09:30:00Z" },
      recurringEventId: "rec1",
      originalStartTime: { dateTime: "2026-08-25T09:00:00Z" },
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.recurringEventId, "rec1");
    assert.ok(event.originalStartTime);
  });

  test("recurrence rules preserved", () => {
    const raw = {
      id: "rrule1",
      summary: "Recurring",
      start: { dateTime: "2026-08-25T09:00:00Z" },
      end: { dateTime: "2026-08-25T09:30:00Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.ok(event.recurrence);
    assert.equal(event.recurrence[0], "RRULE:FREQ=WEEKLY;BYDAY=MO");
  });

  test("conference detection — Google Meet", () => {
    const raw = {
      id: "meet1",
      summary: "Meet call",
      start: { dateTime: "2026-08-25T10:00:00Z" },
      end: { dateTime: "2026-08-25T11:00:00Z" },
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
        conferenceSolution: { name: "Google Meet" },
      },
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.ok(event.conference);
    assert.equal(event.conference.type, "meet");
    assert.equal(event.conference.url, "https://meet.google.com/abc-defg-hij");
  });

  test("conference detection — Zoom", () => {
    const raw = {
      id: "zoom1",
      summary: "Zoom call",
      start: { dateTime: "2026-08-25T10:00:00Z" },
      end: { dateTime: "2026-08-25T11:00:00Z" },
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/123456789" }],
        conferenceSolution: { name: "Zoom Meeting" },
      },
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.ok(event.conference);
    assert.equal(event.conference.type, "zoom");
    assert.ok(event.conference.url?.includes("zoom.us"));
  });

  test("cancelled event", () => {
    const raw = {
      id: "cancel1",
      summary: "Cancelled meeting",
      start: { dateTime: "2026-08-25T10:00:00Z" },
      end: { dateTime: "2026-08-25T11:00:00Z" },
      status: "cancelled",
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.status, "cancelled");
  });

  test("focus time event type", () => {
    const raw = {
      id: "focus1",
      summary: "Focus Time",
      start: { dateTime: "2026-08-25T09:00:00Z" },
      end: { dateTime: "2026-08-25T10:00:00Z" },
      eventType: "focusTime",
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.eventType, "focusTime");
  });

  test("out of office event type", () => {
    const raw = {
      id: "ooo1",
      summary: "Out of Office",
      start: { dateTime: "2026-08-25T00:00:00Z" },
      end: { dateTime: "2026-08-26T00:00:00Z" },
      eventType: "outOfOffice",
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.eventType, "outOfOffice");
  });

  test("working location event type", () => {
    const raw = {
      id: "wl1",
      summary: "Working from home",
      start: { date: "2026-08-25" },
      end: { date: "2026-08-26" },
      eventType: "workingLocation",
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.eventType, "workingLocation");
    assert.equal(event.allDay, true);
  });

  test("empty/null optional fields → undefined", () => {
    const raw = {
      id: "minimal1",
      start: { dateTime: "2026-08-25T10:00:00Z" },
      end: { dateTime: "2026-08-25T11:00:00Z" },
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.summary, undefined);
    assert.equal(event.description, undefined);
    assert.equal(event.location, undefined);
    assert.equal(event.attendees, undefined);
    assert.equal(event.organizer, undefined);
    assert.equal(event.conference, undefined);
    assert.equal(event.recurrence, undefined);
    assert.equal(event.recurringEventId, undefined);
  });

  test("description/summary/location preserved as-is (no HTML stripping)", () => {
    const raw = {
      id: "html1",
      summary: "Meeting <b>important</b>",
      description: "<p>Notes here</p>\nLine 2",
      location: "Room & Lab",
      start: { dateTime: "2026-08-25T10:00:00Z" },
      end: { dateTime: "2026-08-25T11:00:00Z" },
    };
    const event = normalizeEvent(raw, "me@example.com", "primary");
    assert.equal(event.summary, "Meeting <b>important</b>");
    assert.equal(event.description, "<p>Notes here</p>\nLine 2");
    assert.equal(event.location, "Room & Lab");
  });
});

describe("normalizeEvents", () => {
  test("handles array input", () => {
    const raw = [
      { id: "a", start: { dateTime: "2026-08-25T09:00:00Z" }, end: { dateTime: "2026-08-25T10:00:00Z" } },
      { id: "b", start: { dateTime: "2026-08-25T11:00:00Z" }, end: { dateTime: "2026-08-25T12:00:00Z" } },
    ];
    const events = normalizeEvents(raw, "me@example.com", "primary");
    assert.equal(events.length, 2);
  });

  test("handles {items: [...]} input", () => {
    const raw = {
      items: [
        { id: "x", start: { dateTime: "2026-08-25T09:00:00Z" }, end: { dateTime: "2026-08-25T10:00:00Z" } },
      ],
    };
    const events = normalizeEvents(raw, "me@example.com", "primary");
    assert.equal(events.length, 1);
  });

  test("returns empty for null/undefined", () => {
    assert.equal(normalizeEvents(null, "me@example.com", "primary").length, 0);
    assert.equal(normalizeEvents(undefined, "me@example.com", "primary").length, 0);
  });
});
