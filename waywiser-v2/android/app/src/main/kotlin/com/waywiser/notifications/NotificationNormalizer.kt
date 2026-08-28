package com.waywiser.notifications

import android.app.Notification
import android.service.notification.StatusBarNotification
import java.time.Instant

/**
 * Extracts structured data from Android StatusBarNotification
 * into a normalized representation for the Rust classifier.
 */
object NotificationNormalizer {

    fun normalize(sbn: StatusBarNotification): NormalizedNotification {
        val notification = sbn.notification
        val extras = notification.extras

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        val conversationTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()

        // Extract person info if available
        val person = extractPerson(sbn)

        // Extract available actions
        val actions = notification.actions?.map { action ->
            NotificationAction(
                title = action.title?.toString() ?: "",
                // RemoteInput indicates inline reply capability
                hasRemoteInput = action.remoteInputs?.isNotEmpty() == true,
            )
        } ?: emptyList()

        return NormalizedNotification(
            id = sbn.key,
            appPackage = sbn.packageName,
            channelId = notification.channelId,
            title = title,
            text = text,
            bigText = bigText,
            person = person,
            actions = actions,
            priority = notification.priority,
            category = notification.category,
            postedAt = Instant.ofEpochMilli(sbn.postTime),
            isGroupSummary = sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0,
            conversationId = conversationTitle,
        )
    }

    private fun extractPerson(sbn: StatusBarNotification): PersonRef? {
        val extras = sbn.notification.extras

        // Try MessagingStyle person
        val messagingPerson = extras.getCharSequence(Notification.EXTRA_SELF_DISPLAY_NAME)
        if (messagingPerson != null) {
            return PersonRef(name = messagingPerson.toString(), key = null)
        }

        // Try title as sender for messaging apps
        val category = sbn.notification.category
        if (category == Notification.CATEGORY_MESSAGE) {
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            if (title != null) {
                return PersonRef(name = title, key = null)
            }
        }

        return null
    }
}

/** Normalized notification data passed to Rust classifier. */
data class NormalizedNotification(
    val id: String,
    val appPackage: String,
    val channelId: String?,
    val title: String,
    val text: String,
    val bigText: String?,
    val person: PersonRef?,
    val actions: List<NotificationAction>,
    val priority: Int,
    val category: String?,
    val postedAt: Instant,
    val isGroupSummary: Boolean,
    val conversationId: String?,
)

/** Reference to a person (sender) if identifiable. */
data class PersonRef(
    val name: String,
    val key: String?, // contact lookup key
)

/** An action available on the notification. */
data class NotificationAction(
    val title: String,
    val hasRemoteInput: Boolean,
)
