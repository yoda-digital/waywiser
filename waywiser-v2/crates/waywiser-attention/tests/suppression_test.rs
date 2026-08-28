//! Tests for suppression asymmetry: escalation is easy, suppression is hard.
//!
//! Key properties:
//! 1. Escalation at LOW confidence threshold (default 0.3)
//! 2. Suppression at HIGH confidence threshold (default 0.85)
//! 3. Suppression can NEVER go below a hardcoded floor
//! 4. Suppression can NEVER go below a configurable floor

use pi_types::AttentionDecision;
use waywiser_attention::{
    AttentionGovernor, AttentionPolicy, AttentionRule, AttentionSignal, AttentionSource,
    EdgeHint,
};

fn governor_with_thresholds(escalation: f32, suppression: f32) -> AttentionGovernor {
    AttentionGovernor::new(AttentionPolicy {
        rules: Vec::new(),
        default_decision: AttentionDecision::Silent,
        suppression_threshold: suppression,
        escalation_threshold: escalation,
    })
}

fn signal_with_priority(priority: i32) -> AttentionSignal {
    AttentionSignal {
        source: AttentionSource::AppPackage("com.test".to_string()),
        content: "test".to_string(),
        android_priority: Some(priority),
    }
}

// ── Escalation tests ──

#[test]
fn test_escalation_at_low_confidence() {
    let gov = governor_with_thresholds(0.3, 0.85);

    // Base: low priority (Silent via Android priority 1)
    let sig = signal_with_priority(1); // → Silent
    let hint = EdgeHint::new(AttentionDecision::HeadsUp, 0.35); // just above escalation threshold

    let result = gov.evaluate(&sig, Some(&hint));
    assert_eq!(
        result.decision,
        AttentionDecision::HeadsUp,
        "escalation should succeed at confidence 0.35 (threshold 0.3)"
    );
}

#[test]
fn test_escalation_below_threshold_rejected() {
    let gov = governor_with_thresholds(0.3, 0.85);

    let sig = signal_with_priority(1); // → Silent
    let hint = EdgeHint::new(AttentionDecision::HeadsUp, 0.2); // below escalation threshold

    let result = gov.evaluate(&sig, Some(&hint));
    assert_eq!(
        result.decision,
        AttentionDecision::Silent,
        "escalation should fail at confidence 0.2 (threshold 0.3)"
    );
}

// ── Suppression tests ──

#[test]
fn test_suppression_at_high_confidence() {
    let gov = governor_with_thresholds(0.3, 0.85);

    // Base: high priority (HeadsUp via Android priority 5)
    let sig = signal_with_priority(5); // → HeadsUp
    let hint = EdgeHint::new(AttentionDecision::Silent, 0.9); // above suppression threshold

    let result = gov.evaluate(&sig, Some(&hint));
    assert_eq!(
        result.decision,
        AttentionDecision::Silent,
        "suppression should succeed at confidence 0.9 (threshold 0.85)"
    );
}

#[test]
fn test_suppression_below_threshold_rejected() {
    let gov = governor_with_thresholds(0.3, 0.85);

    let sig = signal_with_priority(5); // → HeadsUp
    let hint = EdgeHint::new(AttentionDecision::Silent, 0.7); // below suppression threshold

    let result = gov.evaluate(&sig, Some(&hint));
    assert_eq!(
        result.decision,
        AttentionDecision::HeadsUp,
        "suppression should fail at confidence 0.7 (threshold 0.85)"
    );
}

#[test]
fn test_suppression_moderate_confidence_rejected() {
    let gov = governor_with_thresholds(0.3, 0.85);

    let sig = signal_with_priority(3); // → Notify
    let hint = EdgeHint::new(AttentionDecision::Batch, 0.5); // moderate confidence

    let result = gov.evaluate(&sig, Some(&hint));
    assert_eq!(
        result.decision,
        AttentionDecision::Notify,
        "suppression should fail at confidence 0.5 (threshold 0.85)"
    );
}

// ── Suppression blocked by floor ──

#[test]
fn test_suppression_blocked_by_hardcoded_floor() {
    let gov = governor_with_thresholds(0.3, 0.85);

    // Family contact has hardcoded floor = Notify
    let sig = AttentionSignal {
        source: AttentionSource::ContactGroup("family".to_string()),
        content: "test".to_string(),
        android_priority: Some(3), // → Notify base
    };
    // Try to suppress to Drop with very high confidence
    let hint = EdgeHint::new(AttentionDecision::Drop, 0.99);

    let result = gov.evaluate(&sig, Some(&hint));
    assert!(
        result.decision >= AttentionDecision::Notify,
        "suppression must be blocked by family floor (Notify), got {:?}",
        result.decision
    );
}

#[test]
fn test_suppression_blocked_by_configurable_floor() {
    let policy = AttentionPolicy {
        rules: vec![AttentionRule {
            source: AttentionSource::Contact("important-person".to_string()),
            floor: Some(AttentionDecision::Notify),
            ceiling: None,
            priority: 0,
        }],
        default_decision: AttentionDecision::Silent,
        suppression_threshold: 0.85,
        escalation_threshold: 0.3,
    };
    let gov = AttentionGovernor::new(policy);

    let sig = AttentionSignal {
        source: AttentionSource::Contact("important-person".to_string()),
        content: "test".to_string(),
        android_priority: Some(3), // → Notify base
    };
    let hint = EdgeHint::new(AttentionDecision::Drop, 0.95);

    let result = gov.evaluate(&sig, Some(&hint));
    assert!(
        result.decision >= AttentionDecision::Notify,
        "suppression blocked by configurable floor, got {:?}",
        result.decision
    );
}

// ── Asymmetry property ──

#[test]
fn test_asymmetry_same_confidence_different_outcomes() {
    let gov = governor_with_thresholds(0.3, 0.85);

    // At confidence 0.5:
    // - Escalation (threshold 0.3): should SUCCEED
    // - Suppression (threshold 0.85): should FAIL

    // Escalation case: base Silent, hint HeadsUp, confidence 0.5
    let sig_low = signal_with_priority(1); // → Silent
    let escalation_hint = EdgeHint::new(AttentionDecision::HeadsUp, 0.5);
    let escalation_result = gov.evaluate(&sig_low, Some(&escalation_hint));

    // Suppression case: base HeadsUp, hint Silent, confidence 0.5
    let sig_high = signal_with_priority(5); // → HeadsUp
    let suppression_hint = EdgeHint::new(AttentionDecision::Silent, 0.5);
    let suppression_result = gov.evaluate(&sig_high, Some(&suppression_hint));

    assert_eq!(
        escalation_result.decision,
        AttentionDecision::HeadsUp,
        "escalation should succeed at 0.5"
    );
    assert_eq!(
        suppression_result.decision,
        AttentionDecision::HeadsUp,
        "suppression should fail at 0.5"
    );
}

// ── No change when hint matches base ──

#[test]
fn test_hint_same_as_base_no_change() {
    let gov = governor_with_thresholds(0.3, 0.85);

    let sig = signal_with_priority(3); // → Notify
    let hint = EdgeHint::new(AttentionDecision::Notify, 0.5);

    let result = gov.evaluate(&sig, Some(&hint));
    assert_eq!(result.decision, AttentionDecision::Notify);
}

// ── No hint → base decision only ──

#[test]
fn test_no_hint_uses_base() {
    let gov = governor_with_thresholds(0.3, 0.85);
    let sig = signal_with_priority(3);

    let result = gov.evaluate(&sig, None);
    assert_eq!(result.decision, AttentionDecision::Notify);
    assert_eq!(result.edge_hint_effect, None);
}
