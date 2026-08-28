//! TOCTOU Protection — fingerprint-based pre-action verification (blueprint §24).
//!
//! The UI may change between planning and action. Immediately before a side
//! effect, re-resolve the target and verify the fingerprint still matches.

use serde::{Deserialize, Serialize};

use pi_types::RiskLevel;

/// Fingerprint of a UI node at planning time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeFingerprint {
    pub package: String,
    pub window_id: i32,
    pub resource_id: Option<String>,
    pub class_name: String,
    pub role: Option<String>,
    pub normalized_text: Option<String>,
    pub content_description: Option<String>,
    pub ancestor_signature: Vec<String>,
    pub state: Option<String>,
    pub approximate_bounds: Rect,
}

/// Simple rectangle for approximate bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Result of fingerprint comparison.
#[derive(Debug, Clone)]
pub enum FingerprintMatch {
    Exact,
    Partial {
        mismatches: Vec<FingerprintMismatch>,
    },
    NoMatch,
}

/// What specifically mismatched.
#[derive(Debug, Clone)]
pub enum FingerprintMismatch {
    TextChanged {
        expected: String,
        actual: String,
    },
    BoundsMoved {
        delta_x: i32,
        delta_y: i32,
    },
    StateChanged {
        expected: String,
        actual: String,
    },
    AncestorChanged,
    ResourceIdMissing,
}

/// Error from TOCTOU verification.
#[derive(Debug, Clone)]
pub enum TocTouError {
    TargetNotFound,
    FingerprintMismatch {
        planned: NodeFingerprint,
        actual: NodeFingerprint,
        comparison: FingerprintMatch,
    },
    TreeUnavailable,
    SecureWindow,
}

impl FingerprintMismatch {
    /// A mismatch is cosmetic if it wouldn't change the action's effect.
    pub fn is_cosmetic(&self) -> bool {
        match self {
            FingerprintMismatch::BoundsMoved { delta_x, delta_y } => {
                // Small position changes are cosmetic (e.g., scroll adjustment)
                delta_x.abs() < 50 && delta_y.abs() < 50
            }
            FingerprintMismatch::StateChanged { .. } => false,
            FingerprintMismatch::TextChanged { .. } => false,
            FingerprintMismatch::AncestorChanged => false,
            FingerprintMismatch::ResourceIdMissing => false,
        }
    }
}

impl NodeFingerprint {
    /// Compare this fingerprint against another.
    pub fn compare(&self, other: &NodeFingerprint) -> FingerprintMatch {
        // Package and window must match for any comparison
        if self.package != other.package || self.window_id != other.window_id {
            return FingerprintMatch::NoMatch;
        }

        // Resource ID must match if both present
        if self.resource_id.is_some()
            && other.resource_id.is_some()
            && self.resource_id != other.resource_id
        {
            return FingerprintMatch::NoMatch;
        }

        // Class name must match
        if self.class_name != other.class_name {
            return FingerprintMatch::NoMatch;
        }

        // Collect mismatches
        let mut mismatches = Vec::new();

        if self.resource_id.is_some() && other.resource_id.is_none() {
            mismatches.push(FingerprintMismatch::ResourceIdMissing);
        }

        if self.normalized_text != other.normalized_text {
            mismatches.push(FingerprintMismatch::TextChanged {
                expected: self
                    .normalized_text
                    .clone()
                    .unwrap_or_default(),
                actual: other
                    .normalized_text
                    .clone()
                    .unwrap_or_default(),
            });
        }

        if self.state != other.state {
            if let (Some(expected), Some(actual)) = (&self.state, &other.state) {
                mismatches.push(FingerprintMismatch::StateChanged {
                    expected: expected.clone(),
                    actual: actual.clone(),
                });
            }
        }

        if self.ancestor_signature != other.ancestor_signature {
            mismatches.push(FingerprintMismatch::AncestorChanged);
        }

        let dx = other.approximate_bounds.left - self.approximate_bounds.left;
        let dy = other.approximate_bounds.top - self.approximate_bounds.top;
        if dx != 0 || dy != 0 {
            mismatches.push(FingerprintMismatch::BoundsMoved {
                delta_x: dx,
                delta_y: dy,
            });
        }

        if mismatches.is_empty() {
            FingerprintMatch::Exact
        } else {
            FingerprintMatch::Partial { mismatches }
        }
    }
}

/// Policy: what FingerprintMatch is acceptable per risk level?
/// High risk requires Exact — no partial allowed.
pub fn acceptable_match(risk: RiskLevel, m: &FingerprintMatch) -> bool {
    match (risk, m) {
        (_, FingerprintMatch::Exact) => true,
        (_, FingerprintMatch::NoMatch) => false,
        // High risk: require Exact — no partial allowed
        (
            RiskLevel::Financial | RiskLevel::Destructive | RiskLevel::Communication,
            FingerprintMatch::Partial { .. },
        ) => false,
        // Lower risk: partial OK if mismatches are cosmetic
        (_, FingerprintMatch::Partial { mismatches }) => {
            mismatches.iter().all(|m| m.is_cosmetic())
        }
    }
}
