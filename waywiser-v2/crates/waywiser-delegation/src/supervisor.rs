//! Agent supervisor: manages child agent lifecycle and scheduling.

use pi_types::{AgentId, WorkItemId};

use crate::agent::{AgentClass, AgentError, AgentResult, BudgetViolation, ChildAgent, ChildAgentStatus};
use crate::budget::DelegationBudget;
use crate::context::FocusedContext;

/// Error from delegation operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DelegationError {
    /// Exceeded maximum number of children.
    MaxChildrenExceeded { current: usize, max: u8 },
    /// Exceeded maximum delegation depth.
    MaxDepthExceeded { current: usize, max: u8 },
    /// Agent class cannot delegate.
    CannotDelegate(AgentClass),
    /// Budget insufficient for child.
    InsufficientBudget(String),
    /// Agent not found.
    AgentNotFound(AgentId),
    /// Agent already in terminal state.
    AgentNotActive(AgentId),
}

impl std::fmt::Display for DelegationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MaxChildrenExceeded { current, max } => {
                write!(f, "max children exceeded: {current}/{max}")
            }
            Self::MaxDepthExceeded { current, max } => {
                write!(f, "max depth exceeded: {current}/{max}")
            }
            Self::CannotDelegate(class) => write!(f, "agent class {class:?} cannot delegate"),
            Self::InsufficientBudget(reason) => write!(f, "insufficient budget: {reason}"),
            Self::AgentNotFound(id) => write!(f, "agent not found: {id:?}"),
            Self::AgentNotActive(id) => write!(f, "agent not active: {id:?}"),
        }
    }
}

impl std::error::Error for DelegationError {}

/// Manages child agent lifecycle and scheduling.
pub struct AgentSupervisor {
    /// This supervisor's own agent ID.
    pub agent_id: AgentId,
    /// This supervisor's agent class.
    pub agent_class: AgentClass,
    /// The budget for this supervisor.
    pub budget: DelegationBudget,
    /// Active and completed children.
    pub children: Vec<ChildAgent>,
    /// Current delegation depth from root.
    pub depth: usize,
}

impl AgentSupervisor {
    /// Create a new supervisor for a primary agent.
    pub fn new(agent_id: AgentId, agent_class: AgentClass, budget: DelegationBudget) -> Self {
        Self {
            agent_id,
            agent_class,
            budget,
            children: Vec::new(),
            depth: 0,
        }
    }

    /// Create a supervisor for a child agent at a given depth.
    pub fn with_depth(
        agent_id: AgentId,
        agent_class: AgentClass,
        budget: DelegationBudget,
        depth: usize,
    ) -> Self {
        Self {
            agent_id,
            agent_class,
            budget,
            children: Vec::new(),
            depth,
        }
    }

    /// Spawn a child agent. Validates class can delegate, depth, and budget.
    pub fn spawn(
        &mut self,
        class: AgentClass,
        context: FocusedContext,
        child_budget: DelegationBudget,
        work_item: Option<WorkItemId>,
    ) -> Result<AgentId, DelegationError> {
        // Check: can this agent class delegate?
        if !self.agent_class.can_delegate() {
            return Err(DelegationError::CannotDelegate(self.agent_class));
        }

        // Check: depth limit (HARD CAP: 2)
        let child_depth = self.depth + 1;
        if child_depth > self.budget.max_depth as usize {
            return Err(DelegationError::MaxDepthExceeded {
                current: child_depth,
                max: self.budget.max_depth,
            });
        }

        // Check: max children
        let active_count = self.children.iter().filter(|c| c.is_active()).count();
        if active_count >= self.budget.max_children as usize {
            return Err(DelegationError::MaxChildrenExceeded {
                current: active_count,
                max: self.budget.max_children,
            });
        }

        // Check: budget can cover child
        let remaining = self.remaining_budget();
        if !remaining.can_cover(&child_budget) {
            return Err(DelegationError::InsufficientBudget(
                "child budget exceeds remaining parent budget".to_string(),
            ));
        }

        // Enforce CognitionWorker external writes constraint
        let effective_budget = if class == AgentClass::CognitionWorker {
            DelegationBudget {
                max_external_writes: 0,
                max_children: 0,
                max_depth: 0,
                ..child_budget
            }
        } else if class == AgentClass::Verification {
            DelegationBudget {
                max_external_writes: 0,
                max_children: 0,
                max_depth: 0,
                ..child_budget
            }
        } else {
            child_budget.cap_at(&remaining)
        };

        let _ = context; // Context is stored in the child's session, not here
        let session_id = pi_types::SessionId::new();
        let child = ChildAgent::new(class, session_id, self.agent_id, effective_budget, work_item);
        let child_id = child.id;
        self.children.push(child);

        Ok(child_id)
    }

