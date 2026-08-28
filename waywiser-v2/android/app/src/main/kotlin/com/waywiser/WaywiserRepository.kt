package com.waywiser

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * Bridge between the Rust WaywiserRuntime and Kotlin/Compose UI.
 *
 * Polls the Rust runtime for events on a background thread and emits
 * them as a SharedFlow for consumption by ViewModels.
 */
class WaywiserRepository(private val runtime: WaywiserRuntime) {

    private val _events = MutableSharedFlow<RuntimeEvent>(
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** Stream of events from the Rust runtime. */
    val events: SharedFlow<RuntimeEvent> = _events

    private var pollJob: Job? = null

    /**
     * Start polling the Rust runtime for events.
     * Must be called from a lifecycle-aware scope (e.g., viewModelScope).
     * The poll loop runs on [Dispatchers.IO] to avoid blocking the main thread.
     */
    fun startPolling(scope: CoroutineScope) {
        if (pollJob?.isActive == true) return

        pollJob = scope.launch(Dispatchers.IO) {
            while (isActive) {
                try {
                    val event = runtime.pollEvent()
                    if (event != null && event !is RuntimeEvent.Heartbeat) {
                        _events.emit(event)
                    }
                } catch (e: WaywiserException) {
                    _events.emit(RuntimeEvent.Error(e.code, e.message ?: "unknown"))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _events.emit(RuntimeEvent.Error("poll_error", e.message ?: "unknown"))
                    delay(1000) // back off on unexpected errors
                }
            }
        }
    }

    /** Stop the polling loop. */
    fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    /** Send a user message to the agent. Returns immediately; response arrives via events. */
    suspend fun sendMessage(content: String) = withContext(Dispatchers.IO) {
        runtime.sendMessage(content)
    }

    /** Cancel the current agent turn. */
    suspend fun cancel() = withContext(Dispatchers.IO) {
        runtime.cancel()
    }

    /** Steer the current turn with new context. */
    suspend fun steer(content: String) = withContext(Dispatchers.IO) {
        runtime.steer(content)
    }

    /** List available sessions. */
    suspend fun listSessions(): List<SessionSummary> = withContext(Dispatchers.IO) {
        runtime.listSessions()
    }

    /** Create a new session, returns the session ID. */
    suspend fun createSession(): String = withContext(Dispatchers.IO) {
        runtime.createSession()
    }

    /** Shutdown the runtime gracefully. */
    fun shutdown() {
        stopPolling()
        try {
            runtime.shutdown()
        } catch (_: Exception) {
            // Best-effort shutdown
        }
    }
}
