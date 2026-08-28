//! Compensating actions for reversible workflow steps.

use crate::workflow::{StepStatus, Workflow, WorkflowStatus};

/// Result of a rollback attempt.
#[derive(Debug, Clone)]
pub struct RollbackResult {
    /// How many steps were successfully rolled back.
    pub steps_rolled_back: usize,
    /// Steps that could not be rolled back (irreversible).
    pub steps_skipped: usize,
}

/// Attempt to roll back completed reversible steps in reverse order.
///
/// Iterates steps from last to first. For each Succeeded step:
/// - If the receipt indicates `reversible == true` → mark RolledBack
/// - Otherwise → skip (irreversible, can't undo a sent email)
pub fn rollback_workflow(workflow: &mut Workflow) -> RollbackResult {
    let from_step = workflow
        .steps
        .iter()
        .rposition(|s| s.status == StepStatus::Succeeded || s.status == StepStatus::UnknownSideEffect)
        .unwrap_or(0);

    workflow.status = WorkflowStatus::RollingBack { from_step };

    let mut rolled = 0;
    let mut skipped = 0;

    for step in workflow.steps.iter_mut().rev() {
        if step.status != StepStatus::Succeeded {
            continue;
        }

        let is_reversible = step
            .receipt
            .as_ref()
            .map(|r| r.reversible && r.undo_token.is_some())
            .unwrap_or(false);

        if is_reversible {
            // In production, we'd execute the undo action here via the SecurityKernel.
            // For now, we mark the step as rolled back.
            step.status = StepStatus::RolledBack;
            rolled += 1;
        } else {
            // Irreversible — can't undo
            skipped += 1;
        }
    }

    // Update workflow status
    if rolled > 0 || skipped > 0 {
        workflow.status = WorkflowStatus::Aborted {
            reason: crate::workflow::AbortReason::UserCancelled,
        };
    }

    workflow.updated_at = chrono::Utc::now();

    RollbackResult {
        steps_rolled_back: rolled,
        steps_skipped: skipped,
    }
}
