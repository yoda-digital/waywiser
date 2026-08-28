//! Inference transport layer for the Waywiser v2 runtime.
//!
//! Provides an `InferenceBackend` trait and concrete implementations:
//! - `OllamaBackend` — OpenAI-compatible HTTP client targeting Ollama with Qwen3.8-27B
//! - `MockInferenceBackend` — canned response backend for testing

pub mod backend;
pub mod manifest;
pub mod mock;
pub mod ollama;
pub mod streaming;
pub mod thinking;

pub use backend::{
    CompletionRequest, CompletionResponse, FinishReason, InferenceBackend, ResponseFormat,
    ToolDefinition,
};
pub use manifest::{ModelCapabilities, ModelManifest};
pub use mock::MockInferenceBackend;
pub use ollama::{OllamaBackend, OllamaConfig};
pub use streaming::{SseParser, StreamEvent};
pub use thinking::{ReasoningEffort, ThinkingConfig};
