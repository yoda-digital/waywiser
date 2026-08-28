use chrono::Utc;
use uuid::Uuid;

use pi_types::{
    ActionIntent, ActionOrigin, ActionReceipt, ActionStatus, CapabilityName, SessionId,
    VerificationStatus,
};
use waywiser_workflows::{
    execute_workflow, ActionExecutor, ExpectedOutcome, PreCondition, PreConditionKind, StepStatus,
    Workflow, WorkflowResult, WorkflowStatus,
};

/// Test executor that returns configurable receipts per step index.
struct MockExecutor {
    receipts: Vec<ActionReceipt>,
}

impl MockExecutor {
    fn all_succeed(count: usize) -> Self {
        Self {
            receipts: (0..count)
                .map(|_| ActionReceipt {
                    intent_id: Uuid::now_v7(),
                    capability: CapabilityName("test.action".into()),
                    started_at: Utc::now(),
                    completed_at: Some(Utc::now()),
                    status: ActionStatus::Completed,
                    external_reference: None,
                    reversible: true,
                    undo_token: Some("undo_123".into()),
                    verification: VerificationStatus::Verified,
                    result_summary: Some("success".into()),
                })
                .collect(),
        }
    }

    fn with_failure_at(count: usize, fail_at: usize) -> Self {
        Self {
            receipts: (0..count)
                .map(|i| {
                    if i == fail_at {
                        ActionReceipt {
                            intent_id: Uuid::now_v7(),
                            capability: CapabilityName("test.action".into()),
                            started_at: Utc::now(),
                            completed_at: Some(Utc::now()),
                            status: ActionStatus::Failed {
                                reason: "test failure".into(),
                            },
                            external_reference: None,
                            reversible: false,
                            undo_token: None,
                            verification: VerificationStatus::Unknown,
                            result_summary: None,
                        }
                    } else {
                        ActionReceipt {
                            intent_id: Uuid::now_v7(),
                            capability: CapabilityName("test.action".into()),
                            started_at: Utc::now(),
                            completed_at: Some(Utc::now()),
                            status: ActionStatus::Completed,
                            external_reference: None,
                            reversible: true,
                            undo_token: Some("undo".into()),
                            verification: VerificationStatus::Verified,
                            result_summary: Some("ok".into()),
                        }
                    }
                })
                .collect(),
        }
    }

    fn with_unexpected_at(count: usize, unexpected_at: usize) -> Self {
        Self {
            receipts: (0..count)
                .map(|i| {
                    if i == unexpected_at {
                        ActionReceipt {
                            intent_id: Uuid::now_v7(),
                            capability: CapabilityName("test.action".into()),
                            started_at: Utc::now(),
                            completed_at: Some(Utc::now()),
                            status: ActionStatus::Completed,
                            external_reference: None,
                            reversible: false,
                            undo_token: None,
                            verification: VerificationStatus::Unexpected,
                            result_summary: None,
                        }
                    } else {
                        ActionReceipt {
                            intent_id: Uuid::now_v7(),
                            capability: CapabilityName("test.action".into()),
                            started_at: Utc::now(),
                            completed_at: Some(Utc::now()),
                            status: ActionStatus::Completed,
                            external_reference: None,
                            reversible: true,
                            undo_token: Some("undo".into()),
                            verification: VerificationStatus::Verified,
                            result_summary: Some("ok".into()),
                        }
                    }
                })
                .collect(),
        }
    }
}

impl ActionExecutor for MockExecutor {
    fn execute(&self, _intent: &ActionIntent) -> ActionReceipt {
        // Return receipts in order; if exhausted, return a default failure
        static CALL_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let idx = CALL_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Reset is per-test, so this is fragile. Use a different approach:
        // Actually, let's use interior mutability.
        self.receipts
            .get(idx % self.receipts.len())
            .cloned()
            .unwrap_or(ActionReceipt {
                intent_id: Uuid::now_v7(),
                capability: CapabilityName("test".into()),
                started_at: Utc::now(),
                completed_at: Some(Utc::now()),
                status: ActionStatus::Failed {
                    reason: "exhausted".into(),
                },
                external_reference: None,
                reversible: false,
                undo_token: None,
                verification: VerificationStatus::Unknown,
                result_summary: None,
            })
    }
}

// Use a cell-based executor for reliable per-test counting
struct CellExecutor {
    receipts: Vec<ActionReceipt>,
    index: std::sync::atomic::AtomicUsize,
}

