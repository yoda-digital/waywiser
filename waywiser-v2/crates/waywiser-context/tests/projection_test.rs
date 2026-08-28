use chrono::Utc;
use pi_types::ObservationSource;
use waywiser_context::{
    ContextDomain, ContextNode, DeviceContext, NetworkState, ScreenState, ThermalState,
    UserContext, ActivityState, AudioRoute, UpcomingEvent,
};
use waywiser_context::graph::ContextGraphSnapshot;
use waywiser_context::projection::{ProjectionEngine, TaskType};

fn make_snapshot(nodes: Vec<(&str, ContextDomain)>) -> ContextGraphSnapshot {
    ContextGraphSnapshot {
        nodes: nodes
            .into_iter()
            .map(|(key, domain)| {
                (
                    key.to_string(),
                    ContextNode {
                        domain,
                        updated_at: Utc::now(),
                        expires_at: None,
                        source: ObservationSource::Android,
                    },
                )
            })
            .collect(),
        captured_at: Utc::now(),
    }
}

fn user_walking() -> ContextDomain {
    ContextDomain::User(UserContext {
        activity: Some(ActivityState::Walking),
        audio_route: Some(AudioRoute::Headphones),
        place_context: None,
        next_event: None,
        attention_state: None,
    })
}

fn device_low_battery() -> ContextDomain {
    ContextDomain::Device(DeviceContext {
        battery_pct: 15,
        charging: false,
        network: NetworkState::Cellular,
        thermal: ThermalState::Nominal,
        screen: ScreenState::On,
    })
}

fn user_with_event(title: &str, minutes: i64) -> ContextDomain {
    ContextDomain::User(UserContext {
        activity: None,
        audio_route: None,
        place_context: None,
        next_event: Some(UpcomingEvent {
            title: title.to_string(),
            start: Utc::now(),
            minutes_until: minutes,
        }),
        attention_state: None,
    })
}

#[test]
fn test_simple_chat_budget_enforced() {
    let engine = ProjectionEngine::new();

    // Create many nodes with large event titles to exceed budget.
    // Each node summary with a long event title is ~100+ chars ≈ ~25 tokens.
    let mut nodes = Vec::new();
    for i in 0..200 {
        nodes.push((
            Box::leak(format!("user.event_{i}").into_boxed_str()) as &str,
            user_with_event(
                &format!("Very important meeting about project alpha roadmap review item number {i}"),
                i as i64,
            ),
        ));
    }
    let snapshot = make_snapshot(nodes);

    // Use a small budget to force truncation
    let proj = engine.project(&snapshot, "hello", TaskType::SimpleChat, 500);
    assert!(
        proj.tokens_used <= 500,
        "tokens_used={} exceeds budget 500",
        proj.tokens_used
    );
    // Should have included some but not all 200 nodes
    assert!(!proj.entries.is_empty(), "should include at least some entries");
    assert!(
        proj.entries.len() < 200,
        "should not include all 200 entries, got {}",
        proj.entries.len()
    );
}

#[test]
fn test_tool_call_gets_larger_budget() {
    let engine = ProjectionEngine::new();
    let snapshot = make_snapshot(vec![
        ("user.activity", user_walking()),
        ("device.battery", device_low_battery()),
    ]);

    let chat_proj = engine.project(&snapshot, "hello", TaskType::SimpleChat, TaskType::SimpleChat.default_budget());
    let tool_proj = engine.project(&snapshot, "hello", TaskType::ToolCall, TaskType::ToolCall.default_budget());

    // Both should include all 2 nodes (they're small)
    assert_eq!(chat_proj.entries.len(), 2);
    assert_eq!(tool_proj.entries.len(), 2);
}

#[test]
fn test_empty_snapshot() {
    let engine = ProjectionEngine::new();
    let snapshot = ContextGraphSnapshot {
        nodes: vec![],
        captured_at: Utc::now(),
    };

    let proj = engine.project(&snapshot, "anything", TaskType::SimpleChat, 2000);
    assert!(proj.entries.is_empty());
    assert_eq!(proj.tokens_used, 0);
    assert_eq!(proj.render(), "No relevant context available.");
}

#[test]
fn test_relevant_query_boosts_matching_nodes() {
    let engine = ProjectionEngine::new();
    let snapshot = make_snapshot(vec![
        ("user.next_event", user_with_event("Team meeting", 15)),
        ("device.battery", device_low_battery()),
    ]);

    // Query about "meeting" should rank the event node higher
    let proj = engine.project(&snapshot, "when is my meeting", TaskType::SimpleChat, 2000);
    assert!(!proj.entries.is_empty());

    // The event entry should have higher relevance than device
    let event_entry = proj.entries.iter().find(|e| e.key == "user.next_event");
    let device_entry = proj.entries.iter().find(|e| e.key == "device.battery");
    assert!(event_entry.is_some());
    assert!(device_entry.is_some());
    assert!(
        event_entry.unwrap().relevance >= device_entry.unwrap().relevance,
        "event relevance ({}) should >= device relevance ({})",
        event_entry.unwrap().relevance,
        device_entry.unwrap().relevance
    );
}

#[test]
fn test_render_includes_all_entries() {
    let engine = ProjectionEngine::new();
    let snapshot = make_snapshot(vec![
        ("user.activity", user_walking()),
        ("device.battery", device_low_battery()),
    ]);

    let proj = engine.project(&snapshot, "status", TaskType::SimpleChat, 2000);
    let rendered = proj.render();
    assert!(rendered.contains("Walking"), "should contain Walking: {rendered}");
    assert!(rendered.contains("15%"), "should contain 15%: {rendered}");
}

#[test]
fn test_zero_budget_returns_empty() {
    let engine = ProjectionEngine::new();
    let snapshot = make_snapshot(vec![("user.activity", user_walking())]);

    let proj = engine.project(&snapshot, "hello", TaskType::SimpleChat, 0);
    assert!(proj.entries.is_empty());
    assert_eq!(proj.tokens_used, 0);
}
