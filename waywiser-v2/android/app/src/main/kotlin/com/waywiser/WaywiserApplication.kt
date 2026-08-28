package com.waywiser

import android.app.Application
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.waywiser.offline.ConnectivityMonitor

/**
 * Application entry point. Loads the native Rust library and initializes
 * the WaywiserRuntime singleton.
 */
class WaywiserApplication : Application() {

    lateinit var repository: WaywiserRepository
        private set

    lateinit var connectivityMonitor: ConnectivityMonitor
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this

        // Load the Rust megazord library (single .so for all crates)
        System.loadLibrary("waywiser")

        // Retrieve inference token from Android Keystore-backed storage
        val masterKey = MasterKey.Builder(this)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val securePrefs = EncryptedSharedPreferences.create(
            this,
            "waywiser_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
        val inferenceToken = securePrefs.getString("inference_token", "") ?: ""

        // Build RuntimeConfig
        val dbPath = getDatabasePath("waywiser.db").absolutePath
        val filesDir = filesDir.absolutePath
        val config = RuntimeConfig(
            dbPath = dbPath,
            inferenceUrl = securePrefs.getString("inference_url", "http://company-inference:11434") ?: "",
            inferenceToken = inferenceToken,
            modelAlias = "waywiser-primary",
            soulPath = "$filesDir/SOUL.md",
            userPath = "$filesDir/USER.md",
            skillsPath = "$filesDir/skills/active",
        )

        // Initialize the Rust runtime — rebuilds state from SQLite
        try {
            val runtime = WaywiserRuntime(config)
            repository = WaywiserRepository(runtime)
            Log.i(TAG, "WaywiserRuntime initialized successfully")
        } catch (e: WaywiserException) {
            Log.e(TAG, "Failed to initialize WaywiserRuntime", e)
            // In safe mode, skip runtime init
        }

        connectivityMonitor = ConnectivityMonitor(this)
    }

    override fun onTerminate() {
        super.onTerminate()
        if (::repository.isInitialized) {
            repository.shutdown()
        }
    }

    companion object {
        private const val TAG = "WaywiserApp"
        lateinit var instance: WaywiserApplication
            private set
    }
}

/**
 * RuntimeConfig passed to the Rust FFI layer.
 * Mirrors the Rust RuntimeConfig struct via UniFFI.
 */
data class RuntimeConfig(
    val dbPath: String,
    val inferenceUrl: String,
    val inferenceToken: String,
    val modelAlias: String,
    val soulPath: String,
    val userPath: String,
    val skillsPath: String,
)

/**
 * Placeholder for UniFFI-generated WaywiserRuntime binding.
 * In production, UniFFI generates this from the Rust interface.
 */
class WaywiserRuntime(config: RuntimeConfig) {
    fun sendMessage(content: String) { /* UniFFI native call */ }
    fun pollEvent(): RuntimeEvent? { /* UniFFI native call */ return null }
    fun cancel() { /* UniFFI native call */ }
    fun steer(content: String) { /* UniFFI native call */ }
    fun listSessions(): List<SessionSummary> { /* UniFFI native call */ return emptyList() }
    fun createSession(): String { /* UniFFI native call */ return "" }
    fun shutdown() { /* UniFFI native call */ }
}

/** Placeholder for UniFFI-generated exception. */
class WaywiserException(val code: String, message: String) : Exception(message)

/** Placeholder for UniFFI-generated RuntimeEvent. */
sealed interface RuntimeEvent {
    data class TextDelta(val text: String) : RuntimeEvent
    data class ThinkingDelta(val text: String) : RuntimeEvent
    data class ToolCallStarted(val id: String, val name: String) : RuntimeEvent
    data class ToolCallCompleted(val id: String, val success: Boolean, val summary: String) : RuntimeEvent
    data class TurnComplete(val promptTokens: Int, val completionTokens: Int) : RuntimeEvent
    data class Error(val code: String, val message: String) : RuntimeEvent
    data class SessionChanged(val sessionId: String) : RuntimeEvent
    data object Heartbeat : RuntimeEvent
}

/** Placeholder for UniFFI-generated SessionSummary. */
data class SessionSummary(
    val id: String,
    val turnCount: Int,
    val createdAt: String,
    val updatedAt: String,
)
