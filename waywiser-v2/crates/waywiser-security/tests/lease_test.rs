use chrono::{Duration, Utc};
use uuid::Uuid;

use pi_types::*;
use waywiser_security::*;

fn test_lease(max_executions: Option<u32>, valid_hours: i64) -> ApprovalLease {
    ApprovalLease::new(
        CapabilityName("calendar.update".to_string()),
        LeaseScope::unrestricted(),
        LeaseConstraints::none(),
        Utc::now() + Duration::hours(valid_hours),
        max_executions,
        GrantSource::UserExplicit,
    )
}

fn test_intent() -> ActionIntent {
    ActionIntent {
        id: Uuid::now_v7(),
        origin: ActionOrigin::UserDirect,
        capability: CapabilityName("calendar.update".to_string()),
        arguments: serde_json::json!({}),
        reason: "test".to_string(),
        session_id: SessionId(Uuid::now_v7()),
        goal_id: None,
        work_item_id: None,
        evidence: vec![],
        idempotency_key: Uuid::now_v7().to_string(),
        requested_at: Utc::now(),
    }
}

#[test]
fn lease_authorizes_within_budget() {
    let lease = test_lease(Some(5), 1);
    let intent = test_intent();
    let decision = lease.evaluate(&intent, Utc::now());
    assert_eq!(decision, LeaseDecision::Authorized);
}

#[test]
fn lease_denied_after_budget_exhausted() {
    let mut lease = test_lease(Some(5), 1);
    let intent = test_intent();

    // Use 5 times
    for _ in 0..5 {
        assert_eq!(lease.evaluate(&intent, Utc::now()), LeaseDecision::Authorized);
        lease.record_use(intent.id, &intent.arguments, ActionStatus::Completed);
    }

    // 6th should be denied
    let decision = lease.evaluate(&intent, Utc::now());
    assert_eq!(decision, LeaseDecision::Denied(LeaseReason::BudgetExhausted));
}

#[test]
fn expired_lease_denied() {
    let lease = test_lease(Some(5), -1); // expired 1 hour ago
    let intent = test_intent();
    let decision = lease.evaluate(&intent, Utc::now());
    assert_eq!(decision, LeaseDecision::Denied(LeaseReason::Expired));
}

#[test]
fn revoked_lease_denied() {
    let mut lease = test_lease(Some(5), 1);
    lease.revoke();
    let intent = test_intent();
    let decision = lease.evaluate(&intent, Utc::now());
    assert_eq!(decision, LeaseDecision::Denied(LeaseReason::Revoked));
}

#[test]
fn lease_audit_trail_grows() {
    let mut lease = test_lease(Some(10), 1);
    assert_eq!(lease.audit_trail.len(), 0);

    let intent = test_intent();
    lease.record_use(intent.id, &intent.arguments, ActionStatus::Completed);
    assert_eq!(lease.audit_trail.len(), 1);

    lease.record_use(intent.id, &intent.arguments, ActionStatus::Completed);
    assert_eq!(lease.audit_trail.len(), 2);
}

#[test]
fn unlimited_executions_lease() {
    let mut lease = test_lease(None, 1); // no max
    let intent = test_intent();

    for _ in 0..100 {
        assert_eq!(lease.evaluate(&intent, Utc::now()), LeaseDecision::Authorized);
        lease.record_use(intent.id, &intent.arguments, ActionStatus::Completed);
    }
}
