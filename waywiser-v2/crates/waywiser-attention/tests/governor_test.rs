use pi_types::AttentionDecision;
use waywiser_attention::{
    AttentionGovernor, AttentionPolicy, AttentionRule, AttentionSignal, AttentionSource,
    EdgeHint, SystemChannel,
};

fn default_governor() -> AttentionGovernor {
    AttentionGovernor::new(AttentionPolicy::default())
}

fn signal(source: AttentionSource) -> AttentionSignal {
    AttentionSignal {
        source,
        content: "test".to_string(),
        android_priority: None,
    }
}

fn signal_with_priority(source: AttentionSource, priority: i32) -> AttentionSignal {
    AttentionSignal {
        source,
        content: "test".to_string(),
        android_priority: Some(priority),
    }
}

// ── Hardcoded floor enforcement ──

#[test]
fn test_family_contact_floor_notify() {
    let gov = default_governor();
    let sig = signal(AttentionSource::ContactGroup("family".to_string()));
    let result = gov.evaluate(&sig, None);
    // Family contacts have hardcoded floor of Notify
    assert!(
        result.decision >= AttentionDecision::Notify,
        "family floor should be at least Notify, got {:?}",
        result.decision
    );
    assert_eq!(result.floor_applied, Some(AttentionDecision::Notify));
}

#[test]
fn test_important_contact_floor_notify() {
    let gov = default_governor();
    let sig = signal(AttentionSource::ContactGroup("important".to_string()));
    let result = gov.evaluate(&sig, None);
    assert!(result.decision >= AttentionDecision::Notify);
    assert_eq!(result.floor_applied, Some(AttentionDecision::Notify));
}

#[test]
fn test_vip_contact_floor_notify() {
    let gov = default_governor();
    let sig = signal(AttentionSource::ContactGroup("VIP".to_string()));
    let result = gov.evaluate(&sig, None);
    assert!(result.decision >= AttentionDecision::Notify);
}

#[test]
fn test_alarm_floor_headsup() {
    let gov = default_governor();
    let sig = signal(AttentionSource::SystemChannel(SystemChannel::AlarmClock));
    let result = gov.evaluate(&sig, None);
    assert!(
        result.decision >= AttentionDecision::HeadsUp,
        "alarm floor should be at least HeadsUp, got {:?}",
        result.decision
    );
    assert_eq!(result.floor_applied, Some(AttentionDecision::HeadsUp));
}

#[test]
fn test_incoming_call_floor_headsup() {
    let gov = default_governor();
    let sig = signal(AttentionSource::SystemChannel(SystemChannel::IncomingCall));
    let result = gov.evaluate(&sig, None);
    assert!(result.decision >= AttentionDecision::HeadsUp);
}

#[test]
fn test_security_alert_floor_notify() {
    let gov = default_governor();
    let sig = signal(AttentionSource::SystemChannel(SystemChannel::SecurityAlert));
    let result = gov.evaluate(&sig, None);
    assert!(result.decision >= AttentionDecision::Notify);
}

// ── Floor enforcement even with DROP edge hint ──

#[test]
fn test_family_floor_survives_drop_hint() {
    let gov = default_governor();
    let sig = signal(AttentionSource::ContactGroup("family".to_string()));
    let hint = EdgeHint::new(AttentionDecision::Drop, 0.99); // very high confidence DROP
    let result = gov.evaluate(&sig, Some(&hint));

    // Even with a 0.99 confidence DROP hint, family floor holds
    assert!(
        result.decision >= AttentionDecision::Notify,
        "family floor must survive even 0.99 confidence DROP, got {:?}",
        result.decision
    );
}

#[test]
fn test_alarm_floor_survives_drop_hint() {
    let gov = default_governor();
    let sig = signal(AttentionSource::SystemChannel(SystemChannel::AlarmClock));
    let hint = EdgeHint::new(AttentionDecision::Drop, 0.99);
    let result = gov.evaluate(&sig, Some(&hint));

    assert!(
        result.decision >= AttentionDecision::HeadsUp,
        "alarm floor must survive even 0.99 confidence DROP, got {:?}",
        result.decision
    );
}

// ── Configurable rules ──

#[test]
fn test_configurable_ceiling() {
    let policy = AttentionPolicy {
        rules: vec![AttentionRule {
            source: AttentionSource::AppPackage("com.ci.bot".to_string()),
            floor: None,
            ceiling: Some(AttentionDecision::Notify), // max Notify for CI bot
            priority: 0,
        }],
        ..AttentionPolicy::default()
    };
    let gov = AttentionGovernor::new(policy);

    // Even with high Android priority, CI bot is capped at Notify
    let sig = signal_with_priority(
        AttentionSource::AppPackage("com.ci.bot".to_string()),
        5, // IMPORTANCE_HIGH → normally HeadsUp
    );
    let result = gov.evaluate(&sig, None);
    assert!(
        result.decision <= AttentionDecision::Notify,
        "CI bot should be capped at Notify, got {:?}",
        result.decision
    );
    assert_eq!(result.ceiling_applied, Some(AttentionDecision::Notify));
}

#[test]
fn test_configurable_floor() {
    let policy = AttentionPolicy {
        rules: vec![AttentionRule {
            source: AttentionSource::Contact("boss-id".to_string()),
            floor: Some(AttentionDecision::HeadsUp),
            ceiling: None,
            priority: 0,
        }],
        ..AttentionPolicy::default()
    };
    let gov = AttentionGovernor::new(policy);

    let sig = signal_with_priority(
        AttentionSource::Contact("boss-id".to_string()),
        1, // low priority
    );
    let result = gov.evaluate(&sig, None);
    assert!(result.decision >= AttentionDecision::HeadsUp);
}

// ── Default decision ──

#[test]
fn test_default_decision_for_unknown_source() {
    let gov = default_governor();
    let sig = signal(AttentionSource::AppPackage("com.unknown.app".to_string()));
    let result = gov.evaluate(&sig, None);
    // No floor, no ceiling, no Android priority → default (Silent)
    assert_eq!(result.decision, AttentionDecision::Silent);
    assert_eq!(result.floor_applied, None);
    assert_eq!(result.ceiling_applied, None);
}

#[test]
fn test_android_priority_high_maps_to_headsup() {
    let gov = default_governor();
    let sig = signal_with_priority(
        AttentionSource::AppPackage("com.some.app".to_string()),
        5,
    );
    let result = gov.evaluate(&sig, None);
    assert_eq!(result.decision, AttentionDecision::HeadsUp);
}

#[test]
fn test_android_priority_low_maps_to_silent() {
    let gov = default_governor();
    let sig = signal_with_priority(
        AttentionSource::AppPackage("com.some.app".to_string()),
        1,
    );
    let result = gov.evaluate(&sig, None);
    assert_eq!(result.decision, AttentionDecision::Silent);
}
