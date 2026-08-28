use chrono::Utc;
use pi_types::{Observation, ObservationKind, ObservationSource, RetentionClass, Sensitivity};
use uuid::Uuid;
use waywiser_proactive::*;

fn calendar_conflict_observation() -> Observation {
    Observation {
        id: Uuid::now_v7(),
        kind: ObservationKind::CalendarEvent,
        subject: "calendar".to_string(),
        value: serde_json::json!({
            "conflict": true,
            "event_a": "Team meeting",
            "event_b": "Dentist",
            "overlap_minutes": 30
        }),
        source: ObservationSource::Android,
        source_id: None,
        confidence: 1.0,
        observed_at: Utc::now(),
        expires_at: None,
        sensitivity: Sensitivity::Internal,
        retention: RetentionClass::Session,
        consent_scope: None,
    }
}

fn deadline_observation(minutes: u64) -> Observation {
    Observation {
        id: Uuid::now_v7(),
        kind: ObservationKind::Custom("deadline".to_string()),
        subject: "work".to_string(),
        value: serde_json::json!({
            "deadline_minutes": minutes
        }),
        source: ObservationSource::Android,
        source_id: None,
        confidence: 1.0,
        observed_at: Utc::now(),
        expires_at: None,
        sensitivity: Sensitivity::Internal,
        retention: RetentionClass::Session,
        consent_scope: None,
    }
}

fn irrelevant_observation() -> Observation {
    Observation {
        id: Uuid::now_v7(),
        kind: ObservationKind::DeviceState,
        subject: "battery".to_string(),
        value: serde_json::json!({"level": 85}),
        source: ObservationSource::Android,
        source_id: None,
        confidence: 1.0,
        observed_at: Utc::now(),
        expires_at: None,
        sensitivity: Sensitivity::Public,
        retention: RetentionClass::Ephemeral,
        consent_scope: None,
    }
}

#[test]
fn ooda_cycle_calendar_conflict() {
    let mut service = ProactiveService::with_defaults();
    let obs = calendar_conflict_observation();

    // Observe
    let signal = service.observe(&obs).unwrap();
    assert!(signal.assessed_importance >= 0.9);

    // Orient
    let oriented = service.orient(&signal);
    assert!(matches!(oriented, OrientResult::Actionable { urgency: Urgency::Immediate, .. }));

    // Decide
    let decision = service.decide(&oriented);
    assert!(matches!(decision, ProactiveDecision::NotifyImmediately { .. }));
}

#[test]
fn ooda_cycle_deferred_deadline() {
    let mut service = ProactiveService::with_defaults();
    let obs = deadline_observation(45); // 45 minutes away → deferred

    let signal = service.observe(&obs).unwrap();
    let oriented = service.orient(&signal);
    let decision = service.decide(&oriented);
    assert!(matches!(decision, ProactiveDecision::DeferReasoning { .. }));
}

#[test]
fn ooda_cycle_urgent_deadline() {
    let mut service = ProactiveService::with_defaults();
    let obs = deadline_observation(10); // 10 minutes away → immediate

    let signal = service.observe(&obs).unwrap();
    let oriented = service.orient(&signal);
    let decision = service.decide(&oriented);
    assert!(matches!(decision, ProactiveDecision::NotifyImmediately { .. }));
}

#[test]
fn irrelevant_observation_produces_no_signal() {
    let mut service = ProactiveService::with_defaults();
    let obs = irrelevant_observation();
    assert!(service.observe(&obs).is_none());
}

#[test]
fn rate_limiting_blocks_excess_actions() {
    let mut service = ProactiveService::new(ProactiveConfig {
        max_actions_per_hour: 3,
        ..ProactiveConfig::default()
    });

    // Act 3 times successfully
    for _ in 0..3 {
        let obs = calendar_conflict_observation();
        let decision = service.process_observation(&obs).unwrap();
        assert!(!matches!(decision, ProactiveDecision::RateLimited { .. }));
    }

    // 4th action should be rate limited
    let obs = calendar_conflict_observation();
    let decision = service.process_observation(&obs).unwrap();
    assert!(matches!(decision, ProactiveDecision::RateLimited { .. }));
}

#[test]
fn below_threshold_drops() {
    let mut service = ProactiveService::new(ProactiveConfig {
        min_signal_confidence: 0.95,
        ..ProactiveConfig::default()
    });

    // Deadline at 45 min → importance 0.8, below 0.95 threshold
    let obs = deadline_observation(45);
    let signal = service.observe(&obs).unwrap();
    let oriented = service.orient(&signal);
    assert!(matches!(oriented, OrientResult::BelowThreshold { .. }));
}

#[test]
fn process_deferred_returns_ready_jobs() {
    let mut service = ProactiveService::with_defaults();

    // Create some deferred jobs
    let obs = deadline_observation(45);
    service.process_observation(&obs);

    let ready = service.process_deferred();
    assert_eq!(ready.len(), 1);
}

#[test]
fn full_ooda_with_act() {
    let mut service = ProactiveService::with_defaults();
    let obs = calendar_conflict_observation();

    let signal = service.observe(&obs).unwrap();
    let oriented = service.orient(&signal);
    let decision = service.decide(&oriented);
    let result = service.act(decision);
    assert!(result.is_ok());
}
