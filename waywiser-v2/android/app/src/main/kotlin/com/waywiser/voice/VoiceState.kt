package com.waywiser.voice

/**
 * Voice pipeline state machine states.
 *
 * Transitions:
 * ```
 * Idle → Listening          on MicActivated
 * Listening → Recognizing   on VadSpeechEnd
 * Recognizing → Processing  on SttResult
 * Processing → Speaking     on first AgentStreamChunk
 * Speaking → Speaking       on subsequent AgentStreamChunks
 * Speaking → Idle           on TtsPlaybackDone
 * Speaking → BargeIn        on BargeIn (VAD during TTS)
 * BargeIn → Listening       immediate (stop TTS, steer Pi)
 * Any → Idle                on Cancel
 * Any → Error               on ErrorOccurred
 * ```
 */
sealed interface VoiceState {
    /** No voice activity. Ready for activation. */
    data object Idle : VoiceState

    /** Microphone active, waiting for speech. */
    data class Listening(val vadActive: Boolean = false) : VoiceState

    /** Speech ended, STT processing audio. */
    data object Recognizing : VoiceState

    /** STT complete, Pi agent working on response. */
    data object Processing : VoiceState

    /** TTS playing agent response. */
    data class Speaking(val chunk: Int, val totalChunks: Int) : VoiceState

    /** Barge-in detected — transitional: stop TTS → Listening. */
    data object BargeInDetected : VoiceState

    /** Voice error occurred. */
    data class Error(val error: VoiceError) : VoiceState
}

/** Events that drive voice state transitions. */
sealed interface VoiceEvent {
    /** User activated the microphone (button, widget, hotword). */
    data object MicActivated : VoiceEvent

    /** VAD detected start of speech. */
    data object VadSpeechStart : VoiceEvent

    /** VAD detected end of speech with captured audio. */
    data class VadSpeechEnd(val audioData: ByteArray) : VoiceEvent

    /** STT produced a final transcript. */
    data class SttResult(val transcript: String) : VoiceEvent

    /** STT produced a partial transcript (for live display). */
    data class SttPartial(val partial: String) : VoiceEvent

    /** Agent stream chunk ready for TTS. */
    data class AgentStreamChunk(val text: String) : VoiceEvent

    /** Agent stream complete. */
    data object AgentStreamDone : VoiceEvent

    /** TTS chunk prepared and queued. */
    data class TtsChunkReady(val audioData: ByteArray) : VoiceEvent

    /** TTS finished playing all chunks. */
    data object TtsPlaybackDone : VoiceEvent

    /** VAD detected speech during TTS playback. */
    data object BargeIn : VoiceEvent

    /** User cancelled voice interaction. */
    data object Cancel : VoiceEvent

    /** An error occurred. */
    data class ErrorOccurred(val error: VoiceError) : VoiceEvent
}

/** Voice pipeline errors. */
sealed interface VoiceError {
    data object MicrophoneUnavailable : VoiceError
    data object SttUnavailable : VoiceError
    data object TtsUnavailable : VoiceError
    data class SttFailed(val reason: String) : VoiceError
    data class TtsFailed(val reason: String) : VoiceError
    data class AudioRecordError(val reason: String) : VoiceError
}
