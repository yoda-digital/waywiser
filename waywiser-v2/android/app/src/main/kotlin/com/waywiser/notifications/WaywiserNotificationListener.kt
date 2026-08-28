package com.waywiser.notifications

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Notification listener service that captures incoming notifications,
 * normalizes them, and forwards to the Rust classifier.
 *
 * Provisioning requirement: On Android 15+, Enhanced Confirmation Mode (ECM)
 * blocks sideloaded apps from enabling this service. Requires one of:
 * - Device factory image allowlist in /system/etc/sysconfig
 * - MDM programmatic grant (recommended)
 * - Per-device ADB enablement
 */
class WaywiserNotificationListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.isOngoing) return // skip persistent notifications

        val normalized = NotificationNormalizer.normalize(sbn)
        Log.d(TAG, "Notification: ${normalized.appPackage} — ${normalized.title}")

        // Forward to Rust classifier via FFI
        // val result = waywiserRuntime.classifyNotification(normalized)
        // handleAttentionDecision(result.attention, normalized)
        // TODO: Wire to WaywiserRuntime when FFI bindings are generated
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        Log.d(TAG, "Notification removed: ${sbn.key}")
        // waywiserRuntime.notificationDismissed(sbn.key)
    }

    companion object {
        private const val TAG = "WaywiserNotifListener"
    }
}
