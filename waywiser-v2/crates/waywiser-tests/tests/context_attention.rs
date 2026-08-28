//! Integration test: Context Graph + Attention Governor (P2 acceptance criteria).

use chrono::{Duration, Utc};
use pi_types::attention::AttentionDecision;
use pi_types::observation::ObservationSource;
use waywiser_attention::governor::{AttentionGovernor, AttentionPolicy};
use waywiser_attention::hint::EdgeHint;
use waywiser_attention::rules::{AttentionRule, AttentionSignal, AttentionSource, SystemChannel};
use waywiser_context::domains::*;
use waywiser_context::graph::{ContextGraph, ContextNode};
use waywiser_context::projection::{ProjectionEngine, TaskType};

#[test]
fn context_graph_reflects_multiple_domains() {
    let mut graph = ContextGraph::new();

    graph.update("user.activity", ContextNode {
        domain: ContextDomain::User(UserContext {
            activity: Some(ActivityState::Walking),
            ..UserContext::empty()
        }),
        updated_at: Utc::now(),
        expires_at: Some(Utc::now() + Duration::minutes(5)),
        source: ObservationSource::Android,
    });

    graph.update("user.audio", ContextNode {
        domain: ContextDomain::User(UserContext {
            audio_route: Some(AudioRoute::Headphones),
            ..UserContext::empty()
        }),
        updated_at: Utc::now(),
        expires_at: None,
        source: ObservationSource::Android,
    });

    graph.update("user.next_event", ContextNode {
        domain: ContextDomain::User(UserContext {
            next_event: Some(UpcomingEvent {
                title: "Team standup".into(),
                start: Utc::now() + Duration::minutes(18),
                minutes_until: 18,
            }),
            ..UserContext::empty()
        }),
        updated_at: Utc::now(),
        expires_at: Some(Utc::now() + Duration::minutes(18)),
        source: ObservationSource::Android,
    });

    graph.update("device", ContextNode {
        domain: ContextDomain::Device(DeviceContext {
            battery_pct: 72,
            charging: false,
            network: NetworkState::Cellular,
            thermal: ThermalState::Nominal,
            screen: ScreenState::On,
        }),
        updated_at: Utc::now(),
        expires_at: Some(Utc::now() + Duration::minutes(10)),
        source: ObservationSource::Android,
    });

    assert_eq!(graph.len(), 4);
    assert!(graph.has_node("user.activity"));
    assert!(graph.has_node("user.audio"));
    assert!(graph.has_node("user.next_event"));
    assert!(graph.has_node("device"));
}

#[test]
fn projection_enforces_budget() {
    let mut graph = ContextGraph::new();
    for i in 0..20 {
        graph.update(&format!("device.sensor_{}", i), ContextNode {
            domain: ContextDomain::Device(DeviceContext::default_state()),
            updated_at: Utc::now(),
            expires_at: None,
            source: ObservationSource::Android,
        });
    }

    let snapshot = graph.snapshot();
    let engine = ProjectionEngine::new();

    let projection = engine.project(&snapshot, "how's the weather?", TaskType::SimpleChat, 2000);
    assert!(projection.tokens_used <= 2000,
        "SimpleChat should stay within 2000 tokens, got {}", projection.tokens_used);

    let projection = engine.project(&snapshot, "check battery", TaskType::ToolCall, 4000);
    assert!(projection.tokens_used <= 4000,
        "ToolCall should stay within 4000 tokens, got {}", projection.tokens_used);
}

#[test]
fn context_graph_temporal_decay() {
    let mut graph = ContextGraph::new();

    graph.update("user.activity", ContextNode {
        domain: ContextDomain::User(UserContext {
            activity: Some(ActivityState::Walking),
            ..UserContext::empty()
        }),
        updated_at: Utc::now() - Duration::minutes(10),
        expires_at: Some(Utc::now() - Duration::seconds(1)),
        source: ObservationSource::Android,
    });

    graph.update("device", ContextNode {
        domain: ContextDomain::Device(DeviceContext::default_state()),
        updated_at: Utc::now(),
        expires_at: None,
        source: ObservationSource::Android,
    });

    assert_eq!(graph.len(), 2);
    let removed = graph.remove_expired(Utc::now());
    assert_eq!(removed, 1);
    assert_eq!(graph.len(), 1);
    assert!(!graph.has_node("user.activity"));
    assert!(graph.has_node("device"));
}

