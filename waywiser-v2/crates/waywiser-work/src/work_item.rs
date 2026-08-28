//! Work items — individual tasks within the work graph.

use chrono::{DateTime, Utc};
use pi_types::{EvidenceRef, GoalId, SessionId, WorkItemId};
use serde::{Deserialize, Serialize};
use crate::goal::Priority;

/// Lifecycle status of a work item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkStatus {
    /// Newly created, not yet ready to work on.
    Proposed,
    /// All dependencies met, available for assignment.
    Ready,
    /// An agent is actively working on this.
    Running,
    /// Work complete, awaiting user or orchestrator review.
    Review,
    /// Successfully completed.
    Done,
    /// Cannot proceed.
    Blocked(BlockReason),
}

impl WorkStatus {
    /// Returns the canonical column name for kanban projection.
    pub fn column_name(&self) -> &'static str {
        match self {
            Self::Proposed => "Backlog",
            Self::Ready => "Ready",
            Self::Running => "In Progress",
            Self::Review => "Review",
            Self::Done => "Done",
            Self::Blocked(_) => "Blocked",
        }
    }
}

/// Reason a work item is blocked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockReason {
    pub reason: String,
    pub blocked_by: Option<WorkItemId>,
}

/// Who is assigned to a work item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentAssignment {
    /// The primary user-facing agent.
    Primary,
    /// A delegated child agent.
    Delegated {
        agent_class: String,
        session_id: SessionId,
    },
}

/// Approval state for a work item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalState {
    NotRequired,
    Pending,
    Approved { at: DateTime<Utc> },
    Rejected { reason: String },
}

/// The result of completed work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkResult {
    pub summary: String,
    pub artifacts: Vec<String>,
}

/// A unit of work in the work graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkItem {
    pub id: WorkItemId,
    pub goal_id: Option<GoalId>,
    pub title: String,
    pub description: String,
    pub status: WorkStatus,
    pub priority: Priority,
    pub dependencies: Vec<WorkItemId>,
    pub assignee: Option<AgentAssignment>,
    pub agent_session_id: Option<SessionId>,
    pub attempts: u32,
    pub due_at: Option<DateTime<Utc>>,
    pub evidence: Vec<EvidenceRef>,
    pub result: Option<WorkResult>,
    pub approval_state: ApprovalState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl WorkItem {
    /// Check whether this item can transition to the given status.
    pub fn can_transition_to(&self, to: &WorkStatus) -> bool {
        matches!(
            (&self.status, to),
            (WorkStatus::Proposed, WorkStatus::Ready)
                | (WorkStatus::Proposed, WorkStatus::Blocked(_))
                | (WorkStatus::Ready, WorkStatus::Running)
                | (WorkStatus::Ready, WorkStatus::Blocked(_))
                | (WorkStatus::Running, WorkStatus::Review)
                | (WorkStatus::Running, WorkStatus::Done)
                | (WorkStatus::Running, WorkStatus::Blocked(_))
                | (WorkStatus::Review, WorkStatus::Done)
                | (WorkStatus::Review, WorkStatus::Running) // sent back for rework
                | (WorkStatus::Blocked(_), WorkStatus::Ready)
                | (WorkStatus::Blocked(_), WorkStatus::Proposed)
        )
    }
}

/// Input for creating a new work item.
#[derive(Debug, Clone)]
pub struct NewWorkItem {
    pub goal_id: Option<GoalId>,
    pub title: String,
    pub description: String,
    pub priority: Priority,
    pub dependencies: Vec<WorkItemId>,
}
