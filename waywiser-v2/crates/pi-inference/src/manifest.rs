//! Model manifest — identity verification for the inference backend.
//!
//! A silent server-side model swap is a health failure (blueprint §41).
//! The app verifies expected model identity on startup and rejects mismatches.

use serde::{Deserialize, Serialize};

/// Model manifest exposed by the inference gateway (§41).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelManifest {
    /// Protocol version for manifest schema.
    pub protocol: u32,
    /// Backend engine name (e.g., "ollama").
    pub backend: String,
    /// Stable model alias (e.g., "waywiser-primary").
    pub alias: String,
    /// Model family (e.g., "Qwen3.8-27B").
    pub family: String,
    /// Artifact identifier (e.g., "approved-unsloth-gguf").
    pub artifact: String,
    /// SHA-256 hash of the model weights, if available.
    pub sha256: Option<String>,
    /// Model capabilities.
    pub capabilities: ModelCapabilities,
    /// Operational context window size (tokens).
    pub operational_context: u32,
}

/// What the model can do.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCapabilities {
    pub text: bool,
    pub vision: bool,
    pub tools: bool,
    pub thinking: bool,
}

impl ModelManifest {
    /// Verify that this manifest matches the expected identity.
    ///
    /// Returns `Ok(())` if the alias and family match.
    /// Returns the mismatch description on failure.
    pub fn verify_identity(
        &self,
        expected_alias: &str,
        expected_family: &str,
    ) -> Result<(), ManifestMismatch> {
        if self.alias != expected_alias {
            return Err(ManifestMismatch::AliasMismatch {
                expected: expected_alias.to_string(),
                actual: self.alias.clone(),
            });
        }
        if self.family != expected_family {
            return Err(ManifestMismatch::FamilyMismatch {
                expected: expected_family.to_string(),
                actual: self.family.clone(),
            });
        }
        Ok(())
    }

    /// Check if the model supports the required capabilities.
    pub fn supports(&self, required: &ModelCapabilities) -> bool {
        (!required.text || self.capabilities.text)
            && (!required.vision || self.capabilities.vision)
            && (!required.tools || self.capabilities.tools)
            && (!required.thinking || self.capabilities.thinking)
    }
}

/// Description of a manifest mismatch.
#[derive(Debug, Clone)]
pub enum ManifestMismatch {
    AliasMismatch { expected: String, actual: String },
    FamilyMismatch { expected: String, actual: String },
}

impl std::fmt::Display for ManifestMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestMismatch::AliasMismatch { expected, actual } => {
                write!(f, "model alias mismatch: expected '{expected}', got '{actual}'")
            }
            ManifestMismatch::FamilyMismatch { expected, actual } => {
                write!(f, "model family mismatch: expected '{expected}', got '{actual}'")
            }
        }
    }
}

impl std::error::Error for ManifestMismatch {}

impl Default for ModelCapabilities {
    fn default() -> Self {
        Self {
            text: true,
            vision: false,
            tools: true,
            thinking: true,
        }
    }
}
