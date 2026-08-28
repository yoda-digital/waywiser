//! Full CRUD lifecycle tests for SqliteSessionBackend.

use pi_session::{SessionBackend, SqliteSessionBackend};
use pi_types::*;

fn make_backend() -> SqliteSessionBackend {
    SqliteSessionBackend::in_memory().expect("in-memory db")
}

fn make_entry(text: &str) -> Entry {
    Entry {
        id: EntryId::new(),
        message: AgentMessage::User(UserMessage {
            id: EntryId::new(),
            content: MessageContent::Text(text.to_string()),
            timestamp: chrono::Utc::now(),
        }),
    }
}

#[tokio::test]
async fn create_and_load_session() {
    let backend = make_backend();
    let session = SessionState::new();
    let id = session.id;

    backend.create_session(&session).await.unwrap();

    let loaded = backend.load_session(id).await.unwrap();
    assert!(loaded.is_some());

    let loaded = loaded.unwrap();
    assert_eq!(loaded.id, id);
    assert_eq!(loaded.lanes.len(), 1);
    assert_eq!(loaded.active_lane_id, session.active_lane_id);
}

#[tokio::test]
async fn load_nonexistent_returns_none() {
    let backend = make_backend();
    let result = backend.load_session(SessionId::new()).await.unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn save_updates_session() {
    let backend = make_backend();
    let mut session = SessionState::new();
    backend.create_session(&session).await.unwrap();

    session.usage.turn_count = 42;
    session.updated_at = chrono::Utc::now();
    backend.save_session(&session).await.unwrap();

    let loaded = backend.load_session(session.id).await.unwrap().unwrap();
    assert_eq!(loaded.usage.turn_count, 42);
}

#[tokio::test]
async fn save_nonexistent_returns_error() {
    let backend = make_backend();
    let session = SessionState::new();
    let result = backend.save_session(&session).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn delete_session_returns_true() {
    let backend = make_backend();
    let session = SessionState::new();
    backend.create_session(&session).await.unwrap();

    let deleted = backend.delete_session(session.id).await.unwrap();
    assert!(deleted);

    let loaded = backend.load_session(session.id).await.unwrap();
    assert!(loaded.is_none());
}

#[tokio::test]
async fn delete_nonexistent_returns_false() {
    let backend = make_backend();
    let deleted = backend.delete_session(SessionId::new()).await.unwrap();
    assert!(!deleted);
}

#[tokio::test]
async fn list_sessions_with_pagination() {
    let backend = make_backend();

    // Create 5 sessions
    for _ in 0..5 {
        let session = SessionState::new();
        backend.create_session(&session).await.unwrap();
    }

    // List first 3
    let page1 = backend.list_sessions(3, 0).await.unwrap();
    assert_eq!(page1.len(), 3);

    // List next 3 (only 2 remain)
    let page2 = backend.list_sessions(3, 3).await.unwrap();
    assert_eq!(page2.len(), 2);

    // List with offset past end
    let page3 = backend.list_sessions(3, 10).await.unwrap();
    assert!(page3.is_empty());
}

#[tokio::test]
async fn append_entry_to_lane() {
    let backend = make_backend();
    let session = SessionState::new();
    let lane_id = session.active_lane_id;
    backend.create_session(&session).await.unwrap();

    let entry = make_entry("Hello, Waywiser!");
    let entry_id = entry.id;
    backend
        .append_entry(session.id, lane_id, &entry)
        .await
        .unwrap();

    let loaded = backend.load_session(session.id).await.unwrap().unwrap();
    let lane = loaded.active_lane().unwrap();
    assert_eq!(lane.entries.len(), 1);
    assert_eq!(lane.entries[0].id, entry_id);
}

#[tokio::test]
async fn append_entry_to_nonexistent_session_fails() {
    let backend = make_backend();
    let entry = make_entry("test");
    let result = backend
        .append_entry(SessionId::new(), LaneId::new(), &entry)
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn append_entry_to_nonexistent_lane_fails() {
    let backend = make_backend();
    let session = SessionState::new();
    backend.create_session(&session).await.unwrap();

    let entry = make_entry("test");
    let result = backend
        .append_entry(session.id, LaneId::new(), &entry)
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn update_lane_queue() {
    let backend = make_backend();
    let session = SessionState::new();
    let lane_id = session.active_lane_id;
    backend.create_session(&session).await.unwrap();

    let queue = LaneQueue {
        pending_steer: Some(SteerRequest {
            content: "new direction".into(),
            requested_at: chrono::Utc::now(),
        }),
        ..Default::default()
    };

    backend
        .update_lane_queue(session.id, lane_id, &queue)
        .await
        .unwrap();

    let loaded = backend.load_session(session.id).await.unwrap().unwrap();
    let lane = loaded.active_lane().unwrap();
    assert!(lane.queue.pending_steer.is_some());
    assert_eq!(
        lane.queue.pending_steer.as_ref().unwrap().content,
        "new direction"
    );
}

#[tokio::test]
async fn append_and_load_records() {
    let backend = make_backend();
    let session = SessionState::new();
    backend.create_session(&session).await.unwrap();

    let data = serde_json::json!({"entry_id": "abc", "timestamp": "2026-08-28T00:00:00Z"});
    backend
        .append_record(session.id, "TurnStarted", &data)
        .await
        .unwrap();

    let data2 = serde_json::json!({"call_id": "tool1", "name": "battery"});
    backend
        .append_record(session.id, "ToolCallStarted", &data2)
        .await
        .unwrap();

    let records = backend.load_records(session.id).await.unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].record_type, "TurnStarted");
    assert_eq!(records[1].record_type, "ToolCallStarted");
    // Records ordered by insertion (id ASC)
    assert!(records[0].id < records[1].id);
}

#[tokio::test]
async fn load_records_empty_for_no_session() {
    let backend = make_backend();
    let records = backend.load_records(SessionId::new()).await.unwrap();
    assert!(records.is_empty());
}

#[tokio::test]
async fn remove_entries_compaction() {
    let backend = make_backend();
    let session = SessionState::new();
    let lane_id = session.active_lane_id;
    backend.create_session(&session).await.unwrap();

    // Append 3 entries
    let e1 = make_entry("first");
    let e2 = make_entry("second");
    let e3 = make_entry("third");
    let e1_id = e1.id;
    let e2_id = e2.id;
    let e3_id = e3.id;

    backend.append_entry(session.id, lane_id, &e1).await.unwrap();
    backend.append_entry(session.id, lane_id, &e2).await.unwrap();
    backend.append_entry(session.id, lane_id, &e3).await.unwrap();

    // Remove first two (compaction)
    backend
        .remove_entries(session.id, lane_id, &[e1_id, e2_id])
        .await
        .unwrap();

    let loaded = backend.load_session(session.id).await.unwrap().unwrap();
    let lane = loaded.active_lane().unwrap();
    assert_eq!(lane.entries.len(), 1);
    assert_eq!(lane.entries[0].id, e3_id);
}

#[tokio::test]
async fn record_mutation() {
    let backend = make_backend();
    let meta = pi_session::MutationMeta {
        mutation_id: uuid::Uuid::now_v7(),
        device_id: DeviceId::new(),
        local_sequence: 1,
        wall_clock: chrono::Utc::now(),
    };
    // Should not fail
    backend.record_mutation(meta).await.unwrap();
}

#[tokio::test]
async fn delete_cascade_removes_records() {
    let backend = make_backend();
    let session = SessionState::new();
    backend.create_session(&session).await.unwrap();

    let data = serde_json::json!({"test": true});
    backend
        .append_record(session.id, "Test", &data)
        .await
        .unwrap();

    backend.delete_session(session.id).await.unwrap();

    // Records should also be gone
    let records = backend.load_records(session.id).await.unwrap();
    assert!(records.is_empty());
}
