package com.waywiser.camera

import android.content.Context
import android.util.Log
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Camera integration: CameraX → frame selection → local OCR/barcode → VisualScene.
 *
 * Frame selection is cheap (pixel diff threshold). Only "interesting" frames
 * are processed by ML Kit OCR and barcode scanner. Selective Qwen vision
 * queries only when the user asks or local CV can't classify.
 *
 * Privacy invariant: raw frames are ephemeral unless user explicitly captures.
 * No continuous background capture.
 */
class CameraManager(
    private val context: Context,
) {
    private var cameraProvider: ProcessCameraProvider? = null
    private var imageCapture: ImageCapture? = null

    /** Bind camera to lifecycle for preview + capture. */
    fun bindToLifecycle(
        lifecycleOwner: LifecycleOwner,
        previewView: Any?, // PreviewView in production
    ) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        cameraProviderFuture.addListener({
            cameraProvider = cameraProviderFuture.get()

            val preview = Preview.Builder().build()
            imageCapture = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .build()

            try {
                cameraProvider?.unbindAll()
                cameraProvider?.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageCapture,
                )
                Log.i(TAG, "Camera bound to lifecycle")
            } catch (e: Exception) {
                Log.e(TAG, "Camera bind failed", e)
            }
        }, { it.run() })
    }

    /** Unbind and release camera resources. */
    fun release() {
        cameraProvider?.unbindAll()
        cameraProvider = null
        imageCapture = null
    }

    companion object {
        private const val TAG = "CameraManager"
    }
}

/**
 * Frame selector: cheap change detection to avoid processing every frame.
 * Only frames with significant visual change are forwarded to OCR/CV.
 */
class FrameSelector(
    private val diffThreshold: Float = 0.15f,
) {
    private var previousLuminance: FloatArray? = null

    /**
     * Check if a frame is "interesting" enough to process.
     * Uses luminance histogram comparison (fast, no ML needed).
     */
    fun shouldProcess(luminanceHistogram: FloatArray): Boolean {
        val prev = previousLuminance
        if (prev == null) {
            previousLuminance = luminanceHistogram.copyOf()
            return true // always process first frame
        }

        // Histogram intersection distance
        var intersection = 0f
        for (i in luminanceHistogram.indices) {
            intersection += minOf(luminanceHistogram[i], prev[i])
        }
        val diff = 1f - intersection

        if (diff >= diffThreshold) {
            previousLuminance = luminanceHistogram.copyOf()
            return true
        }

        return false
    }

    fun reset() {
        previousLuminance = null
    }
}

/**
 * Local on-device vision processor — no network, no LLM.
 * Uses ML Kit for OCR and barcode scanning.
 */
class LocalVisionProcessor(private val context: Context) {

    /** Process a captured image with OCR and barcode detection. */
    suspend fun process(imageUri: android.net.Uri): LocalVisionResult = withContext(Dispatchers.Default) {
        val textBlocks = mutableListOf<String>()
        val barcodes = mutableListOf<String>()

        // TODO: Use ML Kit TextRecognizer
        // val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        // val image = InputImage.fromFilePath(context, imageUri)
        // val result = recognizer.process(image).await()
        // textBlocks.addAll(result.textBlocks.map { it.text })

        // TODO: Use ML Kit BarcodeScanner
        // val scanner = BarcodeScanning.getClient()
        // val barcodeResult = scanner.process(image).await()
        // barcodes.addAll(barcodeResult.map { it.displayValue ?: it.rawValue ?: "" })

        LocalVisionResult(
            textBlocks = textBlocks,
            barcodes = barcodes,
        )
    }
}

/** Results from local (on-device) vision processing. */
data class LocalVisionResult(
    val textBlocks: List<String>,
    val barcodes: List<String>,
)
