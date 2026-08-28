use chrono::Utc;
use uuid::Uuid;

use pi_types::{
    ActionIntent, ActionOrigin, ActionReceipt, ActionStatus, CapabilityName, SessionId,
    VerificationStatus,
};
use waywiser_workflows::{
    execute_workflow, rollback_workflow, ActionExecutor, StepStatus, Workflow, WorkflowResult,
};

struct FixedExecutor {
    receipts: Vec<ActionReceipt>,
    index: std::sync::atomic::AtomicUsize,
}

impl FixedExecutor {
    fn new(receipts: Vec<ActionReceipt>) -> Self {
        Self {
            receipts,
            index: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl ActionExecutor for FixedExecutor {
    fn execute(&self, _intent: &ActionIntent) -> ActionReceipt {
        let idx = self.index.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        
        self.receipts[idx].clone()
    }
}

fn make_intent() -> ActionIntent {
    ActionIntent {
        id: Uuid::now_v7(),
        origin: ActionOrigin::UserDirect,
        capability: CapabilityName("test.action".into()),
        arguments: serde_json::json!({}),
        reason: "test".into(),
        session_id: SessionId(Uuid::now_v7()),
        goal_id: None,
        work_item_id: None,
        evidence: vec![],
        idempotency_key: Uuid::now_v7().to_string(),
        requested_at: Utc::now(),
    }
}

fn reversible_receipt() -> ActionReceipt {
    ActionReceipt {
        intent_id: Uuid::now_v7(),
        capability: CapabilityName("test.action".into()),
        started_at: Utc::now(),
        completed_at: Some(Utc::now()),
        status: ActionStatus::Completed,
        external_reference: None,
        reversible: true,
        undo_token: Some("undo_token_123".into()),
        verification: VerificationStatus::Verified,
        result_summary: Some("ok".into()),
    }
}

fn irreversible_receipt() -> ActionReceipt {
    ActionReceipt {
        intent_id: Uuid::now_v7(),
        capability: CapabilityName("communication.send".into()),
        started_at: Utc::now(),
        completed_at: Some(Utc::now()),
        status: ActionStatus::Completed,
        external_reference: None,
        reversible: false,
        undo_token: None,
        verification: VerificationStatus::Verified,
        result_summary: Some("sent email".into()),
    }
}

#[test]
fn rollback_three_reversible_steps() {
    let executor = FixedExecutor::new(vec![
        reversible_receipt(),
        reversible_receipt(),
        reversible_receipt(),
    ]);

    let mut wf = Workflow::new("test", None);
    for _ in 0..3 {
        wf.add_step(make_intent(), vec![], None);
    }

    let result = execute_workflow(&mut wf, &executor);
    assert_eq!(result, WorkflowResult::Completed);
    assert_eq!(wf.completed_steps(), 3);

    // Now rollback
    let rb = rollback_workflow(&mut wf);
    assert_eq!(rb.steps_rolled_back, 3);
    assert_eq!(rb.steps_skipped, 0);

    // All steps should be RolledBack
    for step in &wf.steps {
        assert_eq!(step.status, StepStatus::RolledBack);
    }
}

#[test]
fn rollback_mixed_reversible_irreversible() {
    // Step 0: reversible, Step 1: irreversible, Step 2: reversible
    let executor = FixedExecutor::new(vec![
        reversible_receipt(),
        irreversible_receipt(),
        reversible_receipt(),
    ]);

    let mut wf = Workflow::new("test", None);
    for _ in 0..3 {
        wf.add_step(make_intent(), vec![], None);
    }

    execute_workflow(&mut wf, &executor);
    assert_eq!(wf.completed_steps(), 3);

    let rb = rollback_workflow(&mut wf);
    assert_eq!(rb.steps_rolled_back, 2); // steps 0 and 2
    assert_eq!(rb.steps_skipped, 1); // step 1 (irreversible)

    assert_eq!(wf.steps[0].status, StepStatus::RolledBack);
    assert_eq!(wf.steps[1].status, StepStatus::Succeeded); // can't undo
    assert_eq!(wf.steps[2].status, StepStatus::RolledBack);
}

#[test]
fn rollback_no_reversible_steps() {
    let executor = FixedExecutor::new(vec![
        irreversible_receipt(),
        irreversible_receipt(),
    ]);

    let mut wf = Workflow::new("test", None);
    for _ in 0..2 {
        wf.add_step(make_intent(), vec![], None);
    }

    execute_workflow(&mut wf, &executor);

    let rb = rollback_workflow(&mut wf);
    assert_eq!(rb.steps_rolled_back, 0);
    assert_eq!(rb.steps_skipped, 2);
}

#[test]
fn rollback_partially_completed_workflow() {
    // Step 0: succeeds (reversible), Step 1: fails, Step 2: skipped
    let executor = FixedExecutor::new(vec![
        reversible_receipt(),
        ActionReceipt {
            intent_id: Uuid::now_v7(),
            capability: CapabilityName("test".into()),
            started_at: Utc::now(),
            completed_at: Some(Utc::now()),
            status: ActionStatus::Failed { reason: "boom".into() },
            external_reference: None,
            reversible: false,
            undo_token: None,
            verification: VerificationStatus::Unknown,
            result_summary: None,
        },
        reversible_receipt(),
    ]);

    let mut wf = Workflow::new("test", None);
    for _ in 0..3 {
        wf.add_step(make_intent(), vec![], None);
    }

    let result = execute_workflow(&mut wf, &executor);
    assert_eq!(result, WorkflowResult::Partial);

    // Only step 0 succeeded, step 1 failed, step 2 skipped
    let rb = rollback_workflow(&mut wf);
    assert_eq!(rb.steps_rolled_back, 1); // only step 0
    assert_eq!(rb.steps_skipped, 0);
}
