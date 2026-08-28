//! Agent class definitions, child agent lifecycle, capability filtering.

use chrono::{DateTime, Utc};
use pi_types::{AgentId, SessionId, WorkItemId};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::budget::{DelegationBudget, DelegationUsage};

/// Agent role classification. Determines capabilities, delegation rights, and priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentClass {
    /// Full user-facing context.
    Primary,
    /// Focused context, CANNOT delegate.
    Leaf,
    /// May create children within budget. Max depth still 2.
    Orchestrator,
    /// Internal Brain work, NO external side effects.
    CognitionWorker,
    /// Can inspect evidence, CANNOT mutate external state. Read-only capabilities only.
    Verification,
}

impl AgentClass {
    /// Whether this agent class is allowed to delegate (spawn children).
    pub fn can_delegate(&self) -> bool {
        matches!(self, Self::Primary | Self::Orchestrator)
    }

    /// Capability filter for this agent class.
    pub fn capability_filter(&self) -> CapabilityFilter {
        match self {
            Self::Primary => CapabilityFilter::Full,
            Self::Orchestrator => CapabilityFilter::InheritParent,
            Self::Leaf => CapabilityFilter::InheritParent,
            Self::CognitionWorker => CapabilityFilter::InternalOnly,
            Self::Verification => CapabilityFilter::ReadOnly,
        }
    }

    /// Inference priority for scheduling. Lower number = higher priority.
    pub fn inference_priority(&self) -> u8 {
        match self {
            Self::Primary => 0,       // P0: interactive
            Self::Leaf => 2,          // P2: delegated
            Self::Orchestrator => 1,  // P1: foreground orchestration
            Self::CognitionWorker => 3, // P3: reflection
            Self::Verification => 2,  // P2: delegated verification
        }
    }
}

/// Determines which capabilities a child agent inherits from its parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CapabilityFilter {
    /// All capabilities available.
    Full,
    /// Inherits parent's capabilities minus explicit restrictions.
    InheritParent,
    /// Read-only capabilities only. Cannot mutate external state.
    ReadOnly,
    /// Internal operations only. No external side effects (max_external_writes = 0).
    InternalOnly,
}

/// A child agent managed by the supervisor.
#[derive(Debug, Clone)]
pub struct ChildAgent {
    pub id: AgentId,
    pub class: AgentClass,
    pub session_id: SessionId,
    pub parent_id: AgentId,
    pub budget: DelegationBudget,
    pub usage: DelegationUsage,
    pub status: ChildAgentStatus,
    pub work_item_id: Option<WorkItemId>,
    pub created_at: DateTime<Utc>,
}

impl ChildAgent {
    /// Create a new child agent.
    pub fn new(
        class: AgentClass,
        session_id: SessionId,
        parent_id: AgentId,
        budget: DelegationBudget,
        work_item_id: Option<WorkItemId>,
    ) -> Self {
        Self {
            id: AgentId::new(),
            class,
            session_id,
            parent_id,
            budget,
            usage: DelegationUsage::default(),
            status: ChildAgentStatus::Initializing,
            work_item_id,
            created_at: Utc::now(),
        }
    }

    /// Whether this agent is still active (not terminal).
    pub fn is_active(&self) -> bool {
        matches!(
            self.status,
            ChildAgentStatus::Initializing
                | ChildAgentStatus::Running
                | ChildAgentStatus::WaitingForInference
        )
    }
}

/// Lifecycle status of a child agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChildAgentStatus {
    /// Being set up, context not yet loaded.
    Initializing,
    /// Actively processing.
    Running,
    /// Queued behind higher-priority work.
    WaitingForInference,
    /// Successfully completed.
    Completed(AgentResult),
    /// Failed with error.
    Failed(AgentError),
    /// User or parent cancelled.
    Cancelled,
    /// Exceeded delegation budget.
    BudgetExceeded(BudgetViolation),
}

/// Result of a completed agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentResult {
    pub summary: String,
    pub artifacts: Vec<String>,
    pub tokens_used: u64,
    pub wall_time: Duration,
}

/// Error from a failed agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentError {
    pub message: String,
    pub recoverable: bool,
}

/// Which budget limit was exceeded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BudgetViolation {
    InputTokens { used: u64, max: u64 },
    OutputTokens { used: u64, max: u64 },
    WallTime { elapsed: Duration, max: Duration },
    ExternalWrites { used: u32, max: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_delegate() {
        assert!(AgentClass::Primary.can_delegate());
        assert!(AgentClass::Orchestrator.can_delegate());
        assert!(!AgentClass::Leaf.can_delegate());
        assert!(!AgentClass::CognitionWorker.can_delegate());
        assert!(!AgentClass::Verification.can_delegate());
    }

    #[test]
    fn test_capability_filter() {
        assert_eq!(AgentClass::Primary.capability_filter(), CapabilityFilter::Full);
        assert_eq!(AgentClass::CognitionWorker.capability_filter(), CapabilityFilter::InternalOnly);
        assert_eq!(AgentClass::Verification.capability_filter(), CapabilityFilter::ReadOnly);
        assert_eq!(AgentClass::Leaf.capability_filter(), CapabilityFilter::InheritParent);
    }

    #[test]
    fn test_inference_priority_ordering() {
        assert!(AgentClass::Primary.inference_priority() < AgentClass::Orchestrator.inference_priority());
        assert!(AgentClass::Orchestrator.inference_priority() < AgentClass::Leaf.inference_priority());
        assert!(AgentClass::Leaf.inference_priority() < AgentClass::CognitionWorker.inference_priority());
    }
}
