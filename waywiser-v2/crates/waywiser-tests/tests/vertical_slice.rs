//! Integration test: P0 vertical slice (acceptance criteria 1-4).
//!
//! User message → agent loop → mock inference → tool call →
//! security kernel → tool result → response → session persisted.

use pi_types::*;
use waywiser_ffi::events::{RuntimeConfig, RuntimeEvent};
use waywiser_ffi::runtime::WaywiserRuntime;

/// P0 AC-1: User sends a message and receives a streamed response.
#[test]
fn vertical_slice_basic_message() {
    let config = RuntimeConfig::test_config();
    let runtime = WaywiserRuntime::new(config).expect("runtime should initialize");

    // Create a session
    let session_id = runtime.create_session().expect("session created");
    assert!(!session_id.is_empty());

    // Send a message
    runtime
        .send_message("What is the battery level?".into())
        .expect("message sent");

    // Poll events - should get at least TextDelta and TurnComplete
    let mut got_text = false;
    let mut got_complete = false;
    for _ in 0..20 {
        match runtime.poll_event() {
            Ok(Some(RuntimeEvent::TextDelta { text })) => {
                assert!(!text.is_empty());
                got_text = true;
            }
            Ok(Some(RuntimeEvent::TurnComplete { .. })) => {
                got_complete = true;
                break;
            }
            Ok(Some(RuntimeEvent::Heartbeat)) => continue,
            Ok(Some(_)) => continue,
            Ok(None) => break,
            Err(_) => break,
        }
    }

    assert!(got_text, "should receive at least one TextDelta");
    assert!(got_complete, "should receive TurnComplete");
}

/// P0 AC-2: Sessions are listable after creation.
#[test]
fn vertical_slice_session_persistence() {
    let config = RuntimeConfig::test_config();
    let runtime = WaywiserRuntime::new(config).expect("runtime should initialize");

    // Create two sessions
    let id1 = runtime.create_session().expect("session 1");
    let id2 = runtime.create_session().expect("session 2");
    assert_ne!(id1, id2);

    // List sessions
    let sessions = runtime.list_sessions().expect("list sessions");
    assert!(sessions.len() >= 2, "should have at least 2 sessions");
}

/// P0 AC-10: ThinkingConfig defaults to Medium, not XHigh.
#[test]
fn thinking_config_defaults_to_medium() {
    use pi_inference::thinking::{ReasoningEffort, ThinkingConfig};

    let config = ThinkingConfig::default();
    assert_eq!(config.reasoning_effort, ReasoningEffort::Medium);
    assert!(config.enabled);
}

/// P0 AC-3: Security kernel denies unknown capabilities.
#[test]
fn security_kernel_denies_unknown_capability() {
    use waywiser_security::{SecurityDecision, SecurityKernel};

    let mut kernel = SecurityKernel::new();
    let intent = ActionIntent::new(
        ActionOrigin::UserDirect,
        CapabilityName::new("nonexistent.capability"),
        serde_json::json!({}),
        "test",
        SessionId::new(),
    );

    let decision = kernel.authorize(&intent);
    assert!(
        matches!(decision, SecurityDecision::Denied(_)),
        "unknown capability must be denied"
    );

    // Audit log should have the denial
    assert_eq!(kernel.audit_log.len(), 1);
}

/// P0 AC-4: Registered safe capability is allowed.
#[test]
fn security_kernel_allows_registered_capability() {
    use pi_types::capability::*;
    use waywiser_security::{SecurityDecision, SecurityKernel};

    let mut kernel = SecurityKernel::new();

    // Register a safe (ReadPersonal) capability
    kernel.register_capability(CapabilitySpec {
        name: CapabilityName::new("device.battery_status"),
        description: "Read battery level".into(),
        input_schema: serde_json::json!({}),
        output_schema: serde_json::json!({}),
        risk: RiskLevel::ReadPersonal,
        permissions: vec![],
        side_effect: false,
        replay_policy: ReplayPolicy::SafeReplay,
        execution_mode: ExecutionMode::InProcess,
        reversible: false,
        dry_run_support: false,
        sensitivity: Sensitivity::Internal,
        os_permission: None,
    });

    let intent = ActionIntent::new(
        ActionOrigin::UserDirect,
        CapabilityName::new("device.battery_status"),
        serde_json::json!({}),
        "check battery",
        SessionId::new(),
    );

    let decision = kernel.authorize(&intent);
    assert!(
        matches!(decision, SecurityDecision::Allowed(_)),
        "registered ReadPersonal capability should be allowed, got: {:?}",
        decision
    );
}

/// P0 AC-5: Session state round-trips through SQLite.
#[tokio::test]
async fn session_sqlite_round_trip() {
    use pi_session::{backend::SessionBackend, sqlite::SqliteSessionBackend};

    let backend = SqliteSessionBackend::in_memory().expect("create in-memory backend");

    // Create a session with some state
    let mut session = SessionState::new();
    let session_id = session.id;

    backend
        .create_session(&session)
        .await
        .expect("create session");

    // Load it back
    let loaded = backend
        .load_session(session_id)
        .await
        .expect("load session")
        .expect("session should exist");

    assert_eq!(loaded.id, session_id);
    assert_eq!(loaded.lanes.len(), session.lanes.len());
}
