//! Agent coordination: work item locking, depth enforcement, budget cascading.

use pi_types::{AgentId, WorkItemId};
use std::collections::HashMap;

use crate::budget::DelegationBudget;

/// Error when claiming a work item already held by another agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictError {
    pub item: WorkItemId,
    pub holder: AgentId,
}

impl std::fmt::Display for ConflictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "work item {:?} already claimed by agent {:?}",
            self.item, self.holder
        )
    }
}

impl std::error::Error for ConflictError {}

/// Error when delegation depth exceeded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepthError {
    pub current: usize,
    pub max: usize,
}

impl std::fmt::Display for DepthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "depth {}, max {}", self.current, self.max)
    }
}

impl std::error::Error for DepthError {}

/// Error when budget allocation fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BudgetError {
    InsufficientParentBudget,
    ParentNotFound(AgentId),
}

impl std::fmt::Display for BudgetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InsufficientParentBudget => write!(f, "insufficient parent budget"),
            Self::ParentNotFound(id) => write!(f, "parent agent not found: {id:?}"),
        }
    }
}

impl std::error::Error for BudgetError {}

/// State of a tracked agent.
#[derive(Debug, Clone)]
pub struct AgentState {
    pub parent_id: Option<AgentId>,
    pub depth: usize,
    pub budget: DelegationBudget,
    pub children_spawned: u8,
}

/// Coordinates multiple agents: work item locking, depth enforcement, budget cascading.
pub struct AgentCoordinator {
    pub active_agents: HashMap<AgentId, AgentState>,
    pub work_locks: HashMap<WorkItemId, AgentId>,
}

impl AgentCoordinator {
    pub fn new() -> Self {
        Self {
            active_agents: HashMap::new(),
            work_locks: HashMap::new(),
        }
    }

    /// Register an agent in the coordinator.
    pub fn register_agent(
        &mut self,
        id: AgentId,
        parent_id: Option<AgentId>,
        depth: usize,
        budget: DelegationBudget,
    ) {
        self.active_agents.insert(
            id,
            AgentState {
                parent_id,
                depth,
                budget,
                children_spawned: 0,
            },
        );
    }

    /// Remove an agent from the coordinator.
    pub fn unregister_agent(&mut self, id: &AgentId) {
        self.active_agents.remove(id);
        // Release any work items held by this agent
        self.work_locks.retain(|_, holder| holder != id);
    }

    /// Claim a work item for an agent. Prevents two agents from working on the same item.
    pub fn claim_work_item(
        &mut self,
        agent: AgentId,
        item: WorkItemId,
    ) -> Result<(), ConflictError> {
        if let Some(&holder) = self.work_locks.get(&item) {
            if holder != agent {
                return Err(ConflictError {
                    item,
                    holder,
                });
            }
        }
        self.work_locks.insert(item, agent);
        Ok(())
    }

    /// Release a work item.
    pub fn release_work_item(&mut self, item: &WorkItemId) {
        self.work_locks.remove(item);
    }

    /// Check whether a parent can spawn children at the current depth.
    /// Invariant: max 2 levels.
    pub fn check_depth(&self, parent: AgentId) -> Result<(), DepthError> {
        let depth = self.agent_depth(parent);
        let max_depth = 2;
        if depth >= max_depth {
            Err(DepthError {
                current: depth,
                max: max_depth,
            })
        } else {
            Ok(())
        }
    }

    /// Get the depth of an agent from the root.
    pub fn agent_depth(&self, agent: AgentId) -> usize {
        self.active_agents
            .get(&agent)
            .map(|state| state.depth)
            .unwrap_or(0)
    }

    /// Allocate a child budget from a parent's remaining budget.
    /// Child budget is capped at the parent's remaining budget.
    pub fn allocate_child_budget(
        &self,
        parent: AgentId,
        requested: &DelegationBudget,
    ) -> Result<DelegationBudget, BudgetError> {
        let parent_state = self
            .active_agents
            .get(&parent)
            .ok_or(BudgetError::ParentNotFound(parent))?;

        let parent_remaining = &parent_state.budget;
        if !parent_remaining.can_cover(requested) {
            return Err(BudgetError::InsufficientParentBudget);
        }

        Ok(requested.cap_at(parent_remaining))
    }

    /// Get the holder of a work item.
    pub fn work_item_holder(&self, item: &WorkItemId) -> Option<AgentId> {
        self.work_locks.get(item).copied()
    }
}

impl Default for AgentCoordinator {
    fn default() -> Self {
        Self::new()
    }
}
