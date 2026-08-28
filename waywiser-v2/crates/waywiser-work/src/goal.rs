//! Goals — high-level objectives that work items serve.

use chrono::{DateTime, Utc};
use pi_types::GoalId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Priority level for goals and work items.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Priority {
    Low,
    Medium,
    High,
    Critical,
}

/// Lifecycle status of a goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GoalStatus {
    Active,
    Paused,
    Completed,
    Abandoned,
}

/// A high-level objective. Work items are organized under goals.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Goal {
    pub id: GoalId,
    pub title: String,
    pub description: String,
    pub priority: Priority,
    pub status: GoalStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Goal {
    /// Create a new active goal.
    pub fn new(title: String, description: String, priority: Priority) -> Self {
        let now = Utc::now();
        Self {
            id: GoalId(Uuid::now_v7()),
            title,
            description,
            priority,
            status: GoalStatus::Active,
            created_at: now,
            updated_at: now,
        }
    }
}
