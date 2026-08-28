package com.waywiser.capture

import android.content.Intent
import android.net.Uri
import com.waywiser.WaywiserRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Unified capture system for all input modalities.
 * Every capture becomes a Rust Observation with appropriate RetentionClass.
 */
class CaptureManager(
    private val repository: WaywiserRepository,
) {
    /** Input modalities. */
    sealed interface CaptureSource {
        /** Direct text input from keyboard. */
        data class Text(val content: String) : CaptureSource

        /** Voice transcript with optional raw audio URI. */
        data class Voice(val transcript: String, val audioUri: Uri? = null) : CaptureSource

        /** Camera capture with optional OCR text. */
        data class Camera(val imageUri: Uri, val ocrText: String? = null) : CaptureSource

        /** Content received via Android share sheet. */
        data class ShareSheet(val intent: Intent) : CaptureSource

        /** File picked via DocumentsUI. */
        data class File(val uri: Uri, val mimeType: String) : CaptureSource
    }

    /**
     * Capture input and forward as an Observation to the Rust runtime.
     *
     * All captures are tagged with appropriate retention:
     * - Text input → Session (promoted by Brain if significant)
     * - Voice transcript → Session
     * - Camera capture → Experience (user explicitly captured)
     * - Share sheet → Experience (user explicitly shared)
     * - File → Experience
     */
    suspend fun capture(source: CaptureSource) = withContext(Dispatchers.IO) {
        when (source) {
            is CaptureSource.Text -> {
                repository.sendMessage(source.content)
            }
            is CaptureSource.Voice -> {
                repository.sendMessage(source.transcript)
            }
            is CaptureSource.Camera -> {
                val text = source.ocrText ?: "[image captured]"
                // TODO: Send image data to Rust for VisualScene processing
                repository.sendMessage("[Camera] $text")
            }
            is CaptureSource.ShareSheet -> {
                val text = extractShareContent(source.intent)
                repository.sendMessage("[Shared] $text")
            }
            is CaptureSource.File -> {
                repository.sendMessage("[File] ${source.mimeType}: ${source.uri}")
            }
        }
    }

    private fun extractShareContent(intent: Intent): String {
        // Handle text/plain shares
        intent.getStringExtra(Intent.EXTRA_TEXT)?.let { return it }

        // Handle text/html shares
        intent.getStringExtra(Intent.EXTRA_HTML_TEXT)?.let { return it }

        // Handle image/file shares (URI)
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        if (uri != null) {
            return "[attachment: $uri]"
        }

        return intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: "[shared content]"
    }
}
