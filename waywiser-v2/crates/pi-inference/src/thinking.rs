//! Thinking/reasoning configuration for Qwen3.8-27B.
//!
//! CRITICAL: Default reasoning effort is Medium, NOT XHigh.
//! Qwen3.8 defaults to "wildly overthinking" at XHigh, wasting tokens
//! and latency on the single inference slot. (Research finding, Aug 2026)

use serde::{Deserialize, Serialize};

/// Reasoning effort level for the model's thinking blocks.
///
/// Controls how much "thinking" the model does before responding.
/// Lower effort = fewer thinking tokens = faster response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReasoningEffort {
    /// Minimal thinking. Use for tool calls and simple lookups.
    Low,
    /// Balanced thinking. DEFAULT for interactive conversations.
    Medium,
    /// Deep reasoning. Use ONLY for Brain reflection (P3 priority).
    XHigh,
}

/// Configuration for the model's thinking/reasoning behavior.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ThinkingConfig {
    /// Whether thinking blocks are enabled at all.
    pub enabled: bool,
    /// How much effort the model should spend reasoning.
    pub reasoning_effort: ReasoningEffort,
    /// Maximum tokens the model may spend on thinking.
    pub max_thinking_tokens: Option<u32>,
}

impl Default for ThinkingConfig {
    /// Default: enabled, Medium effort, 4096 max thinking tokens.
    ///
    /// Medium is chosen deliberately — Qwen3.8-27B at XHigh overthinks,
    /// consuming the shared inference slot with unnecessary reasoning.
    fn default() -> Self {
        Self {
            enabled: true,
            reasoning_effort: ReasoningEffort::Medium,
            max_thinking_tokens: Some(4096),
        }
    }
}

impl ThinkingConfig {
    /// Config for interactive conversation — balanced thinking.
    pub fn interactive() -> Self {
        Self::default()
    }

    /// Config for tool calls — minimal thinking for speed.
    pub fn tool_call() -> Self {
        Self {
            enabled: true,
            reasoning_effort: ReasoningEffort::Low,
            max_thinking_tokens: Some(1024),
        }
    }

    /// Config for Brain reflection — deep reasoning allowed.
    pub fn reflection() -> Self {
        Self {
            enabled: true,
            reasoning_effort: ReasoningEffort::XHigh,
            max_thinking_tokens: Some(16384),
        }
    }

    /// Thinking disabled entirely.
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            reasoning_effort: ReasoningEffort::Low,
            max_thinking_tokens: None,
        }
    }
}
