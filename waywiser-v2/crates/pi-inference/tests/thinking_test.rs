//! Tests for ThinkingConfig defaults.
//!
//! CRITICAL: Qwen3.8-27B defaults to "xhigh" reasoning which wastes tokens.
//! Our default MUST be Medium.

use pi_inference::thinking::{ReasoningEffort, ThinkingConfig};

#[test]
fn default_reasoning_effort_is_medium() {
    let config = ThinkingConfig::default();
    assert_eq!(
        config.reasoning_effort,
        ReasoningEffort::Medium,
        "Default reasoning effort MUST be Medium, not XHigh (Qwen3.8 overthinking research finding)"
    );
}

#[test]
fn default_is_enabled() {
    let config = ThinkingConfig::default();
    assert!(config.enabled, "Thinking should be enabled by default");
}

#[test]
fn default_max_thinking_tokens() {
    let config = ThinkingConfig::default();
    assert_eq!(config.max_thinking_tokens, Some(4096));
}

#[test]
fn interactive_preset_is_medium() {
    let config = ThinkingConfig::interactive();
    assert_eq!(config.reasoning_effort, ReasoningEffort::Medium);
}

#[test]
fn tool_call_preset_is_low() {
    let config = ThinkingConfig::tool_call();
    assert_eq!(config.reasoning_effort, ReasoningEffort::Low);
    assert_eq!(config.max_thinking_tokens, Some(1024));
}

#[test]
fn reflection_preset_is_xhigh() {
    let config = ThinkingConfig::reflection();
    assert_eq!(config.reasoning_effort, ReasoningEffort::XHigh);
    assert_eq!(config.max_thinking_tokens, Some(16384));
}

#[test]
fn disabled_preset() {
    let config = ThinkingConfig::disabled();
    assert!(!config.enabled);
    assert_eq!(config.reasoning_effort, ReasoningEffort::Low);
    assert_eq!(config.max_thinking_tokens, None);
}

#[test]
fn thinking_config_serialization_roundtrip() {
    let config = ThinkingConfig::default();
    let json = serde_json::to_string(&config).unwrap();
    let parsed: ThinkingConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.reasoning_effort, config.reasoning_effort);
    assert_eq!(parsed.enabled, config.enabled);
    assert_eq!(parsed.max_thinking_tokens, config.max_thinking_tokens);
}
