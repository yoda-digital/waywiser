//! OllamaBackend — OpenAI-compatible HTTP client for Ollama inference.
//!
//! Targets the `/v1/chat/completions` endpoint with streaming SSE support.
//! Cancellation is achieved by dropping the HTTP response when the
//! CancellationToken fires.

use async_trait::async_trait;
use pi_types::{
    AgentMessage, ContentPart, MessageContent, TokenUsage, ToolCall,
    WaywiserError,
};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use tokio_util::sync::CancellationToken;

use crate::backend::{
    CompletionRequest, CompletionResponse, FinishReason, InferenceBackend, ResponseFormat,
};
use crate::manifest::{ModelCapabilities, ModelManifest};
use crate::streaming::{SseParser, StreamEvent};
use crate::thinking::ReasoningEffort;

/// Configuration for the Ollama backend.
#[derive(Debug, Clone)]
pub struct OllamaConfig {
    /// Base URL for the Ollama instance (e.g., "http://localhost:11434").
    pub base_url: String,
    /// Bearer token for authentication.
    pub auth_token: String,
    /// Expected model alias (e.g., "waywiser-primary").
    pub model_alias: String,
    /// Expected model family for manifest verification.
    pub expected_family: String,
    /// Request timeout in seconds.
    pub timeout_secs: u64,
}

impl Default for OllamaConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:11434".to_string(),
            auth_token: String::new(),
            model_alias: "waywiser-primary".to_string(),
            expected_family: "Qwen3.8-27B".to_string(),
            timeout_secs: 120,
        }
    }
}

/// OllamaBackend — production inference backend.
pub struct OllamaBackend {
    config: OllamaConfig,
    client: reqwest::Client,
}

