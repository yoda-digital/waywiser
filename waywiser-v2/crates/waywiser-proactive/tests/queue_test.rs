use chrono::{Duration, Utc};
use waywiser_proactive::*;

fn make_job(priority: InferencePriority, coalesce_key: Option<&str>) -> ReasoningJob {
    ReasoningJob::new(
        ReasoningCause::Consolidation,
        priority,
        RelevanceRule::Always,
        coalesce_key.map(|s| s.to_string()),
    )
}

#[test]
fn enqueue_adds_job() {
    let mut queue = ReasoningQueueManager::with_default_ttl();
    let job = make_job(InferencePriority::Reflection, None);
    let id = queue.enqueue(job);
    assert_eq!(queue.pending_count(), 1);
    assert!(queue.get(id).is_some());
}

#[test]
fn coalesce_merges_same_key() {
    let mut queue = ReasoningQueueManager::with_default_ttl();
    let job1 = make_job(InferencePriority::Reflection, Some("calendar-check"));
    let job2 = make_job(InferencePriority::Reflection, Some("calendar-check"));
    let id1 = queue.enqueue(job1);
    let id2 = queue.enqueue(job2);
    // Same key → coalesced into same job
    assert_eq!(id1, id2);
    assert_eq!(queue.pending_count(), 1);
}

#[test]
fn coalesce_upgrades_priority() {
    let mut queue = ReasoningQueueManager::with_default_ttl();
    let low = make_job(InferencePriority::Evolution, Some("task-x"));
    let high = make_job(InferencePriority::Delegated, Some("task-x"));
    let id1 = queue.enqueue(low);
    let _id2 = queue.enqueue(high);
    let job = queue.get(id1).unwrap();
    assert_eq!(job.priority, InferencePriority::Delegated);
}

#[test]
fn different_keys_not_coalesced() {
    let mut queue = ReasoningQueueManager::with_default_ttl();
    let job1 = make_job(InferencePriority::Reflection, Some("key-a"));
    let job2 = make_job(InferencePriority::Reflection, Some("key-b"));
    let id1 = queue.enqueue(job1);
    let id2 = queue.enqueue(job2);
    assert_ne!(id1, id2);
    assert_eq!(queue.pending_count(), 2);
}

#[test]
fn next_ready_returns_highest_priority() {
    let mut queue = ReasoningQueueManager::with_default_ttl();
    queue.enqueue(make_job(InferencePriority::Evolution, None));
    queue.enqueue(make_job(InferencePriority::Delegated, None));
    queue.enqueue(make_job(InferencePriority::Reflection, None));

    let next = queue.next_ready().unwrap();
    assert_eq!(next.priority, InferencePriority::Delegated);
}

#[test]
fn next_ready_expires_irrelevant() {
    let mut queue = ReasoningQueueManager::with_default_ttl();
    let mut job = ReasoningJob::new(
        ReasoningCause::Consolidation,
        InferencePriority::Reflection,
        RelevanceRule::TimeWindow {
            expires_at: Utc::now() - Duration::hours(1), // already expired
        },
        None,
    );
    let id = job.id;
    queue.enqueue(job);

    // Should return None because the only job is irrelevant
    let next = queue.next_ready();
    assert!(next.is_none());

    // Job should be marked expired
    let expired = queue.get(id).unwrap();
    assert!(matches!(expired.status, ReasoningJobStatus::Expired { .. }));
}

#[test]
fn expire_stale_removes_old_jobs() {
    let mut queue = ReasoningQueueManager::new(Duration::hours(1));

    // Create a job that was created 2 hours ago
    let mut old_job = make_job(InferencePriority::Reflection, None);
    old_job.created_at = Utc::now() - Duration::hours(2);
    queue.enqueue(old_job);

    // Create a recent job
    queue.enqueue(make_job(InferencePriority::Reflection, None));

    let expired_count = queue.expire_stale(Utc::now());
    assert_eq!(expired_count, 1);
    assert_eq!(queue.pending_count(), 1);
}

#[test]
fn mark_completed() {
    let mut queue = ReasoningQueueManager::with_default_ttl();
    let job = make_job(InferencePriority::Reflection, None);
    let id = queue.enqueue(job);

    queue.mark_completed(id, serde_json::json!({"result": "ok"}));

    let completed = queue.get(id).unwrap();
    assert!(matches!(completed.status, ReasoningJobStatus::Completed { .. }));
}

#[test]
fn mark_failed_retryable_resets_to_pending() {
    let mut queue = ReasoningQueueManager::with_default_ttl();
    let job = make_job(InferencePriority::Reflection, None);
    let id = queue.enqueue(job);

    // First make it executing
    let _ = queue.next_ready();
    queue.mark_failed(id, "timeout", true);

    let retry = queue.get(id).unwrap();
    assert!(matches!(retry.status, ReasoningJobStatus::Pending));
}

#[test]
fn cleanup_terminal_removes_completed() {
    let mut queue = ReasoningQueueManager::with_default_ttl();
    let id = queue.enqueue(make_job(InferencePriority::Reflection, None));
    queue.mark_completed(id, serde_json::json!(null));

    queue.enqueue(make_job(InferencePriority::Reflection, None)); // pending

    let cleaned = queue.cleanup_terminal();
    assert_eq!(cleaned, 1);
    assert_eq!(queue.total_count(), 1);
}
