//! Delegation budgets: resource limits for child agents.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Resource limits for a delegated agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationBudget {
    /// Maximum number of children this agent can spawn. Default: 4.
    pub max_children: u8,
    /// Maximum delegation depth. HARD CAP: 2.
    pub max_depth: u8,
    /// Maximum input tokens per child.
    pub max_input_tokens: u64,
    /// Maximum output tokens per child.
    pub max_output_tokens: u64,
    /// Maximum wall-clock time per child.
    pub max_wall_time: Duration,
    /// Maximum external write operations. CognitionWorker: always 0.
    pub max_external_writes: u32,
}

impl Default for DelegationBudget {
    fn default() -> Self {
        Self {
            max_children: 4,
            max_depth: 2,
            max_input_tokens: 100_000,
            max_output_tokens: 50_000,
            max_wall_time: Duration::from_secs(300), // 5 minutes
            max_external_writes: 10,
        }
    }
}

impl DelegationBudget {
    /// Create a budget for a CognitionWorker (no external writes).
    pub fn cognition_worker() -> Self {
        Self {
            max_children: 0,
            max_depth: 0,
            max_input_tokens: 50_000,
            max_output_tokens: 20_000,
            max_wall_time: Duration::from_secs(600), // 10 minutes for reflection
            max_external_writes: 0, // NEVER
        }
    }

    /// Create a budget for a Verification agent (read-only, no children).
    pub fn verification() -> Self {
        Self {
            max_children: 0,
            max_depth: 0,
            max_input_tokens: 30_000,
            max_output_tokens: 10_000,
            max_wall_time: Duration::from_secs(120),
            max_external_writes: 0,
        }
    }

    /// Check whether this budget can cover the requested resources.
    pub fn can_cover(&self, requested: &DelegationBudget) -> bool {
        requested.max_input_tokens <= self.max_input_tokens
            && requested.max_output_tokens <= self.max_output_tokens
            && requested.max_wall_time <= self.max_wall_time
            && requested.max_external_writes <= self.max_external_writes
    }

    /// Cap the requested budget at the parent's remaining budget.
    pub fn cap_at(&self, parent_remaining: &DelegationBudget) -> DelegationBudget {
        DelegationBudget {
            max_children: self.max_children.min(parent_remaining.max_children),
            max_depth: self.max_depth.min(parent_remaining.max_depth),
            max_input_tokens: self.max_input_tokens.min(parent_remaining.max_input_tokens),
            max_output_tokens: self.max_output_tokens.min(parent_remaining.max_output_tokens),
            max_wall_time: self.max_wall_time.min(parent_remaining.max_wall_time),
            max_external_writes: self.max_external_writes.min(parent_remaining.max_external_writes),
        }
    }

    /// Remaining budget after subtracting usage.
    pub fn remaining(&self, usage: &DelegationUsage) -> DelegationBudget {
        DelegationBudget {
            max_children: self.max_children.saturating_sub(usage.children_spawned),
            max_depth: self.max_depth,
            max_input_tokens: self.max_input_tokens.saturating_sub(usage.input_tokens_used),
            max_output_tokens: self.max_output_tokens.saturating_sub(usage.output_tokens_used),
            max_wall_time: self.max_wall_time.saturating_sub(usage.wall_time_used),
            max_external_writes: self.max_external_writes.saturating_sub(usage.external_writes_used),
        }
    }
}

/// Tracks how much of the delegation budget has been consumed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DelegationUsage {
    pub children_spawned: u8,
    pub input_tokens_used: u64,
    pub output_tokens_used: u64,
    pub wall_time_used: Duration,
    pub external_writes_used: u32,
}

impl DelegationUsage {
    /// Check if a budget violation has occurred.
    pub fn check_violation(&self, budget: &DelegationBudget) -> Option<super::agent::BudgetViolation> {
        use super::agent::BudgetViolation;
        if self.input_tokens_used > budget.max_input_tokens {
            return Some(BudgetViolation::InputTokens {
                used: self.input_tokens_used,
                max: budget.max_input_tokens,
            });
        }
        if self.output_tokens_used > budget.max_output_tokens {
            return Some(BudgetViolation::OutputTokens {
                used: self.output_tokens_used,
                max: budget.max_output_tokens,
            });
        }
        if self.wall_time_used > budget.max_wall_time {
            return Some(BudgetViolation::WallTime {
                elapsed: self.wall_time_used,
                max: budget.max_wall_time,
            });
        }
        if self.external_writes_used > budget.max_external_writes {
            return Some(BudgetViolation::ExternalWrites {
                used: self.external_writes_used,
                max: budget.max_external_writes,
            });
        }
        None
    }
}