fn default_governor() -> AttentionGovernor {
    AttentionGovernor::new(AttentionPolicy {
        rules: vec![
            AttentionRule {
                source: AttentionSource::AppPackage("com.ci.bot".into()),
                floor: None,
                ceiling: Some(AttentionDecision::Notify),
                priority: 10,
            },
        ],
        default_decision: AttentionDecision::Batch,
        suppression_threshold: 0.85,
        escalation_threshold: 0.3,
    })
}

#[test]
fn important_contact_floor_overrides_drop_hint() {
    let governor = default_governor();
    let signal = AttentionSignal {
        source: AttentionSource::ContactGroup("important".into()),
        content: "Message from VIP".into(),
        android_priority: Some(0),
    };
    let hint = EdgeHint::new(AttentionDecision::Drop, 0.99);
    let result = governor.evaluate(&signal, Some(&hint));

    assert!(result.decision >= AttentionDecision::Notify,
        "important contact floor should enforce Notify, got: {:?}", result.decision);
}

#[test]
fn family_contact_floor_enforced() {
    let governor = default_governor();
    let signal = AttentionSignal {
        source: AttentionSource::ContactGroup("family".into()),
        content: "Message from family".into(),
        android_priority: Some(0),
    };
    let hint = EdgeHint::new(AttentionDecision::Drop, 0.99);
    let result = governor.evaluate(&signal, Some(&hint));

    assert!(result.decision >= AttentionDecision::Notify,
        "family floor should enforce Notify, got: {:?}", result.decision);
}

#[test]
fn alarm_channel_floor_enforced() {
    let governor = default_governor();
    let signal = AttentionSignal {
        source: AttentionSource::SystemChannel(SystemChannel::AlarmClock),
        content: "Alarm".into(),
        android_priority: Some(0),
    };
    let result = governor.evaluate(&signal, None);

    assert!(result.decision >= AttentionDecision::HeadsUp,
        "alarm floor should enforce HeadsUp, got: {:?}", result.decision);
}

#[test]
fn suppression_asymmetry() {
    let governor = default_governor();
    let signal = AttentionSignal {
        source: AttentionSource::AppPackage("com.example.app".into()),
        content: "Regular notification".into(),
        android_priority: Some(2),
    };

    let base_result = governor.evaluate(&signal, None);
    let base = base_result.decision;

    let escalate_hint = EdgeHint::new(AttentionDecision::Voice, 0.5);
    let escalated = governor.evaluate(&signal, Some(&escalate_hint));

    let suppress_hint = EdgeHint::new(AttentionDecision::Drop, 0.5);
    let suppressed = governor.evaluate(&signal, Some(&suppress_hint));

    assert!(escalated.decision >= base,
        "escalation at 0.5 should work: base={:?}, escalated={:?}", base, escalated.decision);
    assert!(suppressed.decision >= base,
        "suppression at 0.5 should NOT work: base={:?}, suppressed={:?}", base, suppressed.decision);
}

#[test]
fn ceiling_enforced_for_ci_bot() {
    let governor = default_governor();
    let signal = AttentionSignal {
        source: AttentionSource::AppPackage("com.ci.bot".into()),
        content: "Build failed".into(),
        android_priority: Some(4),
    };
    let hint = EdgeHint::new(AttentionDecision::Urgent, 0.99);
    let result = governor.evaluate(&signal, Some(&hint));

    assert!(result.decision <= AttentionDecision::Notify,
        "CI bot should be capped at Notify, got: {:?}", result.decision);
}
