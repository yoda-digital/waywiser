//! Workflow executor: step-by-step execution with verification.
//!
//! Between each step: verify pre-conditions and post-action outcome.
//! On UNEXPECTED verification → halt all further steps immediately.

use pi_types::{ActionReceipt, ActionStatus, VerificationStatus};

use crate::workflow::{
    AbortReason, StepStatus, Workflow, WorkflowResult, WorkflowStatus,
};

/// Trait for executing an ActionIntent and returning a receipt.
/// In production, this delegates to the SecurityKernel's ActionPipeline.
pub trait ActionExecutor: Send + Sync {
    fn execute(&self, intent: &pi_types::ActionIntent) -> ActionReceipt;
}

/// Execute a workflow step by step.
///
/// For each step:
/// 1. Check pre-conditions (PriorStepSucceeded checked internally)
/// 2. Call the executor to process the ActionIntent
/// 3. Check verification status from the receipt
/// 4. On Unexpected → halt immediately, set Aborted
/// 5. On failure → PartiallyCompleted
/// 6. All pass → Completed
pub fn execute_workflow(
    workflow: &mut Workflow,
    executor: &dyn ActionExecutor,
) -> WorkflowResult {
    workflow.status = WorkflowStatus::Executing { current_step: 0 };
    workflow.updated_at = chrono::Utc::now();

    let step_count = workflow.steps.len();

    for i in 0..step_count {
        // Update current step
        workflow.status = WorkflowStatus::Executing { current_step: i };

        // 1. Check pre-conditions
        // Need to split borrow: check conditions with a snapshot of prior steps
        let pre_conditions_met = {
            let steps_snapshot: Vec<_> = workflow.steps.iter().cloned().collect();
            workflow.steps[i].check_pre_conditions(&steps_snapshot)
        };

        if !pre_conditions_met {
            workflow.steps[i].status = StepStatus::Failed;
            workflow.status = WorkflowStatus::Aborted {
                reason: AbortReason::PreConditionFailed {
                    step: i,
                    condition: "pre-condition check failed".into(),
                },
            };
            workflow.updated_at = chrono::Utc::now();
            return WorkflowResult::Aborted;
        }

        // 2. Mark executing
        workflow.steps[i].status = StepStatus::Executing;

        // 3. Execute via ActionPipeline
        let receipt = executor.execute(&workflow.steps[i].action_intent);

        // 4. Check result
        let verification = receipt.verification;
        let action_failed = matches!(receipt.status, ActionStatus::Failed { .. });

        workflow.steps[i].actual_verification = Some(verification);
        workflow.steps[i].receipt = Some(receipt);

        // 5. Handle outcome
        if verification == VerificationStatus::Unexpected {
            // HALT — do not execute further steps
            workflow.steps[i].status = StepStatus::Failed;
            workflow.status = WorkflowStatus::Aborted {
                reason: AbortReason::VerificationUnexpected,
            };
            // Mark remaining steps as Skipped
            for j in (i + 1)..step_count {
                workflow.steps[j].status = StepStatus::Skipped;
            }
            workflow.updated_at = chrono::Utc::now();
            return WorkflowResult::Aborted;
        } else if action_failed {
            workflow.steps[i].status = StepStatus::Failed;
            workflow.status = WorkflowStatus::PartiallyCompleted { failed_at: i };
            // Mark remaining steps as Skipped
            for j in (i + 1)..step_count {
                workflow.steps[j].status = StepStatus::Skipped;
            }
            workflow.updated_at = chrono::Utc::now();
            return WorkflowResult::Partial;
        } else if verification == VerificationStatus::Unknown {
            workflow.steps[i].status = StepStatus::UnknownSideEffect;
            // Continue with caution — next step's pre-conditions will check
        } else {
            workflow.steps[i].status = StepStatus::Succeeded;
        }
    }

    workflow.status = WorkflowStatus::Completed;
    workflow.updated_at = chrono::Utc::now();
    WorkflowResult::Completed
}
