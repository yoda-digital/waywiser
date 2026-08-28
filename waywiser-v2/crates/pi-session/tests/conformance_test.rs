//! Conformance tests for the SessionBackend contract.
//!
//! These test the abstract backend contract, not SQLite-specific behavior.
//! Any SessionBackend implementation should pass these.

use pi_session::{SessionBackend, SqliteSessionBackend};
use pi_types::*;

fn make_backend() -> SqliteSessionBackend {
    SqliteSessionBackend::in_memory().expect("in-memory db")
}

#[tokio::test]
async fn conformance_create_load_returns_some() {
    let backend = make_backend();
    let session = SessionState::new();
    let id = session.id;

    backend.create_session(&session).await.unwrap();
    let loaded = backend.load_session(id).await.unwrap();
    assert!(loaded.is_some(), "create → load should return Some");
}

#[tokio::test]
async fn conformance_delete_load_returns_none() {
    let backend = make_backend();
    let session = SessionState::new();
    let id = session.id;

    backend.create_session(&session).await.unwrap();
    backend.delete_session(id).await.unwrap();
    let loaded = backend.load_session(id).await.unwrap();
    assert!(loaded.is_none(), "delete → load should return None");
}

#[tokio::test]
async fn conformance_list_respects_limit() {
    let backend = make_backend();

    for _ in 0..10 {
        backend.create_session(&SessionState::new()).await.unwrap();
    }

    let list = backend.list_sessions(5, 0).await.unwrap();
    assert_eq!(list.len(), 5, "list(limit=5) should return exactly 5");
}

#[tokio::test]
async fn conformance_list_respects_offset() {
    let backend = make_backend();

    for _ in 0..10 {
        backend.create_session(&SessionState::new()).await.unwrap();
    }

    let all = backend.list_sessions(100, 0).await.unwrap();
    let offset = backend.list_sessions(100, 7).await.unwrap();
    assert_eq!(offset.len(), all.len() - 7, "offset should skip rows");
}

#[tokio::test]
async fn conformance_session_id_preserved() {
    let backend = make_backend();
    let session = SessionState::new();
    let original_id = session.id;

    backend.create_session(&session).await.unwrap();
    let loaded = backend.load_session(original_id).await.unwrap().unwrap();
    assert_eq!(loaded.id, original_id, "session ID must survive round-trip");
}

#[tokio::test]
async fn conformance_lane_structure_preserved() {
    let backend = make_backend();
    let session = SessionState::new();
    let lane_count = session.lanes.len();
    let active_id = session.active_lane_id;

    backend.create_session(&session).await.unwrap();
    let loaded = backend.load_session(session.id).await.unwrap().unwrap();

    assert_eq!(loaded.lanes.len(), lane_count);
    assert_eq!(loaded.active_lane_id, active_id);
    assert!(loaded.active_lane().is_some());
}

#[tokio::test]
async fn conformance_append_entry_grows_lane() {
    let backend = make_backend();
    let session = SessionState::new();
    let lane_id = session.active_lane_id;
    backend.create_session(&session).await.unwrap();

    // Initially empty
    let before = backend.load_session(session.id).await.unwrap().unwrap();
    let before_count = before.active_lane().unwrap().entries.len();

    // Append one entry
    let entry = Entry {
        id: EntryId::new(),
        message: AgentMessage::System(SystemMessage {
            id: EntryId::new(),
            content: "test".into(),
            timestamp: chrono::Utc::now(),
        }),
    };
    backend
        .append_entry(session.id, lane_id, &entry)
        .await
        .unwrap();

    let after = backend.load_session(session.id).await.unwrap().unwrap();
    let after_count = after.active_lane().unwrap().entries.len();

    assert_eq!(after_count, before_count + 1, "append should grow lane by 1");
}

#[tokio::test]
async fn conformance_records_ordered_by_insertion() {
    let backend = make_backend();
    let session = SessionState::new();
    backend.create_session(&session).await.unwrap();

    for i in 0..5 {
        let data = serde_json::json!({"seq": i});
        backend
            .append_record(session.id, &format!("Type{i}"), &data)
            .await
            .unwrap();
    }

    let records = backend.load_records(session.id).await.unwrap();
    assert_eq!(records.len(), 5);

    // Verify ordering
    for (i, rec) in records.iter().enumerate() {
        assert_eq!(rec.record_type, format!("Type{i}"));
    }
}
