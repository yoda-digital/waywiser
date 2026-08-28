//! Post-Action Verification (blueprint §25).
//!
//! Significant UI actions require observation afterward.
//! UNEXPECTED halts all further side effects in the current action sequence.

use serde::{Deserialize, Serialize};

use pi_types::VerificationStatus;

/// Expected outcome of a UI action, defined at planning time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedTransition {
    /// Package expected after the action.
    pub expected_package: Option<String>,
    /// Window/activity expected.
    pub expected_window: Option<String>,
    /// Nodes/indicators that should appear.
    pub expected_indicators: Vec<TransitionIndicator>,
    /// Resource IDs that should disappear.
    pub expected_removals: Vec<String>,
    /// Max time to wait for transition (milliseconds).
    pub verification_timeout_ms: u64,
}

/// An indicator that a transition occurred.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionIndicator {
    pub kind: IndicatorKind,
    pub text: Option<String>,
}

/// Kind of transition indicator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IndicatorKind {
    Toast,
    Dialog,
    ActivityChange,
    ViewAppeared,
    ViewDisappeared,
}

/// Verify after action using indicator and removal counts.
///
/// - ratio >= 0.8 → Verified
/// - ratio >= 0.4 → Likely
/// - ratio < 0.4  → Unexpected (HALT further side effects)
/// - no checks defined → Unknown
pub fn evaluate_transition(
    indicators_found: usize,
    total_indicators: usize,
    removals_confirmed: usize,
    total_removals: usize,
) -> VerificationStatus {
    let total_checks = total_indicators + total_removals;
    if total_checks == 0 {
        return VerificationStatus::Unknown;
    }

    let passed = indicators_found + removals_confirmed;
    let ratio = passed as f64 / total_checks as f64;

    if ratio >= 0.8 {
        VerificationStatus::Verified
    } else if ratio >= 0.4 {
        VerificationStatus::Likely
    } else {
        VerificationStatus::Unexpected
    }
}

impl ExpectedTransition {
    /// Create a transition expectation with no checks (results in Unknown).
    pub fn none() -> Self {
        Self {
            expected_package: None,
            expected_window: None,
            expected_indicators: Vec::new(),
            expected_removals: Vec::new(),
            verification_timeout_ms: 500,
        }
    }

    /// Create a transition expecting a toast message.
    pub fn expect_toast(text: impl Into<String>) -> Self {
        Self {
            expected_package: None,
            expected_window: None,
            expected_indicators: vec![TransitionIndicator {
                kind: IndicatorKind::Toast,
                text: Some(text.into()),
            }],
            expected_removals: Vec::new(),
            verification_timeout_ms: 500,
        }
    }
}
