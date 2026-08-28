//! Core inference backend trait and request/response types.

use async_trait::async_trait;
use pi_types::{AgentMessage, TokenUsage, ToolCall, WaywiserError};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::manifest::ModelManifest;
use crate::streaming::StreamEvent;
use crate::thinking::ThinkingConfig;

/// The inference backend contract.
///
/// Implemented by `OllamaBackend` (production) and `MockInferenceBackend` (testing).
#[async_trait]
pub trait InferenceBackend: Send + Sync {
    /// Non-streaming completion. Returns the full response after generation.
    async fn complete(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, WaywiserError>;

    /// Streaming completion. Sends `StreamEvent`s through `tx` as they arrive.
    /// Respects the `cancel` token — cancels generation when triggered.
    /// Returns the final aggregated response.
    async fn complete_streaming(
        &self,
        request: CompletionRequest,
        tx: tokio::sync::mpsc::Sender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<CompletionResponse, WaywiserError>;

    /// Verify model identity matches expected manifest (§41).
    /// A silent server-side swap is a health failure.
    async fn verify_manifest(&self) -> Result<ModelManifest, WaywiserError>;
}

/// A request to the inference backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionRequest {
    /// The conversation messages to send.
    pub messages: Vec<AgentMessage>,
    /// Tool definitions available to the model.
    pub tools: Vec<ToolDefinition>,
    /// Thinking/reasoning configuration.
    pub thinking: ThinkingConfig,
    /// Maximum output tokens (None = model default).
    pub max_tokens: Option<u32>,
    /// Temperature (None = model default).
    pub temperature: Option<f32>,
    /// Response format constraint.
    pub response_format: Option<ResponseFormat>,
    /// Model alias override (None = use configured default).
    pub model: Option<String>,
}

impl Default for CompletionRequest {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
            tools: Vec::new(),
            thinking: ThinkingConfig::default(),
            max_tokens: None,
            temperature: None,
            response_format: None,
            model: None,
        }
    }
}

/// Response from the inference backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionResponse {
    /// The generated content.
    pub content: String,
    /// Tool calls requested by the model.
    pub tool_calls: Vec<ToolCall>,
    /// Thinking/reasoning content, if any.
    pub thinking: Option<String>,
    /// Why the model stopped generating.
    pub finish_reason: FinishReason,
    /// The model that was used.
    pub model: String,
    /// Token usage statistics.
    pub usage: TokenUsage,
}

/// Why the model stopped generating.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FinishReason {
    /// Natural stop (EOS token).
    Stop,
    /// Model requested tool calls.
    ToolCalls,
    /// Hit max_tokens limit.
    Length,
    /// Content was filtered.
    ContentFilter,
}

/// Tool/function definition sent to the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// Tool name (matches CapabilityName in many cases).
    pub name: String,
    /// Human-readable description of what the tool does.
    pub description: String,
    /// JSON Schema for the tool's parameters.
    pub parameters: serde_json::Value,
}

/// Response format constraint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ResponseFormat {
    /// Respond in JSON (model chooses schema).
    Json,
    /// Respond matching a specific JSON schema.
    JsonSchema(serde_json::Value),
}

impl FinishReason {
    /// Parse from OpenAI-compatible finish_reason string.
    pub fn from_str_openai(s: &str) -> Self {
        match s {
            "stop" => FinishReason::Stop,
            "tool_calls" => FinishReason::ToolCalls,
            "length" => FinishReason::Length,
            "content_filter" => FinishReason::ContentFilter,
            _ => FinishReason::Stop,
        }
    }
}
