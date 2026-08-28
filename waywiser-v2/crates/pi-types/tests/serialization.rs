//! Round-trip JSON serialization tests for all major types.

use chrono::Utc;
use pi_types::*;
use serde_json;
use uuid::Uuid;

#[test]
fn observation_round_trip() {
    let obs = Observation::new(
        ObservationKind::DeviceState,
        "battery",
        serde_json::json!({"level": 42}),
    );
    let json = serde_json::to_string(&obs).expect("serialize");
    let deser: Observation = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deser.id, obs.id);
    assert_eq!(deser.subject, "battery");
    assert_eq!(deser.confidence, 1.0);
}

#[test]
fn action_intent_round_trip() {
    let intent = ActionIntent::new(
        ActionOrigin::UserDirect,
        CapabilityName::new("calendar.read"),
        serde_json::json!({"date": "2026-08-28"}),
        "User wants to see today's events",
        SessionId::new(),
    );
    let json = serde_json::to_string(&intent).expect("serialize");
    let deser: ActionIntent = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deser.id, intent.id);
    assert_eq!(deser.capability.as_str(), "calendar.read");
    assert_eq!(deser.reason, "User wants to see today's events");
}

#[test]
fn action_receipt_round_trip() {
    let receipt = ActionReceipt {
        intent_id: Uuid::now_v7(),
        capability: CapabilityName::new("calendar.update"),
        started_at: Utc::now(),
        completed_at: Some(Utc::now()),
        status: ActionStatus::Completed,
        external_reference: Some("cal-event-123".to_string()),
        reversible: true,
        undo_token: Some("undo-abc".to_string()),
        verification: VerificationStatus::Verified,
        result_summary: Some("Moved dentist to Thursday".to_string()),
    };
    let json = serde_json::to_string(&receipt).expect("serialize");
    let deser: ActionReceipt = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deser.intent_id, receipt.intent_id);
    assert!(deser.reversible);
    assert_eq!(deser.verification, VerificationStatus::Verified);
}

#[test]
fn action_receipt_denied() {
    let intent = ActionIntent::new(
        ActionOrigin::UserDirect,
        CapabilityName::new("unknown.cap"),
        serde_json::json!({}),
        "test",
        SessionId::new(),
    );
    let receipt = ActionReceipt::denied(&intent, Utc::now(), "unknown capability");
    let json = serde_json::to_string(&receipt).expect("serialize");
    let deser: ActionReceipt = serde_json::from_str(&json).expect("deserialize");
    assert!(matches!(deser.status, ActionStatus::Failed { .. }));
}

#[test]
fn session_state_round_trip() {
    let session = SessionState::new();
    let json = serde_json::to_string(&session).expect("serialize");
    let deser: SessionState = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deser.id, session.id);
    assert_eq!(deser.lanes.len(), 1);
    assert_eq!(deser.active_lane_id, session.active_lane_id);
}

#[test]
fn agent_message_user_round_trip() {
    let msg = AgentMessage::User(UserMessage {
        id: EntryId::new(),
        content: MessageContent::Text("Hello, Waywiser!".to_string()),
        timestamp: Utc::now(),
    });
    let json = serde_json::to_string(&msg).expect("serialize");
    let deser: AgentMessage = serde_json::from_str(&json).expect("deserialize");
    if let AgentMessage::User(u) = deser {
        assert_eq!(u.content.as_text(), "Hello, Waywiser!");
    } else {
        panic!("expected User variant");
    }
}

