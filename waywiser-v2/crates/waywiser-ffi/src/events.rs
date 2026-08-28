//! Runtime events and configuration types crossing the FFI boundary.

use serde::{Deserialize, Serialize};

use pi_types::message::TokenUsage;

/// Events delivered to Kotlin via `poll_event`.
///
/// In production, this would have `#[derive(uniffi::Enum)]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RuntimeEvent {
    /// Streamed text delta from the model.
    TextDelta { text: String },

    /// Model is "thinking" (reasoning block).
    ThinkingDelta { text: String },

    /// A tool call is being executed.
    ToolCallStarted { id: String, name: String },

    /// Tool call completed.
    ToolCallCompleted {
        id: String,
        success: bool,
        summary: String,
    },

    /// Turn completed.
    TurnComplete {
        prompt_tokens: u32,
        completion_tokens: u32,
        thinking_tokens: u32,
    },

    /// An error occurred.
    Error { code: String, message: String },

    /// Session state changed (new session loaded, session saved).
    SessionChanged { session_id: String },

    /// Heartbeat — no-op, keeps the poll alive.
    Heartbeat,
}

impl RuntimeEvent {
    pub fn text_delta(text: impl Into<String>) -> Self {
        Self::TextDelta { text: text.into() }
    }

    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Error {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn turn_complete(usage: &TokenUsage) -> Self {
        Self::TurnComplete {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            thinking_tokens: usage.thinking_tokens,
        }
    }
}

/// Configuration for initializing the runtime.
///
/// In production, this would have `#[derive(uniffi::Record)]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    /// Path to the SQLite database for sessions and memory.
    pub db_path: String,

    /// Inference endpoint URL (e.g., `http://company-server:11434`).
    pub inference_url: String,

    /// Authentication token for the inference endpoint.
    pub inference_token: String,

    /// Model alias (e.g., `waywiser-primary`).
    pub model_alias: String,

    /// Path to SOUL.md identity file.
    pub soul_path: String,

    /// Path to USER.md identity file.
    pub user_path: String,

    /// Path to the skills directory.
    pub skills_path: String,
}

impl RuntimeConfig {
    /// Create a config suitable for testing with in-memory storage.
    pub fn test_config() -> Self {
        Self {
            db_path: ":memory:".into(),
            inference_url: "http://localhost:11434".into(),
            inference_token: "test-token".into(),
            model_alias: "test-model".into(),
            soul_path: String::new(),
            user_path: String::new(),
            skills_path: String::new(),
        }
    }
}
