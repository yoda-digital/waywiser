package com.waywiser.edge

import android.content.ComponentCallbacks2
import android.content.Context
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Edge model lifecycle manager.
 *
 * Manages the on-device Gemma 4 E2B model via LiteRT-LM (OpenCL backend).
 * NOT llama.cpp/Vulkan — Mali GPU driver instability on Exynos (research finding).
 *
 * The edge model is NON-AUTHORITATIVE (invariant I6):
 * - Cannot execute capabilities
 * - Cannot lower deterministic risk
 * - Cannot create durable beliefs directly
 * - Cannot independently suppress high-consequence signals
 *
 * Memory budget on S21+ (8GB):
 * - Android OS + framework: ~3.0 GB
 * - Waywiser main app: ~0.5 GB
 * - Rust runtime + SQLite: ~0.3 GB
 * - Edge model (Gemma 4 E2B): ~0.7 GB
 * - Remaining for buffers/apps: ~3.5 GB
 */
class EdgeModelManager(
    private val context: Context,
    private val scope: CoroutineScope,
) {
    /** Current model residency state. */
    enum class ResidencyState { COLD, WARM, HOT }

    private val _residencyState = MutableStateFlow(ResidencyState.COLD)
    val residencyState: StateFlow<ResidencyState> = _residencyState.asStateFlow()

    private var unloadJob: Job? = null

    // TODO: Replace with actual LiteRT-LM session handle
    private var modelSession: Any? = null

    /** Load model into memory. COLD → WARM → HOT. */
    suspend fun warmUp() = withContext(Dispatchers.Default) {
        if (_residencyState.value == ResidencyState.HOT) return@withContext

        cancelScheduledUnload()

        Log.i(TAG, "Loading Gemma 4 E2B model via LiteRT-LM...")
        _residencyState.value = ResidencyState.WARM

        try {
            // TODO: Initialize LiteRT-LM session with OpenCL backend
            // val session = LiteRtLm.createSession(
            //     modelPath = context.filesDir.resolve("models/gemma-4-e2b.tflite").absolutePath,
            //     backend = LiteRtLm.Backend.OPENCL,
            //     maxTokens = 256,
            // )
            // modelSession = session

            _residencyState.value = ResidencyState.HOT
            Log.i(TAG, "Gemma 4 E2B loaded — HOT")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load edge model", e)
            _residencyState.value = ResidencyState.COLD
        }
    }

    /** Unload model from memory. HOT/WARM → COLD. */
    suspend fun unload() {
        cancelScheduledUnload()

        if (_residencyState.value == ResidencyState.COLD) return

        Log.i(TAG, "Unloading edge model")
        // TODO: Close LiteRT-LM session
        modelSession = null
        _residencyState.value = ResidencyState.COLD
    }

    /**
     * Run bounded inference with constrained structured output.
     *
     * @param prompt The input prompt for the model
     * @param jsonSchema Optional JSON schema for constrained decoding
     * @param maxTokens Maximum tokens to generate (keep small — this is utility inference)
     * @return Inference result with structured output and latency metrics
     */
    suspend fun infer(
        prompt: String,
        jsonSchema: String? = null,
        maxTokens: Int = 256,
    ): EdgeInferenceResult = withContext(Dispatchers.Default) {
        if (_residencyState.value != ResidencyState.HOT) {
            warmUp()
        }

        val startMs = System.currentTimeMillis()

        // TODO: Run inference via LiteRT-LM session
        // val output = session.generate(prompt, maxTokens, jsonSchema)
        val output = "" // placeholder

        val latencyMs = System.currentTimeMillis() - startMs

        EdgeInferenceResult(
            output = output,
            structuredOutput = null, // parsed JSON if constrained decoding was used
            latencyMs = latencyMs,
            tokensGenerated = 0,
        )
    }

    /** Current memory usage in bytes. */
    fun memoryUsageBytes(): Long {
        // TODO: Query LiteRT-LM for actual memory usage
        return when (_residencyState.value) {
            ResidencyState.COLD -> 0L
            ResidencyState.WARM -> 200_000_000L // ~200MB during load
            ResidencyState.HOT -> 676_000_000L  // ~676MB peak (Gemma 4 E2B)
        }
    }

    /** Schedule unload after a grace period. */
    fun scheduleUnload(delayMs: Long = 60_000L) {
        cancelScheduledUnload()
        unloadJob = scope.launch {
            delay(delayMs)
            unload()
        }
    }

    private fun cancelScheduledUnload() {
        unloadJob?.cancel()
        unloadJob = null
    }

    /**
     * Lifecycle-aware residency policy.
     * Called by the Application/Activity to manage model lifecycle.
     */
    fun onForegroundConversation() { scope.launch { warmUp() } }
    fun onCameraSessionStart() { scope.launch { warmUp() } }
    fun onScreenOff() { scheduleUnload(delayMs = 60_000) }
    fun onThermalThrottle() { scope.launch { unload() } }

    fun onTrimMemory(level: Int) {
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            scope.launch { unload() }
        }
    }

    companion object {
        private const val TAG = "EdgeModelManager"
    }
}

/** Result from edge model inference. */
data class EdgeInferenceResult(
    val output: String,
    val structuredOutput: Map<String, Any>?,
    val latencyMs: Long,
    val tokensGenerated: Int,
)
