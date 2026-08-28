package com.waywiser.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.waywiser.RuntimeEvent
import com.waywiser.WaywiserApplication
import com.waywiser.WaywiserRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

/**
 * ViewModel for the conversation screen.
 *
 * Survives configuration changes (rotation). On process death,
 * the Rust runtime rebuilds state from SQLite — no SavedStateHandle needed.
 */
class ConversationViewModel : ViewModel() {

    private val repository: WaywiserRepository = WaywiserApplication.instance.repository

    private val _uiState = MutableStateFlow(ConversationUiState())
    val uiState: StateFlow<ConversationUiState> = _uiState.asStateFlow()

    init {
        repository.startPolling(viewModelScope)

        viewModelScope.launch {
            repository.events.collect { event ->
                _uiState.update { state -> state.reduce(event) }
            }
        }
    }

    /** Send a user message to the agent. */
    fun sendMessage(text: String) {
        if (text.isBlank()) return
        viewModelScope.launch {
            _uiState.update { it.copy(
                messages = it.messages + UiMessage.User(text),
                pendingText = "",
                isStreaming = true,
            )}
            repository.sendMessage(text)
        }
    }

    /** Cancel the current agent turn. */
    fun cancel() {
        viewModelScope.launch { repository.cancel() }
    }

    /** Update the input text field. */
    fun updatePendingText(text: String) {
        _uiState.update { it.copy(pendingText = text) }
    }

    override fun onCleared() {
        repository.stopPolling()
        super.onCleared()
    }
}

/** Immutable UI state for the conversation screen. */
data class ConversationUiState(
    val messages: List<UiMessage> = emptyList(),
    val isStreaming: Boolean = false,
    val pendingText: String = "",
    val error: String? = null,
    val currentStreamText: String = "",
    val currentThinking: String = "",
) {
    /** Reduce a RuntimeEvent into a new UI state. */
    fun reduce(event: RuntimeEvent): ConversationUiState = when (event) {
        is RuntimeEvent.TextDelta -> copy(
            currentStreamText = currentStreamText + event.text,
        )
        is RuntimeEvent.ThinkingDelta -> copy(
            currentThinking = currentThinking + event.text,
        )
        is RuntimeEvent.ToolCallStarted -> copy(
            messages = messages + UiMessage.ToolCall(event.name, inProgress = true),
        )
        is RuntimeEvent.ToolCallCompleted -> {
            val updated = messages.toMutableList()
            val idx = updated.indexOfLast { it is UiMessage.ToolCall && (it as UiMessage.ToolCall).inProgress }
            if (idx >= 0) {
                updated[idx] = UiMessage.ToolCall(event.name, inProgress = false, result = event.summary)
            }
            copy(messages = updated)
        }
        is RuntimeEvent.TurnComplete -> copy(
            messages = messages + UiMessage.Assistant(currentStreamText),
            isStreaming = false,
            currentStreamText = "",
            currentThinking = "",
        )
        is RuntimeEvent.Error -> copy(
            error = "${event.code}: ${event.message}",
            isStreaming = false,
        )
        is RuntimeEvent.SessionChanged -> this // handled elsewhere
        is RuntimeEvent.Heartbeat -> this // no-op
    }
}

/** UI message types displayed in the conversation list. */
sealed interface UiMessage {
    data class User(val text: String) : UiMessage
    data class Assistant(val text: String) : UiMessage
    data class ToolCall(
        val name: String,
        val inProgress: Boolean = false,
        val result: String? = null,
    ) : UiMessage
}
