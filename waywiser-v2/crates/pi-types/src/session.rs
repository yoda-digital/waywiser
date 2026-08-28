//! Session state types (§7.1).
//!
//! Durable session: a tree of lanes with branches.
//! Sessions, branching, lanes, compaction, operation records,
//! queue semantics, recovery semantics.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::{EntryId, LaneId, SessionId};
use crate::message::AgentMessage;

/// Durable session: a tree of lanes with branches (§7.1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub id: SessionId,
    pub lanes: Vec<Lane>,
    pub active_lane_id: LaneId,
    pub branches: Vec<Branch>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub usage: AggregateUsage,
    pub metadata: serde_json::Value,
}

impl SessionState {
    /// Create a new session with a single empty lane.
    pub fn new() -> Self {
        let lane_id = LaneId::new();
        Self {
            id: SessionId::new(),
            lanes: vec![Lane::new(lane_id)],
            active_lane_id: lane_id,
            branches: Vec::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            usage: AggregateUsage::default(),
            metadata: serde_json::Value::Null,
        }
    }

    /// Get the active lane.
    pub fn active_lane(&self) -> Option<&Lane> {
        self.lanes.iter().find(|l| l.id == self.active_lane_id)
    }

    /// Get a mutable reference to the active lane.
    pub fn active_lane_mut(&mut self) -> Option<&mut Lane> {
        let id = self.active_lane_id;
        self.lanes.iter_mut().find(|l| l.id == id)
    }
}

impl Default for SessionState {
    fn default() -> Self {
        Self::new()
    }
}

/// A lane within a session — holds entries and a work queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lane {
    pub id: LaneId,
    pub entries: Vec<Entry>,
    pub queue: LaneQueue,
    pub status: LaneStatus,
    pub parent_branch: Option<Uuid>,
}

impl Lane {
    pub fn new(id: LaneId) -> Self {
        Self {
            id,
            entries: Vec::new(),
            queue: LaneQueue::default(),
            status: LaneStatus::Active,
            parent_branch: None,
        }
    }
}

/// Pending work queue for a lane.
/// Priority order: pending_steer > pending_follow_up > next_run > deferred.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LaneQueue {
    pub pending_steer: Option<SteerRequest>,
    pub pending_follow_up: Option<FollowUpRequest>,
    pub next_run: Option<NextRunRequest>,
    pub deferred: Vec<DeferredItem>,
}

impl LaneQueue {
    /// Whether there is any pending work.
    pub fn has_pending(&self) -> bool {
        self.pending_steer.is_some()
            || self.pending_follow_up.is_some()
            || self.next_run.is_some()
            || !self.deferred.is_empty()
    }
}

/// Status of a lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LaneStatus {
    Active,
    Paused,
    Completed,
    Failed,
}

/// An entry in a lane — wraps an AgentMessage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: EntryId,
    pub message: AgentMessage,
}

/// A branch point connecting two lanes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Branch {
    pub id: Uuid,
    pub parent_lane_id: LaneId,
    pub child_lane_id: LaneId,
    pub branch_point: EntryId,
    pub reason: String,
}

/// Request to steer the current turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SteerRequest {
    pub content: String,
    pub requested_at: DateTime<Utc>,
}

/// Request for a follow-up turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowUpRequest {
    pub reason: String,
    pub requested_at: DateTime<Utc>,
}

/// Request for the next run with context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextRunRequest {
    pub context: serde_json::Value,
}

/// An item deferred for later processing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeferredItem {
    pub id: Uuid,
    pub payload: serde_json::Value,
    pub deferred_at: DateTime<Utc>,
}

/// Aggregate token usage across a session.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AggregateUsage {
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_thinking_tokens: u64,
    pub turn_count: u32,
}