#[test]
fn agent_message_assistant_round_trip() {
    let msg = AgentMessage::Assistant(AssistantMessage {
        id: EntryId::new(),
        content: MessageContent::Text("I'll check your calendar.".to_string()),
        tool_calls: vec![ToolCall {
            id: "tc-1".to_string(),
            name: "calendar.read".to_string(),
            arguments: serde_json::json!({"date": "today"}),
        }],
        thinking: Some("User wants calendar info".to_string()),
        usage: TokenUsage {
            prompt_tokens: 100,
            completion_tokens: 50,
            thinking_tokens: 30,
        },
        timestamp: Utc::now(),
    });
    let json = serde_json::to_string(&msg).expect("serialize");
    let deser: AgentMessage = serde_json::from_str(&json).expect("deserialize");
    if let AgentMessage::Assistant(a) = deser {
        assert_eq!(a.tool_calls.len(), 1);
        assert_eq!(a.tool_calls[0].name, "calendar.read");
        assert_eq!(a.usage.prompt_tokens, 100);
    } else {
        panic!("expected Assistant variant");
    }
}

#[test]
fn risk_level_ordering() {
    assert!(RiskLevel::None < RiskLevel::ReadPersonal);
    assert!(RiskLevel::ReadPersonal < RiskLevel::DeviceControl);
    assert!(RiskLevel::DeviceControl < RiskLevel::CrossAppWrite);
    assert!(RiskLevel::CrossAppWrite < RiskLevel::Communication);
    assert!(RiskLevel::Communication < RiskLevel::Financial);
    assert!(RiskLevel::Financial < RiskLevel::Destructive);
    assert!(RiskLevel::Destructive < RiskLevel::UiUnclassifiedWrite);
}

#[test]
fn attention_decision_ordering() {
    assert!(AttentionDecision::Drop < AttentionDecision::Batch);
    assert!(AttentionDecision::Batch < AttentionDecision::Silent);
    assert!(AttentionDecision::Silent < AttentionDecision::Notify);
    assert!(AttentionDecision::Notify < AttentionDecision::HeadsUp);
    assert!(AttentionDecision::HeadsUp < AttentionDecision::Voice);
    assert!(AttentionDecision::Voice < AttentionDecision::Urgent);
}

#[test]
fn memory_record_round_trip() {
    let record = MemoryRecord {
        id: Uuid::now_v7(),
        content: "User prefers morning flights".to_string(),
        scope: "travel".to_string(),
        provenance: Provenance {
            source: ProvenanceSource::UserExplicit,
            session_id: Some(SessionId::new()),
            created_at: Utc::now(),
            confidence_ceiling: 0.9,
        },
        confidence: 0.85,
        usage_count: 3,
        last_recalled: Some(Utc::now()),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    let json = serde_json::to_string(&record).expect("serialize");
    let deser: MemoryRecord = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deser.content, "User prefers morning flights");
    assert_eq!(deser.provenance.confidence_ceiling, 0.9);
}

#[test]
fn capability_spec_round_trip() {
    let spec = CapabilitySpec {
        name: CapabilityName::new("calendar.read"),
        description: "Read calendar events".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
        output_schema: serde_json::json!({"type": "array"}),
        risk: RiskLevel::ReadPersonal,
        permissions: vec!["android.permission.READ_CALENDAR".to_string()],
        side_effect: false,
        replay_policy: ReplayPolicy::SafeReplay,
        execution_mode: ExecutionMode::AndroidPlatform,
        reversible: false,
        dry_run_support: false,
        sensitivity: Sensitivity::Personal,
        os_permission: Some("android.permission.READ_CALENDAR".to_string()),
    };
    let json = serde_json::to_string(&spec).expect("serialize");
    let deser: CapabilitySpec = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(deser.name.as_str(), "calendar.read");
    assert_eq!(deser.risk, RiskLevel::ReadPersonal);
}

#[test]
fn lane_queue_has_pending() {
    let mut queue = LaneQueue::default();
    assert!(!queue.has_pending());

    queue.pending_steer = Some(SteerRequest {
        content: "test".to_string(),
        requested_at: Utc::now(),
    });
    assert!(queue.has_pending());
}

#[test]
fn session_id_display() {
    let id = SessionId::new();
    let display = format!("{id}");
    // Should be a valid UUID string
    assert!(Uuid::parse_str(&display).is_ok());
}

#[test]
fn capability_name_from_str() {
    let name: CapabilityName = "device.battery".into();
    assert_eq!(name.as_str(), "device.battery");
}
