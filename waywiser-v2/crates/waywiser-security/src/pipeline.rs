//! Action Pipeline — 9-stage intent-to-receipt lifecycle (blueprint §§17-20).
//!
//! Lifecycle states:
//!   Proposed → CapabilityCheck → RiskClassification → PolicyCheck →
//!   LeaseCheck → OsPermissionCheck → UserApproval → Authorized →
//!   Executing → Verifying → Completed
//!
//! Crash recovery uses ReplayPolicy per capability.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use pi_types::{ActionIntent, ActionReceipt, ActionStatus, ReplayPolicy, VerificationStatus};

use crate::kernel::{SecurityDecision, SecurityKernel};

/// Lifecycle stages of an ActionIntent through the pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PipelineStage {
    Proposed,
    CapabilityCheck,
    RiskClassification,
    PolicyCheck,
    LeaseCheck,
    OsPermissionCheck,
    UserApproval,
    Authorized,
    Executing,
    Verifying,
    Completed,
    Denied,
    Failed,
    UnknownSideEffect,
}

/// The full pipeline executor.
pub struct ActionPipeline {
    kernel: SecurityKernel,
}

/// Recovery action for crash recovery.
#[derive(Debug, Clone)]
pub enum RecoveryAction {
    /// Safe to retry — idempotent or stateless.
    Retry(ActionIntent),
    /// Mark as failed — never replay.
    MarkFailed(ActionIntent, &'static str),
    /// Verify external state before deciding.
    VerifyThenDecide(ActionIntent),
}

impl ActionPipeline {
    /// Create a pipeline wrapping a security kernel.
    pub fn new(kernel: SecurityKernel) -> Self {
        Self { kernel }
    }

    /// Access the inner kernel.
    pub fn kernel(&self) -> &SecurityKernel {
        &self.kernel
    }

    /// Access the inner kernel mutably.
    pub fn kernel_mut(&mut self) -> &mut SecurityKernel {
        &mut self.kernel
    }

    /// Process an intent through the full pipeline.
    /// Returns a receipt even for denials.
    pub fn process(&mut self, intent: &ActionIntent) -> ActionReceipt {
        let started_at = Utc::now();

        // Steps 1-6 via SecurityKernel
        let decision = self.kernel.authorize(intent);

        match decision {
            SecurityDecision::Allowed(_auth) => {
                // Steps 7-9: Execute, verify, receipt
                // In production, this dispatches to the capability executor.
                // Here we return a successful receipt.
                ActionReceipt {
                    intent_id: intent.id,
                    capability: intent.capability.clone(),
                    started_at,
                    completed_at: Some(Utc::now()),
                    status: ActionStatus::Completed,
                    external_reference: None,
                    reversible: false,
                    undo_token: None,
                    verification: VerificationStatus::NotChecked,
                    result_summary: Some("Executed successfully".to_string()),
                }
            }
            SecurityDecision::RequiresApproval(kind) => {
                // In production, this prompts the user and waits.
                // Here we return a pending receipt indicating approval needed.
                ActionReceipt {
                    intent_id: intent.id,
                    capability: intent.capability.clone(),
                    started_at,
                    completed_at: Some(Utc::now()),
                    status: ActionStatus::Pending,
                    external_reference: None,
                    reversible: false,
                    undo_token: None,
                    verification: VerificationStatus::NotChecked,
                    result_summary: Some(format!("Requires approval: {:?}", kind)),
                }
            }
            SecurityDecision::Denied(reason) => ActionReceipt {
                intent_id: intent.id,
                capability: intent.capability.clone(),
                started_at,
                completed_at: Some(Utc::now()),
                status: ActionStatus::Failed {
                    reason: format!("{:?}", reason),
                },
                external_reference: None,
                reversible: false,
                undo_token: None,
                verification: VerificationStatus::NotChecked,
                result_summary: Some(format!("Denied: {:?}", reason)),
            },
        }
    }

    /// Crash recovery: determine what to do with pending intents found after restart.
    pub fn recover_after_crash(
        &self,
        pending: Vec<ActionIntent>,
    ) -> Vec<RecoveryAction> {
        pending
            .into_iter()
            .map(|intent| {
                let spec = self.kernel.registry.get(&intent.capability);
                match spec.map(|s| s.replay_policy) {
                    Some(ReplayPolicy::SafeReplay) => RecoveryAction::Retry(intent),
                    Some(ReplayPolicy::NeverReplay) => {
                        RecoveryAction::MarkFailed(intent, "never-replay policy")
                    }
                    Some(ReplayPolicy::VerifyBeforeRetry) => {
                        RecoveryAction::VerifyThenDecide(intent)
                    }
                    None => RecoveryAction::MarkFailed(intent, "unknown capability"),
                }
            })
            .collect()
    }
}
