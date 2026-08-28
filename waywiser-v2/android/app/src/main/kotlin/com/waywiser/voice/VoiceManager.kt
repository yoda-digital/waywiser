package com.waywiser.voice

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.waywiser.WaywiserRepository
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * Voice pipeline manager implementing the full state machine.
 *
 * Coordinates: AudioRecord (VAD), SpeechRecognizer (STT), TextToSpeech (TTS),
 * and the Rust agent runtime (via WaywiserRepository).
 *
 * Barge-in: if VAD detects speech during TTS playback, TTS stops immediately
 * and the pipeline transitions to Listening, with a steer event sent to Pi.
 */
class VoiceManager(
    private val context: Context,
    private val repository: WaywiserRepository,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow<VoiceState>(VoiceState.Idle)
    val state: StateFlow<VoiceState> = _state.asStateFlow()

    private var tts: TextToSpeech? = null
    private var recognizer: SpeechRecognizer? = null
    private var vadJob: Job? = null
    private var bargeInEnabled: Boolean = true

    private val utteranceCounter = AtomicInteger(0)

    /** Initialize TTS and STT engines. */
    fun initialize() {
        tts = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.getDefault()
                Log.i(TAG, "TTS initialized")
            } else {
                Log.e(TAG, "TTS init failed: $status")
            }
        }

        if (SpeechRecognizer.isRecognitionAvailable(context)) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(context)
            recognizer?.setRecognitionListener(SttListener())
            Log.i(TAG, "STT initialized")
        } else {
            Log.w(TAG, "Speech recognition not available")
        }
    }

    /** Activate voice — start listening for speech. */
    fun activate() {
        if (_state.value !is VoiceState.Idle) return
        transition(VoiceEvent.MicActivated)
        startListening()
    }

    /** Cancel any voice activity and return to idle. */
    fun cancel() {
        stopListening()
        stopTts()
        _state.value = VoiceState.Idle
    }

    /** Inject text directly, bypassing voice (from notification/widget). */
    fun injectTextInput(text: String) {
        scope.launch {
            repository.sendMessage(text)
        }
    }

    fun setBargeInEnabled(enabled: Boolean) {
        bargeInEnabled = enabled
    }

    // ── State machine ──

    private fun transition(event: VoiceEvent) {
        val current = _state.value
        val next = when (event) {
            is VoiceEvent.MicActivated -> when (current) {
                is VoiceState.Idle -> VoiceState.Listening()
                else -> current
            }
            is VoiceEvent.VadSpeechEnd -> when (current) {
                is VoiceState.Listening -> VoiceState.Recognizing
                else -> current
            }
            is VoiceEvent.SttResult -> when (current) {
                is VoiceState.Recognizing -> {
                    scope.launch { repository.sendMessage(event.transcript) }
                    VoiceState.Processing
                }
                else -> current
            }
            is VoiceEvent.AgentStreamChunk -> when (current) {
                is VoiceState.Processing -> {
                    speakChunk(event.text)
                    VoiceState.Speaking(chunk = 1, totalChunks = 1)
                }
                is VoiceState.Speaking -> {
                    speakChunk(event.text)
                    current.copy(chunk = current.chunk + 1)
                }
                else -> current
            }
            is VoiceEvent.TtsPlaybackDone -> when (current) {
                is VoiceState.Speaking -> VoiceState.Idle
                else -> current
            }
            is VoiceEvent.BargeIn -> when (current) {
                is VoiceState.Speaking -> {
                    stopTts()
                    scope.launch { repository.steer("") } // Pi steering
                    VoiceState.BargeInDetected
                }
                else -> current
            }
            is VoiceEvent.Cancel -> {
                stopListening()
                stopTts()
                VoiceState.Idle
            }
            is VoiceEvent.ErrorOccurred -> VoiceState.Error(event.error)
            else -> current
        }

        _state.value = next

        // BargeInDetected is transitional — immediately go to Listening
        if (next is VoiceState.BargeInDetected) {
            _state.value = VoiceState.Listening()
            startListening()
        }
    }

    // ── STT ──

    private fun startListening() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }
        recognizer?.startListening(intent)

        // Start VAD monitoring for barge-in during TTS
        if (bargeInEnabled) {
            startVadMonitor()
        }
    }

    private fun stopListening() {
        recognizer?.stopListening()
        vadJob?.cancel()
    }

    // ── VAD (simple amplitude-based) ──

    private fun startVadMonitor() {
        vadJob?.cancel()
        vadJob = scope.launch(Dispatchers.Default) {
            // Simple amplitude-based VAD for barge-in detection
            // In production, use a proper VAD (Silero, WebRTC VAD)
            val sampleRate = 16000
            val bufferSize = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            // TODO: AudioRecord requires RECORD_AUDIO permission at runtime
            // val recorder = AudioRecord(MediaRecorder.AudioSource.MIC, ...)
            // Monitor amplitude, trigger BargeIn if above threshold during Speaking
        }
    }

    // ── TTS ──

    private fun speakChunk(text: String) {
        val utteranceId = "ww_${utteranceCounter.incrementAndGet()}"
        tts?.speak(text, TextToSpeech.QUEUE_ADD, null, utteranceId)
        tts?.setOnUtteranceProgressListener(TtsProgressListener())
    }

    private fun stopTts() {
        tts?.stop()
    }

    // ── Listeners ──

    private inner class SttListener : RecognitionListener {
        override fun onResults(results: Bundle?) {
            val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val transcript = matches?.firstOrNull() ?: return
            transition(VoiceEvent.SttResult(transcript))
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            matches?.firstOrNull()?.let {
                // Could update UI with partial transcript
            }
        }

        override fun onError(error: Int) {
            transition(VoiceEvent.ErrorOccurred(VoiceError.SttFailed("STT error code: $error")))
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() { _state.value = VoiceState.Listening(vadActive = true) }
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private inner class TtsProgressListener : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) {
            // Check if this was the last utterance in queue
            transition(VoiceEvent.TtsPlaybackDone)
        }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
            transition(VoiceEvent.ErrorOccurred(VoiceError.TtsFailed("TTS playback error")))
        }
    }

    /** Release all resources. */
    fun release() {
        cancel()
        tts?.shutdown()
        recognizer?.destroy()
        tts = null
        recognizer = null
    }

    companion object {
        private const val TAG = "VoiceManager"
    }
}
