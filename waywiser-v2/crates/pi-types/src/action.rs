//! ActionIntent (§17), ActionReceipt (§19), and replay semantics (§20).
//!
//! Protected side effects enter the system as durable typed proposals.
//! Every meaningful side effect produces a durable receipt.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::{CapabilityName, GoalId, SessionId, WorkItemId};

/// Where the action originated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ActionOrigin {
    PrimaryAgent {
        session_id: SessionId,
    },
    DelegatedAgent {
        session_id: SessionId,
        parent_session_id: SessionId,
    },
    DeterministicAutomation {
        rule_id: String,
    },
    UserDirect,
    ProactiveEngine,
}

/// Reference to evidence supporting an action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub kind: String,
    pub reference: String,
}

/// A durable typed proposal for a protected side effect (§17).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionIntent {
    pub id: Uuid,
    pub origin: ActionOrigin,
    pub capability: CapabilityName,
    pub arguments: serde_json::Value,
    pub reason: String,

    pub session_id: SessionId,
    pub goal_id: Option<GoalId>,
    pub work_item_id: Option<WorkItemId>,

    pub evidence: Vec<EvidenceRef>,
    pub idempotency_key: String,
    pub requested_at: DateTime<Utc>,
}

impl ActionIntent {
    /// Create a new intent with generated ID and timestamp.
    pub fn new(
        origin: ActionOrigin,
        capability: CapabilityName,
        arguments: serde_json::Value,
        reason: impl Into<String>,
        session_id: SessionId,
    ) -> Self {
        let id = Uuid::now_v7();
        Self {
            idempotency_key: id.to_string(),
            id,
            origin,
            capability,
            arguments,
            reason: reason.into(),
            session_id,
            goal_id: None,
            work_item_id: None,
            evidence: Vec::new(),
            requested_at: Utc::now(),
        }
    }
}

/// Status of an action through the pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ActionStatus {
    Pending,
    Executing,
    Completed,
    Failed { reason: String },
    /// Process died between dispatch and confirmation (§20).
    UnknownSideEffect,
}

/// Result of post-action verification (§25).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VerificationStatus {
    Verified,
    Likely,
    Unexpected,
    Unknown,
    NotChecked,
}

/// Replay policy per capability (§20).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReplayPolicy {
    SafeReplay,
    NeverReplay,
    VerifyBeforeRetry,
}

/// Durable receipt for every meaningful side effect (§19).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionReceipt {
    pub intent_id: Uuid,
    pub capability: CapabilityName,

    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,

    pub status: ActionStatus,
    pub external_reference: Option<String>,

    pub reversible: bool,
    pub undo_token: Option<String>,

    pub verification: VerificationStatus,
    pub result_summary: Option<String>,
}

impl ActionReceipt {
    /// Create a denied receipt (no execution occurred).
    pub fn denied(intent: &ActionIntent, started_at: DateTime<Utc>, reason: &str) -> Self {
        Self {
            intent_id: intent.id,
            capability: intent.capability.clone(),
            started_at,
            completed_at: Some(Utc::now()),
            status: ActionStatus::Failed {
                reason: reason.to_string(),
            },
            external_reference: None,
            reversible: false,
            undo_token: None,
            verification: VerificationStatus::NotChecked,
            result_summary: Some(format!("Denied: {reason}")),
        }
    }

    /// Create a receipt from an intent (for building up during pipeline).
    pub fn from_intent(intent: &ActionIntent) -> Self {
        Self {
            intent_id: intent.id,
            capability: intent.capability.clone(),
            started_at: Utc::now(),
            completed_at: None,
            status: ActionStatus::Pending,
            external_reference: None,
            reversible: false,
            undo_token: None,
            verification: VerificationStatus::NotChecked,
            result_summary: None,
        }
    }
}
