use waywiser_ffi::{RuntimeConfig, RuntimeEvent, WaywiserRuntime};

#[test]
fn runtime_initializes_with_memory_db() {
    let config = RuntimeConfig::test_config();
    let rt = WaywiserRuntime::new(config);
    assert!(rt.is_ok());
}

#[test]
fn create_session_and_list() {
    let config = RuntimeConfig::test_config();
    let rt = WaywiserRuntime::new(config).unwrap();

    let session_id = rt.create_session().unwrap();
    assert!(!session_id.is_empty());

    // Drain the SessionChanged event
    let event = rt.poll_event().unwrap();
    assert!(event.is_some());
    match event.unwrap() {
        RuntimeEvent::SessionChanged { session_id: id } => {
            assert_eq!(id, session_id);
        }
        other => panic!("expected SessionChanged, got {:?}", other),
    }
}

#[test]
fn send_message_produces_events() {
    let config = RuntimeConfig::test_config();
    let rt = WaywiserRuntime::new(config).unwrap();

    // Create a session first
    let _sid = rt.create_session().unwrap();
    // Drain SessionChanged
    let _ = rt.poll_event().unwrap();

    // Send a message
    rt.send_message("Hello, Waywiser!".into()).unwrap();

    // Should get a TextDelta echo
    let event = rt.poll_event().unwrap();
    assert!(event.is_some());
    match event.unwrap() {
        RuntimeEvent::TextDelta { text } => {
            assert!(text.contains("Hello, Waywiser!"));
        }
        other => panic!("expected TextDelta, got {:?}", other),
    }

    // Should get a TurnComplete
    let event = rt.poll_event().unwrap();
    assert!(event.is_some());
    match event.unwrap() {
        RuntimeEvent::TurnComplete { .. } => {}
        other => panic!("expected TurnComplete, got {:?}", other),
    }
}

#[test]
fn cancel_produces_error_event() {
    let config = RuntimeConfig::test_config();
    let rt = WaywiserRuntime::new(config).unwrap();

    rt.cancel().unwrap();

    let event = rt.poll_event().unwrap();
    assert!(event.is_some());
    match event.unwrap() {
        RuntimeEvent::Error { code, .. } => {
            assert_eq!(code, "cancelled");
        }
        other => panic!("expected Error, got {:?}", other),
    }
}

#[test]
fn steer_produces_text_delta() {
    let config = RuntimeConfig::test_config();
    let rt = WaywiserRuntime::new(config).unwrap();

    rt.steer("new direction".into()).unwrap();

    let event = rt.poll_event().unwrap();
    assert!(event.is_some());
    match event.unwrap() {
        RuntimeEvent::TextDelta { text } => {
            assert!(text.contains("new direction"));
        }
        other => panic!("expected TextDelta, got {:?}", other),
    }
}

#[test]
fn shutdown_then_operations_still_safe() {
    let config = RuntimeConfig::test_config();
    let rt = WaywiserRuntime::new(config).unwrap();

    rt.shutdown().unwrap();
    // Shutdown is idempotent
    rt.shutdown().unwrap();
}

#[test]
fn list_sessions_empty() {
    let config = RuntimeConfig::test_config();
    let rt = WaywiserRuntime::new(config).unwrap();

    let sessions = rt.list_sessions().unwrap();
    assert!(sessions.is_empty());
}

#[test]
fn list_sessions_after_create() {
    let config = RuntimeConfig::test_config();
    let rt = WaywiserRuntime::new(config).unwrap();

    let _sid = rt.create_session().unwrap();
    // Drain event
    let _ = rt.poll_event();

    let sessions = rt.list_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
}

#[test]
fn runtime_event_serialization() {
    let event = RuntimeEvent::text_delta("hello");
    let json = serde_json::to_string(&event).unwrap();
    let deserialized: RuntimeEvent = serde_json::from_str(&json).unwrap();
    match deserialized {
        RuntimeEvent::TextDelta { text } => assert_eq!(text, "hello"),
        _ => panic!("wrong variant"),
    }
}
