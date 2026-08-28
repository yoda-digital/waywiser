//! WorkGraphService — the primary API for managing goals and work items.

use chrono::Utc;
use pi_types::{GoalId, WorkItemId};
use std::collections::HashMap;
use std::fmt;
use uuid::Uuid;

use crate::goal::{Goal, GoalStatus, Priority};
use crate::graph::{CycleError, DependencyGraph};
use crate::kanban::KanbanProjection;
use crate::work_item::{
    AgentAssignment, ApprovalState, NewWorkItem, WorkItem, WorkStatus,
};

/// Errors from work graph operations.
#[derive(Debug)]
pub enum WorkError {
    ItemNotFound(WorkItemId),
    GoalNotFound(GoalId),
    InvalidTransition {
        from: String,
        to: String,
    },
    CyclicDependency(CycleError),
    DependencyNotFound(WorkItemId),
}

impl fmt::Display for WorkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ItemNotFound(id) => write!(f, "work item not found: {}", id.0),
            Self::GoalNotFound(id) => write!(f, "goal not found: {}", id.0),
            Self::InvalidTransition { from, to } => {
                write!(f, "invalid transition from {} to {}", from, to)
            }
            Self::CyclicDependency(e) => write!(f, "cyclic dependency: {}", e),
            Self::DependencyNotFound(id) => write!(f, "dependency not found: {}", id.0),
        }
    }
}

impl std::error::Error for WorkError {}

/// The work graph service: manages goals, work items, and their dependency graph.
pub struct WorkGraphService {
    goals: HashMap<GoalId, Goal>,
    items: HashMap<WorkItemId, WorkItem>,
    graph: DependencyGraph,
}

impl WorkGraphService {
    pub fn new() -> Self {
        Self {
            goals: HashMap::new(),
            items: HashMap::new(),
            graph: DependencyGraph::new(),
        }
    }

    /// Create a new goal.
    pub fn create_goal(
        &mut self,
        title: String,
        description: String,
        priority: Priority,
    ) -> GoalId {
        let goal = Goal::new(title, description, priority);
        let id = goal.id;
        self.goals.insert(id, goal);
        id
    }

    /// Get a goal by ID.
    pub fn get_goal(&self, id: &GoalId) -> Option<&Goal> {
        self.goals.get(id)
    }

    /// Update a goal's status.
    pub fn update_goal_status(
        &mut self,
        id: GoalId,
        status: GoalStatus,
    ) -> Result<(), WorkError> {
        let goal = self.goals.get_mut(&id).ok_or(WorkError::GoalNotFound(id))?;
        goal.status = status;
        goal.updated_at = Utc::now();
        Ok(())
    }

    /// Create a new work item.
    pub fn create_work_item(&mut self, input: NewWorkItem) -> Result<WorkItemId, WorkError> {
        // Validate goal exists if specified
        if let Some(goal_id) = input.goal_id {
            if !self.goals.contains_key(&goal_id) {
                return Err(WorkError::GoalNotFound(goal_id));
            }
        }

        // Validate all dependencies exist
        for dep in &input.dependencies {
            if !self.items.contains_key(dep) {
                return Err(WorkError::DependencyNotFound(*dep));
            }
        }

        let now = Utc::now();
        let id = WorkItemId(Uuid::now_v7());

        let item = WorkItem {
            id,
            goal_id: input.goal_id,
            title: input.title,
            description: input.description,
            status: WorkStatus::Proposed,
            priority: input.priority,
            dependencies: input.dependencies.clone(),
            assignee: None,
            agent_session_id: None,
            attempts: 0,
            due_at: None,
            evidence: Vec::new(),
            result: None,
            approval_state: ApprovalState::NotRequired,
            created_at: now,
            updated_at: now,
        };

        // Add to dependency graph
        self.graph.add_item(id, input.dependencies);

        // Check for cycles
        if let Some(cycle) = self.graph.detect_cycle() {
            // Roll back
            self.graph.remove_item(&id);
            return Err(WorkError::CyclicDependency(CycleError { cycle }));
        }

        self.items.insert(id, item);
        Ok(id)
    }

    /// Get a work item by ID.
    pub fn get_item(&self, id: &WorkItemId) -> Option<&WorkItem> {
        self.items.get(id)
    }

    /// Transition a work item to a new status.
    pub fn transition(
        &mut self,
        id: WorkItemId,
        to: WorkStatus,
    ) -> Result<(), WorkError> {
        let item = self
            .items
            .get_mut(&id)
            .ok_or(WorkError::ItemNotFound(id))?;

        if !item.can_transition_to(&to) {
            return Err(WorkError::InvalidTransition {
                from: format!("{:?}", item.status),
                to: format!("{:?}", to),
            });
        }

        item.status = to;
        item.updated_at = Utc::now();
        Ok(())
    }

    /// Assign a work item to an agent.
    pub fn assign(
        &mut self,
        id: WorkItemId,
        assignee: AgentAssignment,
    ) -> Result<(), WorkError> {
        let item = self
            .items
            .get_mut(&id)
            .ok_or(WorkError::ItemNotFound(id))?;
        item.assignee = Some(assignee);
        item.updated_at = Utc::now();
        Ok(())
    }

    /// Get all ready items — status is Ready and all dependencies are met.
    pub fn ready_items(&self) -> Vec<&WorkItem> {
        let completed: std::collections::HashSet<WorkItemId> = self
            .items
            .values()
            .filter(|i| matches!(i.status, WorkStatus::Done))
            .map(|i| i.id)
            .collect();

        self.items
            .values()
            .filter(|item| {
                matches!(item.status, WorkStatus::Ready)
                    && self.graph.dependencies_met(&item.id, &completed)
            })
            .collect()
    }

    /// Build a kanban projection of all work items.
    pub fn kanban(&self) -> KanbanProjection {
        let items: Vec<WorkItem> = self.items.values().cloned().collect();
        KanbanProjection::from_work_items(&items)
    }

    /// Get the dependency graph.
    pub fn dependency_graph(&self) -> &DependencyGraph {
        &self.graph
    }

    /// Total number of work items.
    pub fn item_count(&self) -> usize {
        self.items.len()
    }

    /// Total number of goals.
    pub fn goal_count(&self) -> usize {
        self.goals.len()
    }
}

impl Default for WorkGraphService {
    fn default() -> Self {
        Self::new()
    }
}
