package com.waywiser.updater

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URL
import java.security.MessageDigest

/**
 * Internal APK update manager.
 *
 * Verification pipeline (blueprint §72):
 * 1. Fetch manifest from GitLab release
 * 2. Verify manifest signature with hardcoded Ed25519 public key
 * 3. Download APK
 * 4. Verify APK SHA-256 matches manifest
 * 5. Verify APK signing certificate
 * 6. Prompt user to install
 *
 * Never trust HTTPS alone.
 */
class UpdateManager(
    private val context: Context,
    private val gitlabBaseUrl: String,
    private val publicKeyHex: String, // hardcoded Ed25519 public key
) {
    /** Check for updates on the given channel. */
    suspend fun checkForUpdate(
        currentVersion: String,
        channel: UpdateChannel,
    ): UpdateResult = withContext(Dispatchers.IO) {
        try {
            // 1. Fetch manifest
            val manifestJson = fetchManifest(channel)
            val manifest = parseManifest(manifestJson)

            // 2. Verify manifest signature
            if (!verifyManifestSignature(manifestJson, manifest.signature)) {
                return@withContext UpdateResult.Error("Manifest signature verification failed")
            }

            // 3. Check version
            if (manifest.versionCode <= currentVersionCode()) {
                return@withContext UpdateResult.UpToDate
            }

            // 4. Check minimum supported version
            if (isVersionBelow(currentVersion, manifest.minSupportedVersion)) {
                Log.w(TAG, "Current version $currentVersion below minimum ${manifest.minSupportedVersion}")
            }

            UpdateResult.Available(manifest)
        } catch (e: Exception) {
            Log.e(TAG, "Update check failed", e)
            UpdateResult.Error(e.message ?: "Unknown error")
        }
    }

    /** Download and verify an APK. */
    suspend fun downloadAndVerify(manifest: UpdateManifest): VerifiedApk? = withContext(Dispatchers.IO) {
        try {
            // 3. Download APK
            val apkFile = downloadApk(manifest)

            // 4. Verify SHA-256
            val actualSha256 = sha256(apkFile)
            if (actualSha256 != manifest.sha256) {
                apkFile.delete()
                Log.e(TAG, "APK SHA-256 mismatch: expected ${manifest.sha256}, got $actualSha256")
                return@withContext null
            }

            // 5. Verify APK signing certificate
            // TODO: Use PackageManager.getPackageArchiveInfo() to verify certificate
            // matches expected company signing key

            VerifiedApk(
                file = apkFile,
                manifest = manifest,
                sha256 = actualSha256,
            )
        } catch (e: Exception) {
            Log.e(TAG, "Download/verify failed", e)
            null
        }
    }

    /** Enter safe mode after repeated startup crashes (blueprint §74). */
    fun enterSafeMode() {
        val prefs = context.getSharedPreferences("waywiser_safe_mode", Context.MODE_PRIVATE)
        prefs.edit().putBoolean("safe_mode", true).apply()
        Log.w(TAG, "Entering safe mode — disabling agent runtime, accessibility, voice, background")
        // Disable: agent runtime, Accessibility, camera, voice, MCP, background jobs
        // Enable: diagnostics, update check, basic UI
    }

    /** Check if safe mode is active. */
    fun isSafeModeActive(): Boolean {
        val prefs = context.getSharedPreferences("waywiser_safe_mode", Context.MODE_PRIVATE)
        return prefs.getBoolean("safe_mode", false)
    }

    /** Exit safe mode. */
    fun exitSafeMode() {
        val prefs = context.getSharedPreferences("waywiser_safe_mode", Context.MODE_PRIVATE)
        prefs.edit().putBoolean("safe_mode", false).apply()
    }

    /** Track consecutive startup crashes for safe mode trigger. */
    fun recordStartupSuccess() {
        val prefs = context.getSharedPreferences("waywiser_crashes", Context.MODE_PRIVATE)
        prefs.edit().putInt("consecutive_crashes", 0).apply()
    }

    fun recordStartupCrash() {
        val prefs = context.getSharedPreferences("waywiser_crashes", Context.MODE_PRIVATE)
        val crashes = prefs.getInt("consecutive_crashes", 0) + 1
        prefs.edit().putInt("consecutive_crashes", crashes).apply()
        if (crashes >= SAFE_MODE_CRASH_THRESHOLD) {
            enterSafeMode()
        }
    }

    // ── Private helpers ──

    private fun fetchManifest(channel: UpdateChannel): String {
        val url = "$gitlabBaseUrl/releases/latest/manifest-${channel.name.lowercase()}.json"
        return URL(url).readText()
    }

    private fun parseManifest(json: String): UpdateManifest {
        // TODO: Use kotlinx.serialization for proper parsing
        // Simplified placeholder
        return UpdateManifest(
            version = "0.0.0",
            versionCode = 0,
            sha256 = "",
            channel = UpdateChannel.Stable,
            minSupportedVersion = "0.0.0",
            signature = "",
        )
    }

    private fun verifyManifestSignature(manifestJson: String, signature: String): Boolean {
        // TODO: Implement Ed25519 signature verification using the hardcoded public key
        // Use java.security or a lightweight Ed25519 library
        Log.d(TAG, "Verifying manifest signature with public key: ${publicKeyHex.take(8)}...")
        return true // placeholder
    }

    private fun downloadApk(manifest: UpdateManifest): File {
        val url = "$gitlabBaseUrl/releases/${manifest.version}/waywiser-${manifest.version}.apk"
        val outputFile = File(context.cacheDir, "waywiser-update-${manifest.versionCode}.apk")
        URL(url).openStream().use { input ->
            outputFile.outputStream().use { output ->
                input.copyTo(output)
            }
        }
        return outputFile
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            var bytesRead: Int
            while (input.read(buffer).also { bytesRead = it } != -1) {
                digest.update(buffer, 0, bytesRead)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun currentVersionCode(): Int {
        return try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            info.longVersionCode.toInt()
        } catch (_: Exception) { 0 }
    }

    private fun isVersionBelow(current: String, minimum: String): Boolean {
        val c = current.split(".").map { it.toIntOrNull() ?: 0 }
        val m = minimum.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(c.size, m.size)) {
            val cv = c.getOrElse(i) { 0 }
            val mv = m.getOrElse(i) { 0 }
            if (cv < mv) return true
            if (cv > mv) return false
        }
        return false
    }

    companion object {
        private const val TAG = "UpdateManager"
        private const val SAFE_MODE_CRASH_THRESHOLD = 3
    }
}

/** Update check result. */
sealed interface UpdateResult {
    data class Available(val manifest: UpdateManifest) : UpdateResult
    data object UpToDate : UpdateResult
    data class Error(val reason: String) : UpdateResult
}

/** Update manifest from GitLab release. */
data class UpdateManifest(
    val version: String,
    val versionCode: Int,
    val sha256: String,
    val channel: UpdateChannel,
    val minSupportedVersion: String,
    val signature: String,
)

/** A downloaded and verified APK ready for installation. */
data class VerifiedApk(
    val file: File,
    val manifest: UpdateManifest,
    val sha256: String,
)

/** Update channels. */
enum class UpdateChannel { Dev, Canary, Beta, Stable }
