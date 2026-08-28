//! Tests for ModelManifest identity verification.

use pi_inference::manifest::{ModelCapabilities, ModelManifest};

fn test_manifest() -> ModelManifest {
    ModelManifest {
        protocol: 1,
        backend: "ollama".to_string(),
        alias: "waywiser-primary".to_string(),
        family: "Qwen3.8-27B".to_string(),
        artifact: "approved-unsloth-gguf".to_string(),
        sha256: Some("abc123def456".to_string()),
        capabilities: ModelCapabilities {
            text: true,
            vision: true,
            tools: true,
            thinking: true,
        },
        operational_context: 65536,
    }
}

#[test]
fn verify_identity_matches() {
    let manifest = test_manifest();
    assert!(manifest
        .verify_identity("waywiser-primary", "Qwen3.8-27B")
        .is_ok());
}

#[test]
fn verify_identity_alias_mismatch() {
    let manifest = test_manifest();
    let err = manifest
        .verify_identity("wrong-alias", "Qwen3.8-27B")
        .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("alias mismatch"));
    assert!(msg.contains("wrong-alias"));
}

#[test]
fn verify_identity_family_mismatch() {
    let manifest = test_manifest();
    let err = manifest
        .verify_identity("waywiser-primary", "Llama-70B")
        .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("family mismatch"));
    assert!(msg.contains("Llama-70B"));
}

#[test]
fn supports_all_capabilities() {
    let manifest = test_manifest();
    let required = ModelCapabilities {
        text: true,
        vision: true,
        tools: true,
        thinking: true,
    };
    assert!(manifest.supports(&required));
}

#[test]
fn supports_subset_capabilities() {
    let manifest = test_manifest();
    let required = ModelCapabilities {
        text: true,
        vision: false,
        tools: true,
        thinking: false,
    };
    assert!(manifest.supports(&required));
}

#[test]
fn supports_fails_on_missing_capability() {
    let mut manifest = test_manifest();
    manifest.capabilities.vision = false;
    let required = ModelCapabilities {
        text: true,
        vision: true, // required but not available
        tools: false,
        thinking: false,
    };
    assert!(!manifest.supports(&required));
}

#[test]
fn serialization_roundtrip() {
    let manifest = test_manifest();
    let json = serde_json::to_string_pretty(&manifest).unwrap();
    let parsed: ModelManifest = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.alias, manifest.alias);
    assert_eq!(parsed.family, manifest.family);
    assert_eq!(parsed.operational_context, manifest.operational_context);
    assert_eq!(parsed.sha256, manifest.sha256);
    assert_eq!(parsed.capabilities.vision, manifest.capabilities.vision);
}

#[test]
fn default_capabilities() {
    let caps = ModelCapabilities::default();
    assert!(caps.text, "text should default to true");
    assert!(!caps.vision, "vision should default to false");
    assert!(caps.tools, "tools should default to true");
    assert!(caps.thinking, "thinking should default to true");
}
