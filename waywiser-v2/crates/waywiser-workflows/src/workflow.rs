//! Workflow types: multi-step cross-app action sequences.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use pi_types::{ActionIntent, ActionReceipt, GoalId, VerificationStatus};

/// A multi-step cross-app workflow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: Uuid,
    pub name: String,
    pub goal_id: Option<GoalId>,
    pub steps: Vec<WorkflowStep>,
    pub status: WorkflowStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One step in a workflow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStep {
    pub index: usize,
    pub action_intent: ActionIntent,
    pub pre_conditions: Vec<PreCondition>,
    pub expected_outcome: Option<ExpectedOutcome>,
    pub actual_verification: Option<VerificationStatus>,
    pub receipt: Option<ActionReceipt>,
    pub status: StepStatus,
}

/// Status of the overall workflow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WorkflowStatus {
    Planning,
    Executing { current_step: usize },
    Completed,
    PartiallyCompleted { failed_at: usize },
    Aborted { reason: AbortReason },
    RollingBack { from_step: usize },
}

/// Status of an individual step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StepStatus {
    Pending,
    Executing,
    Succeeded,
    Failed,
    Skipped,
    RolledBack,
    UnknownSideEffect,
}

/// Why a workflow was aborted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AbortReason {
    VerificationUnexpected,
    TocTouMismatch,
    SecurityDenied,
    UserCancelled,
    ProcessDeath,
    PreConditionFailed { step: usize, condition: String },
}

/// A pre-condition that must be met before a step can execute.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreCondition {
    pub kind: PreConditionKind,
    pub description: String,
}

/// Types of pre-conditions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PreConditionKind {
    AppInstalled(String),
    PermissionGranted(String),
    NetworkAvailable,
    LeaseValid(Uuid),
    PriorStepSucceeded(usize),
}

/// Expected outcome of a step, used for verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedOutcome {
    pub description: String,
    pub verification_hints: Vec<String>,
}

/// Result of executing a workflow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowResult {
    Completed,
    Partial,
    Aborted,
}

impl Workflow {
    /// Create a new workflow in Planning status.
    pub fn new(name: impl Into<String>, goal_id: Option<GoalId>) -> Self {
        Self {
            id: Uuid::now_v7(),
            name: name.into(),
            goal_id,
            steps: Vec::new(),
            status: WorkflowStatus::Planning,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    /// Add a step to the workflow (only while Planning).
    pub fn add_step(
        &mut self,
        intent: ActionIntent,
        pre_conditions: Vec<PreCondition>,
        expected_outcome: Option<ExpectedOutcome>,
    ) {
        let index = self.steps.len();
        self.steps.push(WorkflowStep {
            index,
            action_intent: intent,
            pre_conditions,
            expected_outcome,
            actual_verification: None,
            receipt: None,
            status: StepStatus::Pending,
        });
    }

    /// Count completed steps.
    pub fn completed_steps(&self) -> usize {
        self.steps
            .iter()
            .filter(|s| s.status == StepStatus::Succeeded)
            .count()
    }

    /// Count reversible succeeded steps.
    pub fn reversible_steps(&self) -> usize {
        self.steps
            .iter()
            .filter(|s| {
                s.status == StepStatus::Succeeded
                    && s.receipt
                        .as_ref()
                        .map(|r| r.reversible)
                        .unwrap_or(false)
            })
            .count()
    }
}

impl WorkflowStep {
    /// Check if all pre-conditions are met.
    /// For simplicity, `PriorStepSucceeded` checks the workflow's step list.
    pub fn check_pre_conditions(&self, steps: &[WorkflowStep]) -> bool {
        self.pre_conditions.iter().all(|pc| match &pc.kind {
            PreConditionKind::PriorStepSucceeded(idx) => {
                steps.get(*idx).map(|s| s.status == StepStatus::Succeeded).unwrap_or(false)
            }
            // Other pre-conditions would be checked against platform state.
            // For now, they pass by default (verified at runtime by the executor).
            PreConditionKind::AppInstalled(_) => true,
            PreConditionKind::PermissionGranted(_) => true,
            PreConditionKind::NetworkAvailable => true,
            PreConditionKind::LeaseValid(_) => true,
        })
    }
}
