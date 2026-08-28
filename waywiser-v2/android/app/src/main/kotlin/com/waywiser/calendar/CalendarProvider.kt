package com.waywiser.calendar

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.CalendarContract
import java.time.Duration
import java.time.Instant

/**
 * ContentResolver wrapper for Android calendar access.
 *
 * All mutations go through the Rust SecurityKernel via ActionIntent —
 * this class only provides the raw calendar operations.
 */
class CalendarProvider(private val context: Context) {

    private val resolver: ContentResolver get() = context.contentResolver

    /** Read upcoming events within the given horizon. */
    fun upcoming(horizon: Duration): List<CalendarEvent> {
        val now = Instant.now().toEpochMilli()
        val end = now + horizon.toMillis()

        val projection = arrayOf(
            CalendarContract.Events._ID,
            CalendarContract.Events.CALENDAR_ID,
            CalendarContract.Events.TITLE,
            CalendarContract.Events.DTSTART,
            CalendarContract.Events.DTEND,
            CalendarContract.Events.EVENT_LOCATION,
            CalendarContract.Events.ALL_DAY,
            CalendarContract.Events.RRULE,
        )

        val selection = "${CalendarContract.Events.DTSTART} >= ? AND ${CalendarContract.Events.DTSTART} <= ?"
        val selectionArgs = arrayOf(now.toString(), end.toString())
        val sortOrder = "${CalendarContract.Events.DTSTART} ASC"

        val events = mutableListOf<CalendarEvent>()
        resolver.query(
            CalendarContract.Events.CONTENT_URI,
            projection,
            selection,
            selectionArgs,
            sortOrder,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                events.add(cursorToEvent(cursor))
            }
        }
        return events
    }

    /** Find conflicting events (overlapping time ranges). */
    fun conflicts(horizon: Duration): List<ConflictReport> {
        val events = upcoming(horizon)
        val conflicts = mutableListOf<ConflictReport>()

        for (i in events.indices) {
            for (j in i + 1 until events.size) {
                val a = events[i]
                val b = events[j]
                if (a.end > b.start && a.start < b.end) {
                    val overlapStart = maxOf(a.start, b.start)
                    val overlapEnd = minOf(a.end, b.end)
                    conflicts.add(ConflictReport(
                        eventA = a.id,
                        eventB = b.id,
                        overlap = Duration.ofMillis(overlapEnd - overlapStart),
                    ))
                }
            }
        }
        return conflicts
    }

    /** Create a calendar event. Returns the event URI. */
    fun createEvent(event: NewCalendarEvent): Uri? {
        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, event.calendarId)
            put(CalendarContract.Events.TITLE, event.title)
            put(CalendarContract.Events.DTSTART, event.start)
            put(CalendarContract.Events.DTEND, event.end)
            put(CalendarContract.Events.EVENT_LOCATION, event.location)
            put(CalendarContract.Events.EVENT_TIMEZONE, event.timezone)
            put(CalendarContract.Events.ALL_DAY, if (event.allDay) 1 else 0)
        }
        return resolver.insert(CalendarContract.Events.CONTENT_URI, values)
    }

    /** Update an existing calendar event. Returns rows affected. */
    fun updateEvent(eventId: Long, patch: CalendarPatch): Int {
        val values = ContentValues()
        patch.title?.let { values.put(CalendarContract.Events.TITLE, it) }
        patch.start?.let { values.put(CalendarContract.Events.DTSTART, it) }
        patch.end?.let { values.put(CalendarContract.Events.DTEND, it) }
        patch.location?.let { values.put(CalendarContract.Events.EVENT_LOCATION, it) }

        val uri = Uri.withAppendedPath(CalendarContract.Events.CONTENT_URI, eventId.toString())
        return resolver.update(uri, values, null, null)
    }

    /** Delete a calendar event. Returns rows affected. */
    fun deleteEvent(eventId: Long): Int {
        val uri = Uri.withAppendedPath(CalendarContract.Events.CONTENT_URI, eventId.toString())
        return resolver.delete(uri, null, null)
    }

    private fun cursorToEvent(cursor: Cursor): CalendarEvent {
        return CalendarEvent(
            id = cursor.getLong(0),
            calendarId = cursor.getLong(1),
            title = cursor.getString(2) ?: "",
            start = cursor.getLong(3),
            end = cursor.getLong(4),
            location = cursor.getString(5),
            allDay = cursor.getInt(6) == 1,
            recurrence = cursor.getString(7),
        )
    }
}

data class CalendarEvent(
    val id: Long,
    val calendarId: Long,
    val title: String,
    val start: Long,  // epoch millis
    val end: Long,
    val location: String?,
    val allDay: Boolean,
    val recurrence: String?,
)

data class NewCalendarEvent(
    val calendarId: Long,
    val title: String,
    val start: Long,
    val end: Long,
    val location: String? = null,
    val timezone: String = "UTC",
    val allDay: Boolean = false,
)

data class CalendarPatch(
    val title: String? = null,
    val start: Long? = null,
    val end: Long? = null,
    val location: String? = null,
)

data class ConflictReport(
    val eventA: Long,
    val eventB: Long,
    val overlap: Duration,
)