impl OllamaBackend {
    /// Create a new OllamaBackend with the given configuration.
    pub fn new(config: OllamaConfig) -> Result<Self, WaywiserError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if !config.auth_token.is_empty() {
            let auth_value = format!("Bearer {}", config.auth_token);
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&auth_value)
                    .map_err(|e| WaywiserError::InferenceUnavailable(format!("invalid auth token: {e}")))?,
            );
        }

        let client = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .build()
            .map_err(|e| WaywiserError::InferenceUnavailable(format!("HTTP client error: {e}")))?;

        Ok(Self { config, client })
    }

    /// Build the OpenAI-compatible request body.
    fn build_request_body(&self, request: &CompletionRequest) -> serde_json::Value {
        let model = request
            .model
            .clone()
            .unwrap_or_else(|| self.config.model_alias.clone());

        let messages = request
            .messages
            .iter()
            .map(|m| self.convert_message(m))
            .collect::<Vec<_>>();

        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": false,
        });

        // Add tools
        if !request.tools.is_empty() {
            let tools: Vec<serde_json::Value> = request
                .tools
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                    })
                })
                .collect();
            body["tools"] = serde_json::Value::Array(tools);
        }

        // Add thinking config
        if request.thinking.enabled {
            let effort = match request.thinking.reasoning_effort {
                ReasoningEffort::Low => "low",
                ReasoningEffort::Medium => "medium",
                ReasoningEffort::XHigh => "xhigh",
            };
            body["reasoning_effort"] = serde_json::Value::String(effort.to_string());
            if let Some(max) = request.thinking.max_thinking_tokens {
                body["max_thinking_tokens"] = serde_json::Value::Number(max.into());
            }
        }

        // Add optional params
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = serde_json::Value::Number(max_tokens.into());
        }
        if let Some(temp) = request.temperature {
            body["temperature"] =
                serde_json::Value::Number(serde_json::Number::from_f64(temp as f64).unwrap_or(serde_json::Number::from(1)));
        }

        // Response format
        if let Some(ref fmt) = request.response_format {
            match fmt {
                ResponseFormat::Json => {
                    body["response_format"] = serde_json::json!({"type": "json_object"});
                }
                ResponseFormat::JsonSchema(schema) => {
                    body["response_format"] = serde_json::json!({
                        "type": "json_schema",
                        "json_schema": schema,
                    });
                }
            }
        }

        body
    }

    /// Convert an AgentMessage to OpenAI chat format.
    fn convert_message(&self, msg: &AgentMessage) -> serde_json::Value {
        match msg {
            AgentMessage::User(u) => serde_json::json!({
                "role": "user",
                "content": self.convert_content(&u.content),
            }),
            AgentMessage::Assistant(a) => {
                let mut msg = serde_json::json!({
                    "role": "assistant",
                    "content": a.content.as_text(),
                });
                if !a.tool_calls.is_empty() {
                    let tc: Vec<serde_json::Value> = a
                        .tool_calls
                        .iter()
                        .map(|tc| {
                            serde_json::json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": tc.arguments.to_string(),
                                }
                            })
                        })
                        .collect();
                    msg["tool_calls"] = serde_json::Value::Array(tc);
                }
                msg
            }
            AgentMessage::Tool(t) => serde_json::json!({
                "role": "tool",
                "tool_call_id": t.tool_call_id,
                "content": t.content.as_text(),
            }),
            AgentMessage::System(s) => serde_json::json!({
                "role": "system",
                "content": s.content,
            }),
        }
    }

    /// Convert MessageContent to OpenAI format (string or array of parts).
    fn convert_content(&self, content: &MessageContent) -> serde_json::Value {
        match content {
            MessageContent::Text(t) => serde_json::Value::String(t.clone()),
            MessageContent::Parts(parts) => {
                let converted: Vec<serde_json::Value> = parts
                    .iter()
                    .map(|p| match p {
                        ContentPart::Text(t) => serde_json::json!({
                            "type": "text",
                            "text": t,
                        }),
                        ContentPart::Image { media_type, data } => {
                            use base64::Engine;
                            let b64 = base64::engine::general_purpose::STANDARD.encode(data);
                            serde_json::json!({
                                "type": "image_url",
                                "image_url": {
                                    "url": format!("data:{};base64,{}", media_type, b64),
                                }
                            })
                        }
                    })
                    .collect();
                serde_json::Value::Array(converted)
            }
        }
    }

    /// Parse a non-streaming response.
    fn parse_response(&self, body: &serde_json::Value) -> Result<CompletionResponse, WaywiserError> {
        let choice = body["choices"]
            .as_array()
            .and_then(|c| c.first())
            .ok_or_else(|| WaywiserError::StreamInterrupted("no choices in response".into()))?;

        let message = &choice["message"];
        let content = message["content"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let thinking = message["reasoning_content"]
            .as_str()
            .map(String::from);

        let finish_reason = choice["finish_reason"]
            .as_str()
            .map(FinishReason::from_str_openai)
            .unwrap_or(FinishReason::Stop);

        let tool_calls = message["tool_calls"]
            .as_array()
            .map(|tcs| {
                tcs.iter()
                    .filter_map(|tc| {
                        Some(ToolCall {
                            id: tc["id"].as_str()?.to_string(),
                            name: tc["function"]["name"].as_str()?.to_string(),
                            arguments: serde_json::from_str(
                                tc["function"]["arguments"].as_str().unwrap_or("{}"),
                            )
                            .unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let usage = TokenUsage {
            prompt_tokens: body["usage"]["prompt_tokens"]
                .as_u64()
                .unwrap_or(0) as u32,
            completion_tokens: body["usage"]["completion_tokens"]
                .as_u64()
                .unwrap_or(0) as u32,
            thinking_tokens: body["usage"]["reasoning_tokens"]
                .as_u64()
                .unwrap_or(0) as u32,
        };

        let model = body["model"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();

        Ok(CompletionResponse {
            content,
            tool_calls,
            thinking,
            finish_reason,
            model,
            usage,
        })
    }

    /// Chat completions URL.
    fn completions_url(&self) -> String {
        format!("{}/v1/chat/completions", self.config.base_url)
    }

    /// Models URL (for manifest).
    fn models_url(&self) -> String {
        format!("{}/v1/models", self.config.base_url)
    }
}

#[async_trait]
impl InferenceBackend for OllamaBackend {
    async fn complete(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, WaywiserError> {
        let mut body = self.build_request_body(&request);
        body["stream"] = serde_json::Value::Bool(false);

        let response = self
            .client
            .post(self.completions_url())
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    WaywiserError::InferenceTimeout { ms: self.config.timeout_secs * 1000 }
                } else {
                    WaywiserError::InferenceUnavailable(format!("HTTP request failed: {e}"))
                }
            })?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(WaywiserError::InferenceUnavailable(format!(
                "HTTP {status}: {text}"
            )));
        }

        let response_body: serde_json::Value = response.json().await.map_err(|e| {
            WaywiserError::StreamInterrupted(format!("failed to parse response JSON: {e}"))
        })?;

        self.parse_response(&response_body)
    }

    async fn complete_streaming(
        &self,
        request: CompletionRequest,
        tx: tokio::sync::mpsc::Sender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<CompletionResponse, WaywiserError> {
        let mut body = self.build_request_body(&request);
        body["stream"] = serde_json::Value::Bool(true);
        body["stream_options"] = serde_json::json!({"include_usage": true});

        let response = self
            .client
            .post(self.completions_url())
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    WaywiserError::InferenceTimeout { ms: self.config.timeout_secs * 1000 }
                } else {
                    WaywiserError::InferenceUnavailable(format!("HTTP request failed: {e}"))
                }
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(WaywiserError::InferenceUnavailable(format!(
                "HTTP {status}: {text}"
            )));
        }

        let mut parser = SseParser::new();
        let mut aggregated_content = String::new();
        let mut aggregated_thinking = String::new();
        let mut aggregated_tool_calls: Vec<ToolCallBuilder> = Vec::new();
        let mut finish_reason = FinishReason::Stop;
        let mut usage = TokenUsage::default();
        let model = String::from("unknown");

        // Read response body as a byte stream
        let mut stream = response.bytes_stream();
        use futures_util::StreamExt;

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = tx.send(StreamEvent::Done).await;
                    return Err(WaywiserError::StreamInterrupted("cancelled by user".into()));
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            let text = String::from_utf8_lossy(&bytes);
                            let events = parser.feed(&text);

                            for event in events {
                                match &event {
                                    StreamEvent::TextDelta(t) => {
                                        aggregated_content.push_str(t);
                                    }
                                    StreamEvent::ThinkingDelta(t) => {
                                        aggregated_thinking.push_str(t);
                                    }
                                    StreamEvent::ToolCallDelta { index, id, name, arguments_delta } => {
                                        let idx = *index as usize;
                                        while aggregated_tool_calls.len() <= idx {
                                            aggregated_tool_calls.push(ToolCallBuilder::default());
                                        }
                                        if let Some(id) = id {
                                            aggregated_tool_calls[idx].id = id.clone();
                                        }
                                        if let Some(name) = name {
                                            aggregated_tool_calls[idx].name = name.clone();
                                        }
                                        aggregated_tool_calls[idx].arguments.push_str(arguments_delta);
                                    }
                                    StreamEvent::Usage(u) => {
                                        usage = *u;
                                    }
                                    StreamEvent::Done => {
                                        // Stream completed
                                    }
                                    StreamEvent::Error(_) => {}
                                }
                                // Forward event to the receiver
                                if tx.send(event).await.is_err() {
                                    // Receiver dropped — stop streaming
                                    return Err(WaywiserError::StreamInterrupted(
                                        "event receiver dropped".into(),
                                    ));
                                }
                            }
                        }
                        Some(Err(e)) => {
                            let _ = tx.send(StreamEvent::Error(e.to_string())).await;
                            return Err(WaywiserError::StreamInterrupted(format!(
                                "stream read error: {e}"
                            )));
                        }
                        None => {
                            // Stream ended
                            break;
                        }
                    }
                }
            }
        }

        // Determine finish reason from aggregated state
        if !aggregated_tool_calls.is_empty() {
            finish_reason = FinishReason::ToolCalls;
        }

        let tool_calls: Vec<ToolCall> = aggregated_tool_calls
            .into_iter()
            .map(|b| b.build())
            .collect();

        Ok(CompletionResponse {
            content: aggregated_content,
            tool_calls,
            thinking: if aggregated_thinking.is_empty() {
                None
            } else {
                Some(aggregated_thinking)
            },
            finish_reason,
            model,
            usage,
        })
    }

    async fn verify_manifest(&self) -> Result<ModelManifest, WaywiserError> {
        // Try to get model information from the Ollama API
        let response = self
            .client
            .get(self.models_url())
            .send()
            .await
            .map_err(|e| {
                WaywiserError::InferenceUnavailable(format!("manifest check failed: {e}"))
            })?;

        if !response.status().is_success() {
            return Err(WaywiserError::InferenceUnavailable(format!(
                "manifest check HTTP {}",
                response.status()
            )));
        }

        let body: serde_json::Value = response.json().await.map_err(|e| {
            WaywiserError::InferenceUnavailable(format!("manifest parse failed: {e}"))
        })?;

        // Find our model in the list
        let models = body["data"]
            .as_array()
            .or_else(|| body["models"].as_array())
            .ok_or_else(|| {
                WaywiserError::InferenceUnavailable("no models array in response".into())
            })?;

        let model_entry = models
            .iter()
            .find(|m| {
                m["id"]
                    .as_str()
                    .or_else(|| m["name"].as_str())
                    .map(|name| name.contains(&self.config.model_alias) || name.contains(&self.config.expected_family))
                    .unwrap_or(false)
            })
            .ok_or_else(|| {
                WaywiserError::ModelMismatch {
                    expected: self.config.model_alias.clone(),
                    actual: "model not found in endpoint".into(),
                }
            })?;

        let model_id = model_entry["id"]
            .as_str()
            .or_else(|| model_entry["name"].as_str())
            .unwrap_or("unknown")
            .to_string();

        Ok(ModelManifest {
            protocol: 1,
            backend: "ollama".to_string(),
            alias: self.config.model_alias.clone(),
            family: self.config.expected_family.clone(),
            artifact: model_id,
            sha256: None,
            capabilities: ModelCapabilities {
                text: true,
                vision: true,
                tools: true,
                thinking: true,
            },
            operational_context: 65536,
        })
    }
}

/// Helper for incrementally building a ToolCall from streaming deltas.
#[derive(Default)]
struct ToolCallBuilder {
    id: String,
    name: String,
    arguments: String,
}

impl ToolCallBuilder {
    fn build(self) -> ToolCall {
        ToolCall {
            id: self.id,
            name: self.name,
            arguments: serde_json::from_str(&self.arguments)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
        }
    }
}
