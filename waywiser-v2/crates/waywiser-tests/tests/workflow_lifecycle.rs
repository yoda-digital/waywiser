//! Integration test: cross-app workflow lifecycle (P3 acceptance criteria).
//!
//! Tests multi-step workflows with verification, halt-on-Unexpected,
//! and rollback of reversible steps.

use pi_types::*;
use waywiser_workflows::executor::{execute_workflow, ActionExecutor};
use waywiser_workflows::rollback::rollback_workflow;
use waywiser_workflows::workflow::*;

/// A mock executor that returns receipts based on step index.
struct MockExecutor {
    /// Verification status to return for each step index.
    verifications: Vec<VerificationStatus>,
    /// Whether each step's action "succeeds" (not Failed).
    successes: Vec<bool>,
    /// Whether each step is reversible.
    reversible: Vec<bool>,
}

impl ActionExecutor for MockExecutor {
    fn execute(&self, intent: &ActionIntent) -> ActionReceipt {
        // Use idempotency_key to determine step index (we'll encode it)
        let step_idx: usize = intent
            .reason
            .strip_prefix("step_")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let verification = self
            .verifications
            .get(step_idx)
            .copied()
            .unwrap_or(VerificationStatus::Verified);
        let success = self.successes.get(step_idx).copied().unwrap_or(true);
        let reversible = self.reversible.get(step_idx).copied().unwrap_or(false);

        let status = if success {
            ActionStatus::Completed
        } else {
            ActionStatus::Failed {
                reason: "mock failure".into(),
            }
        };

        ActionReceipt {
            intent_id: intent.id,
            capability: intent.capability.clone(),
            started_at: chrono::Utc::now(),
            completed_at: Some(chrono::Utc::now()),
            status,
            external_reference: None,
            reversible,
            undo_token: if reversible {
                Some(format!("undo_{}", step_idx))
            } else {
                None
            },
            verification,
            result_summary: Some(format!("step {} result", step_idx)),
        }
    }
}

fn make_step_intent(step_idx: usize, cap: &str) -> ActionIntent {
    ActionIntent::new(
        ActionOrigin::UserDirect,
        CapabilityName::new(cap),
        serde_json::json!({"step": step_idx}),
        format!("step_{}", step_idx),
        SessionId::new(),
    )
}

/// P3 AC-9: Full workflow completes successfully.
#[test]
fn workflow_all_steps_succeed() {
    let executor = MockExecutor {
        verifications: vec![
            VerificationStatus::Verified,
            VerificationStatus::Verified,
            VerificationStatus::Verified,
        ],
        successes: vec![true, true, true],
        reversible: vec![true, false, true],
    };

    let mut workflow = Workflow::new("reschedule dentist", None);
    workflow.add_step(make_step_intent(0, "calendar.read"), vec![], None);
    workflow.add_step(make_step_intent(1, "calendar.update"), vec![], None);
    workflow.add_step(make_step_intent(2, "notification.send"), vec![], None);

    let result = execute_workflow(&mut workflow, &executor);

    assert!(
        matches!(result, WorkflowResult::Completed),
        "all steps should complete"
    );
    assert!(matches!(workflow.status, WorkflowStatus::Completed));
    assert_eq!(workflow.completed_steps(), 3);
}

/// P3 AC-8: Unexpected verification halts workflow.
#[test]
fn workflow_halts_on_unexpected_verification() {
    let executor = MockExecutor {
        verifications: vec![
            VerificationStatus::Verified,
            VerificationStatus::Unexpected, // step 2 → unexpected
            VerificationStatus::Verified,   // step 3 should never execute
        ],
        successes: vec![true, true, true],
        reversible: vec![true, false, true],
    };

    let mut workflow = Workflow::new("risky workflow", None);
    workflow.add_step(make_step_intent(0, "calendar.read"), vec![], None);
    workflow.add_step(make_step_intent(1, "app.click"), vec![], None);
    workflow.add_step(make_step_intent(2, "notification.send"), vec![], None);

    let result = execute_workflow(&mut workflow, &executor);

    assert!(
        matches!(result, WorkflowResult::Aborted),
        "should abort on Unexpected"
    );
    assert!(matches!(
        workflow.status,
        WorkflowStatus::Aborted {
            reason: AbortReason::VerificationUnexpected
        }
    ));

    // Step 0 succeeded, step 1 failed (Unexpected), step 2 skipped
    assert!(matches!(workflow.steps[0].status, StepStatus::Succeeded));
    assert!(matches!(workflow.steps[1].status, StepStatus::Failed));
    assert!(matches!(workflow.steps[2].status, StepStatus::Skipped));
}

/// P3 AC-10: Rollback reverses completed reversible steps.
#[test]
fn workflow_rollback_reversible_steps() {
    let executor = MockExecutor {
        verifications: vec![
            VerificationStatus::Verified,
            VerificationStatus::Verified,
            VerificationStatus::Unexpected, // step 3 → unexpected
        ],
        successes: vec![true, true, true],
        reversible: vec![true, false, true], // step 0 reversible, step 1 not
    };

    let mut workflow = Workflow::new("rollback test", None);
    workflow.add_step(make_step_intent(0, "calendar.create"), vec![], None);
    workflow.add_step(make_step_intent(1, "notification.send"), vec![], None);
    workflow.add_step(make_step_intent(2, "calendar.update"), vec![], None);

    // Execute - aborts at step 2
    let result = execute_workflow(&mut workflow, &executor);
    assert!(matches!(result, WorkflowResult::Aborted));

    // Rollback
    let rollback_result = rollback_workflow(&mut workflow);

    // Step 0 was reversible and succeeded → should be RolledBack
    assert!(
        matches!(workflow.steps[0].status, StepStatus::RolledBack),
        "reversible succeeded step should be rolled back, got: {:?}",
        workflow.steps[0].status
    );
    // Step 1 was NOT reversible → should still be Succeeded
    assert!(
        matches!(workflow.steps[1].status, StepStatus::Succeeded),
        "irreversible step should remain succeeded, got: {:?}",
        workflow.steps[1].status
    );
    assert!(
        rollback_result.steps_rolled_back >= 1,
        "should have rolled back at least 1 step"
    );
}

/// P3 AC-8 variant: partial failure (not Unexpected, just Failed).
#[test]
fn workflow_partial_completion_on_failure() {
    let executor = MockExecutor {
        verifications: vec![
            VerificationStatus::Verified,
            VerificationStatus::Verified,
            VerificationStatus::Verified,
        ],
        successes: vec![true, false, true], // step 1 fails
        reversible: vec![true, true, true],
    };

    let mut workflow = Workflow::new("partial workflow", None);
    workflow.add_step(make_step_intent(0, "calendar.read"), vec![], None);
    workflow.add_step(make_step_intent(1, "app.action"), vec![], None);
    workflow.add_step(make_step_intent(2, "notification.send"), vec![], None);

    let result = execute_workflow(&mut workflow, &executor);

    assert!(
        matches!(result, WorkflowResult::Partial),
        "should be partially completed"
    );
    assert!(matches!(
        workflow.status,
        WorkflowStatus::PartiallyCompleted { failed_at: 1 }
    ));

    // Step 2 should be skipped
    assert!(matches!(workflow.steps[2].status, StepStatus::Skipped));
}
