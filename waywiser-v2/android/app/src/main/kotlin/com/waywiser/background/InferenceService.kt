package com.waywiser.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat

/**
 * Foreground service for active LLM inference.
 *
 * Uses `specialUse` foreground service type — NOT dataSync or mediaProcessing
 * which have a 6-hour timeout that would kill Brain reflection.
 *
 * Since this is an internal APK (no Play Store review), the specialUse
 * justification property in the manifest is sufficient.
 */
class InferenceService : Service() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification(
            title = "Waywiser",
            text = intent?.getStringExtra(EXTRA_STATUS) ?: "Thinking...",
        )

        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )

        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    /** Update the notification text while inference is running. */
    fun updateStatus(text: String) {
        val notification = buildNotification(title = "Waywiser", text = text)
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Inference",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Active AI inference"
            setShowBadge(false)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(title: String, text: String): Notification {
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "waywiser_inference"
        private const val NOTIFICATION_ID = 1001
        const val EXTRA_STATUS = "status"

        fun start(context: Context, status: String = "Thinking...") {
            val intent = Intent(context, InferenceService::class.java).apply {
                putExtra(EXTRA_STATUS, status)
            }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, InferenceService::class.java))
        }
    }
}
