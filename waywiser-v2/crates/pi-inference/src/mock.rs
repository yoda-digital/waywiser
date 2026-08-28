//! Mock inference backend for testing.
//!
//! Returns canned responses in order. Supports both regular and streaming modes.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use pi_types::{TokenUsage, WaywiserError};
use tokio_util::sync::CancellationToken;

use crate::backend::{CompletionRequest, CompletionResponse, FinishReason, InferenceBackend};
use crate::manifest::{ModelCapabilities, ModelManifest};
use crate::streaming::StreamEvent;

/// Mock backend that returns pre-configured responses.
pub struct MockInferenceBackend {
    responses: Arc<Mutex<Vec<CompletionResponse>>>,
    manifest: ModelManifest,
}

impl MockInferenceBackend {
    /// Create a mock with a list of canned responses.
    /// Responses are returned in order; after exhaustion, returns an error.
    pub fn new(responses: Vec<CompletionResponse>) -> Self {
        Self {
            responses: Arc::new(Mutex::new(responses)),
            manifest: ModelManifest {
                protocol: 1,
                backend: "mock".to_string(),
                alias: "mock-model".to_string(),
                family: "MockFamily".to_string(),
                artifact: "mock-v1".to_string(),
                sha256: None,
                capabilities: ModelCapabilities::default(),
                operational_context: 65536,
            },
        }
    }

    /// Create a mock that returns a single simple text response.
    pub fn with_text(text: &str) -> Self {
        Self::new(vec![CompletionResponse {
            content: text.to_string(),
            tool_calls: Vec::new(),
            thinking: None,
            finish_reason: FinishReason::Stop,
            model: "mock-model".to_string(),
            usage: TokenUsage {
                prompt_tokens: 10,
                completion_tokens: 5,
                thinking_tokens: 0,
            },
        }])
    }

    /// Create a mock with a custom manifest for testing identity verification.
    pub fn with_manifest(mut self, manifest: ModelManifest) -> Self {
        self.manifest = manifest;
        self
    }

    /// Get the number of remaining responses.
    pub fn remaining(&self) -> usize {
        self.responses.lock().unwrap().len()
    }
}

#[async_trait]
impl InferenceBackend for MockInferenceBackend {
    async fn complete(
        &self,
        _request: CompletionRequest,
    ) -> Result<CompletionResponse, WaywiserError> {
        let mut responses = self.responses.lock().unwrap();
        if responses.is_empty() {
            return Err(WaywiserError::InferenceUnavailable(
                "mock: no more canned responses".into(),
            ));
        }
        Ok(responses.remove(0))
    }

    async fn complete_streaming(
        &self,
        request: CompletionRequest,
        tx: tokio::sync::mpsc::Sender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<CompletionResponse, WaywiserError> {
        // Get the response we would return
        let response = self.complete(request).await?;

        // Break content into chunks and stream them
        let chars: Vec<char> = response.content.chars().collect();
        let chunk_size = 5; // ~5 chars per chunk

        for chunk in chars.chunks(chunk_size) {
            if cancel.is_cancelled() {
                let _ = tx.send(StreamEvent::Done).await;
                return Err(WaywiserError::StreamInterrupted("cancelled".into()));
            }

            let text: String = chunk.iter().collect();
            if tx.send(StreamEvent::TextDelta(text)).await.is_err() {
                return Err(WaywiserError::StreamInterrupted(
                    "receiver dropped".into(),
                ));
            }

            // Simulate a small delay for realism in tests
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }

        // Send thinking if present
        if let Some(ref thinking) = response.thinking {
            let _ = tx.send(StreamEvent::ThinkingDelta(thinking.clone())).await;
        }

        // Send usage
        let _ = tx.send(StreamEvent::Usage(response.usage)).await;

        // Send done
        let _ = tx.send(StreamEvent::Done).await;

        Ok(response)
    }

    async fn verify_manifest(&self) -> Result<ModelManifest, WaywiserError> {
        Ok(self.manifest.clone())
    }
}
