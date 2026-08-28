//! Edge model hints — advisory only, cannot lower attention floor.

use pi_types::AttentionDecision;

/// A hint from the edge model about attention level.
///
/// # Contract
/// - Edge hints are NON-AUTHORITATIVE (invariant I6).
/// - They cannot lower the attention decision below a deterministic floor.
/// - Escalation requires lower confidence than suppression (asymmetry).
#[derive(Debug, Clone)]
pub struct EdgeHint {
    /// The edge model's suggested attention level.
    pub suggested: AttentionDecision,
    /// Confidence in the suggestion (0.0–1.0).
    pub confidence: f32,
    /// Optional structured reasoning for audit.
    pub reasoning: Option<String>,
}

impl EdgeHint {
    /// Create a new edge hint.
    pub fn new(suggested: AttentionDecision, confidence: f32) -> Self {
        Self {
            suggested,
            confidence: confidence.clamp(0.0, 1.0),
            reasoning: None,
        }
    }

    /// Create a hint with reasoning.
    pub fn with_reasoning(
        suggested: AttentionDecision,
        confidence: f32,
        reasoning: impl Into<String>,
    ) -> Self {
        Self {
            suggested,
            confidence: confidence.clamp(0.0, 1.0),
            reasoning: Some(reasoning.into()),
        }
    }
}
