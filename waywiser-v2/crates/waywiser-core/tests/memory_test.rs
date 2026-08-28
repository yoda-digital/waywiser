//! Tests for MemoryStore — SQLite FTS5 memory storage.

use chrono::Utc;
use pi_types::{MemoryRecord, Provenance, ProvenanceSource};
use uuid::Uuid;
use waywiser_core::memory::{MemoryStore, SqliteMemoryStore};

fn test_record(content: &str, scope: &str) -> MemoryRecord {
    MemoryRecord {
        id: Uuid::now_v7(),
        content: content.to_string(),
        scope: scope.to_string(),
        provenance: Provenance {
            source: ProvenanceSource::UserExplicit,
            session_id: None,
            created_at: Utc::now(),
            confidence_ceiling: 0.9,
        },
        confidence: 0.8,
        usage_count: 0,
        last_recalled: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

#[tokio::test]
async fn test_store_and_get() {
    let store = SqliteMemoryStore::in_memory().unwrap();
    let record = test_record("User prefers morning meetings", "preferences");

    store.store(&record).await.unwrap();
    let loaded = store.get(record.id).await.unwrap();

    assert!(loaded.is_some());
    let loaded = loaded.unwrap();
    assert_eq!(loaded.content, "User prefers morning meetings");
    assert_eq!(loaded.scope, "preferences");
}

#[tokio::test]
async fn test_fts_search() {
    let store = SqliteMemoryStore::in_memory().unwrap();

    store
        .store(&test_record("User likes coffee in the morning", "preferences"))
        .await
        .unwrap();
    store
        .store(&test_record("Meeting with Alice on Monday", "events"))
        .await
        .unwrap();
    store
        .store(&test_record("User prefers tea in the afternoon", "preferences"))
        .await
        .unwrap();

    let results = store.search_fts("coffee", 10).await.unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].content.contains("coffee"));
}

#[tokio::test]
async fn test_recall_returns_fts_results() {
    let store = SqliteMemoryStore::in_memory().unwrap();

    store
        .store(&test_record("The quick brown fox jumps", "test"))
        .await
        .unwrap();
    store
        .store(&test_record("A lazy dog sleeps all day", "test"))
        .await
        .unwrap();

    let results = store.recall("fox", 10).await.unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].content.contains("fox"));
}

#[tokio::test]
async fn test_update_record() {
    let store = SqliteMemoryStore::in_memory().unwrap();
    let mut record = test_record("Original content", "test");

    store.store(&record).await.unwrap();

    record.content = "Updated content".to_string();
    record.usage_count = 5;
    record.updated_at = Utc::now();
    store.update(&record).await.unwrap();

    let loaded = store.get(record.id).await.unwrap().unwrap();
    assert_eq!(loaded.content, "Updated content");
    assert_eq!(loaded.usage_count, 5);
}

#[tokio::test]
async fn test_delete_record() {
    let store = SqliteMemoryStore::in_memory().unwrap();
    let record = test_record("To be deleted", "test");

    store.store(&record).await.unwrap();

    let deleted = store.delete(record.id).await.unwrap();
    assert!(deleted);

    let loaded = store.get(record.id).await.unwrap();
    assert!(loaded.is_none());
}

#[tokio::test]
async fn test_delete_nonexistent() {
    let store = SqliteMemoryStore::in_memory().unwrap();
    let deleted = store.delete(Uuid::now_v7()).await.unwrap();
    assert!(!deleted);
}

#[tokio::test]
async fn test_get_nonexistent() {
    let store = SqliteMemoryStore::in_memory().unwrap();
    let result = store.get(Uuid::now_v7()).await.unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn test_empty_query_returns_nothing() {
    let store = SqliteMemoryStore::in_memory().unwrap();
    store
        .store(&test_record("Some content", "test"))
        .await
        .unwrap();

    let results = store.search_fts("", 10).await.unwrap();
    assert!(results.is_empty());
}
