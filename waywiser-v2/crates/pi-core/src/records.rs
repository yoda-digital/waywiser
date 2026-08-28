//! Operation records — durable log of every session mutation (§7.1).
//!
//! Every mutation to session state is captured as a durable record
//! before the transition occurs (write-ahead).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use pi_types::{
    Branch, EntryId, LaneId, LaneStatus, ReplayPolicy, SteerRequest, TokenUsage,
};

use crate::reducer::CorruptionKind;

/// Every mutation to session state is captured as a durable record.
/// 13 variants covering the full agent lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OperationRecord {
    /// A new turn has started.
    TurnStarted {
        entry_id: EntryId,
        timestamp: DateTime<Utc>,
    },
    /// A turn has completed with usage information.
    TurnCompleted {
        entry_id: EntryId,
        usage: TokenUsage,
        timestamp: DateTime<Utc>,
    },
    /// A tool call has been dispatched.
    ToolCallStarted {
        call_id: String,
        name: String,
        replay: ReplayPolicy,
        timestamp: DateTime<Utc>,
    },
    /// A tool call has finished.
    ToolCallCompleted {
        call_id: String,
        success: bool,
        timestamp: DateTime<Utc>,
    },
    /// A steer request was applied to the session.
    SteerApplied {
        request: SteerRequest,
        timestamp: DateTime<Utc>,
    },
    /// A follow-up turn was queued.
    FollowUpQueued {
        reason: String,
        timestamp: DateTime<Utc>,
    },
    /// An abort was requested.
    AbortRequested {
        timestamp: DateTime<Utc>,
    },
    /// Compaction was performed on a lane.
    CompactionPerformed {
        lane_id: LaneId,
        entries_removed: u32,
        timestamp: DateTime<Utc>,
    },
    /// A new lane was created.
    LaneCreated {
        lane_id: LaneId,
        parent_branch: Option<uuid::Uuid>,
        timestamp: DateTime<Utc>,
    },
    /// A lane's status changed.
    LaneStatusChanged {
        lane_id: LaneId,
        from: LaneStatus,
        to: LaneStatus,
        timestamp: DateTime<Utc>,
    },
    /// A branch was created connecting two lanes.
    BranchCreated {
        branch: Branch,
        timestamp: DateTime<Utc>,
    },
    /// Context was transformed (e.g., identity injection, memory injection).
    ContextTransformed {
        description: String,
        timestamp: DateTime<Utc>,
    },
    /// Recovery was performed after corruption detection.
    RecoveryPerformed {
        kind: CorruptionKind,
        success: bool,
        timestamp: DateTime<Utc>,
    },
}

impl OperationRecord {
    /// Get the timestamp of this record.
    pub fn timestamp(&self) -> DateTime<Utc> {
        match self {
            Self::TurnStarted { timestamp, .. }
            | Self::TurnCompleted { timestamp, .. }
            | Self::ToolCallStarted { timestamp, .. }
            | Self::ToolCallCompleted { timestamp, .. }
            | Self::SteerApplied { timestamp, .. }
            | Self::FollowUpQueued { timestamp, .. }
            | Self::AbortRequested { timestamp }
            | Self::CompactionPerformed { timestamp, .. }
            | Self::LaneCreated { timestamp, .. }
            | Self::LaneStatusChanged { timestamp, .. }
            | Self::BranchCreated { timestamp, .. }
            | Self::ContextTransformed { timestamp, .. }
            | Self::RecoveryPerformed { timestamp, .. } => *timestamp,
        }
    }
}