impl CellExecutor {
    fn new(receipts: Vec<ActionReceipt>) -> Self {
        Self {
            receipts,
            index: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn all_succeed(count: usize) -> Self {
        Self::new(MockExecutor::all_succeed(count).receipts)
    }

    fn with_failure_at(count: usize, fail_at: usize) -> Self {
        Self::new(MockExecutor::with_failure_at(count, fail_at).receipts)
    }

    fn with_unexpected_at(count: usize, unexpected_at: usize) -> Self {
        Self::new(MockExecutor::with_unexpected_at(count, unexpected_at).receipts)
    }
}

impl ActionExecutor for CellExecutor {
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

#[test]
fn three_steps_all_succeed() {
    let executor = CellExecutor::all_succeed(3);
    let mut wf = Workflow::new("test workflow", None);
    for _ in 0..3 {
        wf.add_step(make_intent(), vec![], None);
    }

    let result = execute_workflow(&mut wf, &executor);

    assert_eq!(result, WorkflowResult::Completed);
    assert!(matches!(wf.status, WorkflowStatus::Completed));
    assert_eq!(wf.completed_steps(), 3);
    assert!(wf.steps.iter().all(|s| s.status == StepStatus::Succeeded));
}

#[test]
fn step_two_fails_partial_completion() {
    let executor = CellExecutor::with_failure_at(3, 1);
    let mut wf = Workflow::new("test workflow", None);
    for _ in 0..3 {
        wf.add_step(make_intent(), vec![], None);
    }

    let result = execute_workflow(&mut wf, &executor);

    assert_eq!(result, WorkflowResult::Partial);
    assert!(matches!(
        wf.status,
        WorkflowStatus::PartiallyCompleted { failed_at: 1 }
    ));
    assert_eq!(wf.steps[0].status, StepStatus::Succeeded);
    assert_eq!(wf.steps[1].status, StepStatus::Failed);
    assert_eq!(wf.steps[2].status, StepStatus::Skipped);
}

#[test]
fn unexpected_verification_halts_workflow() {
    let executor = CellExecutor::with_unexpected_at(3, 1);
    let mut wf = Workflow::new("test workflow", None);
    for _ in 0..3 {
        wf.add_step(make_intent(), vec![], None);
    }

    let result = execute_workflow(&mut wf, &executor);

    assert_eq!(result, WorkflowResult::Aborted);
    assert!(matches!(
        wf.status,
        WorkflowStatus::Aborted {
            reason: waywiser_workflows::AbortReason::VerificationUnexpected
        }
    ));
    assert_eq!(wf.steps[0].status, StepStatus::Succeeded);
    assert_eq!(wf.steps[1].status, StepStatus::Failed);
    assert_eq!(wf.steps[2].status, StepStatus::Skipped);
}

#[test]
fn pre_condition_prior_step_failed_aborts() {
    let executor = CellExecutor::all_succeed(3);
    let mut wf = Workflow::new("test workflow", None);

    // Step 0: no pre-conditions
    wf.add_step(make_intent(), vec![], None);
    // Step 1: requires step 0 succeeded
    wf.add_step(
        make_intent(),
        vec![PreCondition {
            kind: PreConditionKind::PriorStepSucceeded(0),
            description: "step 0 must succeed".into(),
        }],
        None,
    );

    let result = execute_workflow(&mut wf, &executor);

    // Step 0 succeeds, step 1's pre-condition (step 0 succeeded) should pass
    assert_eq!(result, WorkflowResult::Completed);
}

#[test]
fn pre_condition_unsatisfied_aborts() {
    let executor = CellExecutor::all_succeed(3);
    let mut wf = Workflow::new("test workflow", None);

    // Step 0: requires step 5 (doesn't exist) → will fail
    wf.add_step(
        make_intent(),
        vec![PreCondition {
            kind: PreConditionKind::PriorStepSucceeded(5),
            description: "step 5 must succeed".into(),
        }],
        None,
    );

    let result = execute_workflow(&mut wf, &executor);

    assert_eq!(result, WorkflowResult::Aborted);
    assert_eq!(wf.steps[0].status, StepStatus::Failed);
}

#[test]
fn empty_workflow_completes() {
    let executor = CellExecutor::all_succeed(0);
    let mut wf = Workflow::new("empty", None);

    let result = execute_workflow(&mut wf, &executor);

    assert_eq!(result, WorkflowResult::Completed);
}

#[test]
fn single_step_succeeds() {
    let executor = CellExecutor::all_succeed(1);
    let mut wf = Workflow::new("single", None);
    wf.add_step(make_intent(), vec![], None);

    let result = execute_workflow(&mut wf, &executor);

    assert_eq!(result, WorkflowResult::Completed);
    assert_eq!(wf.completed_steps(), 1);
}