    /// Cancel a child agent.
    pub fn cancel(&mut self, id: AgentId) -> Result<(), DelegationError> {
        let child = self
            .children
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or(DelegationError::AgentNotFound(id))?;

        if !child.is_active() {
            return Err(DelegationError::AgentNotActive(id));
        }

        child.status = ChildAgentStatus::Cancelled;
        Ok(())
    }

    /// Complete a child agent with a result.
    pub fn complete_child(
        &mut self,
        id: AgentId,
        result: AgentResult,
    ) -> Result<(), DelegationError> {
        let child = self
            .children
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or(DelegationError::AgentNotFound(id))?;

        if !child.is_active() {
            return Err(DelegationError::AgentNotActive(id));
        }

        child.status = ChildAgentStatus::Completed(result);
        Ok(())
    }

    /// Fail a child agent with an error.
    pub fn fail_child(
        &mut self,
        id: AgentId,
        error: AgentError,
    ) -> Result<(), DelegationError> {
        let child = self
            .children
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or(DelegationError::AgentNotFound(id))?;

        if !child.is_active() {
            return Err(DelegationError::AgentNotActive(id));
        }

        child.status = ChildAgentStatus::Failed(error);
        Ok(())
    }

    /// Mark a child as budget exceeded.
    pub fn exceed_budget(
        &mut self,
        id: AgentId,
        violation: BudgetViolation,
    ) -> Result<(), DelegationError> {
        let child = self
            .children
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or(DelegationError::AgentNotFound(id))?;

        child.status = ChildAgentStatus::BudgetExceeded(violation);
        Ok(())
    }

    /// Get the status of a child agent.
    pub fn get_status(&self, id: AgentId) -> Option<&ChildAgentStatus> {
        self.children.iter().find(|c| c.id == id).map(|c| &c.status)
    }

    /// Schedule the next child for inference. Returns the highest-priority active child
    /// that is waiting for inference.
    pub fn schedule_next(&self) -> Option<AgentId> {
        self.children
            .iter()
            .filter(|c| matches!(c.status, ChildAgentStatus::WaitingForInference))
            .min_by_key(|c| c.class.inference_priority())
            .map(|c| c.id)
    }

    /// Count active (non-terminal) children.
    pub fn active_count(&self) -> usize {
        self.children.iter().filter(|c| c.is_active()).count()
    }

    /// Calculate remaining budget after all children's allocations.
    fn remaining_budget(&self) -> DelegationBudget {
        let active_children = self.children.iter().filter(|c| c.is_active());
        let mut remaining = self.budget.clone();

        for child in active_children {
            remaining.max_input_tokens = remaining
                .max_input_tokens
                .saturating_sub(child.budget.max_input_tokens);
            remaining.max_output_tokens = remaining
                .max_output_tokens
                .saturating_sub(child.budget.max_output_tokens);
            remaining.max_external_writes = remaining
                .max_external_writes
                .saturating_sub(child.budget.max_external_writes);
        }

        remaining
    }
}
