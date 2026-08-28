//! Tests for MockInferenceBackend.

use pi_inference::backend::{CompletionRequest, CompletionResponse, FinishReason, InferenceBackend};
use pi_inference::mock::MockInferenceBackend;
use pi_inference::streaming::StreamEvent;
use pi_types::TokenUsage;
use tokio_util::sync::CancellationToken;

fn simple_response(text: &str) -> CompletionResponse {
    CompletionResponse {
        content: text.to_string(),
        tool_calls: Vec::new(),
        thinking: None,
        finish_reason: FinishReason::Stop,
        model: "mock".to_string(),
        usage: TokenUsage {
            prompt_tokens: 10,
            completion_tokens: 5,
            thinking_tokens: 0,
        },
    }
}

#[tokio::test]
async fn complete_returns_canned_responses_in_order() {
    let mock = MockInferenceBackend::new(vec![
        simple_response("first"),
        simple_response("second"),
    ]);

    let req = CompletionRequest::default();

    let r1 = mock.complete(req.clone()).await.unwrap();
    assert_eq!(r1.content, "first");

    let r2 = mock.complete(req.clone()).await.unwrap();
    assert_eq!(r2.content, "second");
}

#[tokio::test]
async fn complete_errors_when_exhausted() {
    let mock = MockInferenceBackend::new(vec![simple_response("only")]);

    let req = CompletionRequest::default();
    let _ = mock.complete(req.clone()).await.unwrap();

    let err = mock.complete(req).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn with_text_convenience() {
    let mock = MockInferenceBackend::with_text("hello world");

    let r = mock.complete(CompletionRequest::default()).await.unwrap();
    assert_eq!(r.content, "hello world");
    assert_eq!(r.finish_reason, FinishReason::Stop);
}

#[tokio::test]
async fn remaining_count() {
    let mock = MockInferenceBackend::new(vec![
        simple_response("a"),
        simple_response("b"),
    ]);
    assert_eq!(mock.remaining(), 2);

    let _ = mock.complete(CompletionRequest::default()).await.unwrap();
    assert_eq!(mock.remaining(), 1);
}

#[tokio::test]
async fn streaming_sends_text_deltas() {
    let mock = MockInferenceBackend::with_text("Hello, world!");
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let cancel = CancellationToken::new();

    let response = mock
        .complete_streaming(CompletionRequest::default(), tx, cancel)
        .await
        .unwrap();

    assert_eq!(response.content, "Hello, world!");

    // Collect all events
    let mut text_parts = Vec::new();
    let mut got_done = false;
    let mut got_usage = false;

    while let Ok(event) = rx.try_recv() {
        match event {
            StreamEvent::TextDelta(t) => text_parts.push(t),
            StreamEvent::Done => got_done = true,
            StreamEvent::Usage(_) => got_usage = true,
            _ => {}
        }
    }

    let assembled: String = text_parts.join("");
    assert_eq!(assembled, "Hello, world!");
    assert!(got_done, "Should have received Done event");
    assert!(got_usage, "Should have received Usage event");
}

#[tokio::test]
async fn streaming_respects_cancellation() {
    // Create a long response to increase chance of cancellation hitting
    let long_text = "a".repeat(1000);
    let mock = MockInferenceBackend::with_text(&long_text);
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let cancel = CancellationToken::new();

    // Cancel immediately
    cancel.cancel();

    let result = mock
        .complete_streaming(CompletionRequest::default(), tx, cancel)
        .await;

    assert!(result.is_err(), "Should error on cancellation");
}

#[tokio::test]
async fn verify_manifest_returns_default() {
    let mock = MockInferenceBackend::with_text("test");
    let manifest = mock.verify_manifest().await.unwrap();
    assert_eq!(manifest.alias, "mock-model");
    assert_eq!(manifest.backend, "mock");
}

#[tokio::test]
async fn custom_manifest() {
    use pi_inference::manifest::{ModelCapabilities, ModelManifest};

    let custom_manifest = ModelManifest {
        protocol: 1,
        backend: "custom".to_string(),
        alias: "my-model".to_string(),
        family: "TestFamily".to_string(),
        artifact: "test-v1".to_string(),
        sha256: Some("abc123".to_string()),
        capabilities: ModelCapabilities::default(),
        operational_context: 32768,
    };

    let mock = MockInferenceBackend::with_text("test").with_manifest(custom_manifest);
    let manifest = mock.verify_manifest().await.unwrap();
    assert_eq!(manifest.alias, "my-model");
    assert_eq!(manifest.family, "TestFamily");
    assert_eq!(manifest.operational_context, 32768);
}
