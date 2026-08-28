//! Kanban projection — a read-only view of work items mapped to columns.
//!
//! Kanban is a PROJECTION of the work graph, not the source of truth.

use pi_types::WorkItemId;
use serde::{Deserialize, Serialize};

use crate::work_item::WorkItem;

/// A kanban column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KanbanColumn {
    pub name: String,
    pub items: Vec<WorkItemId>,
    pub wip_limit: Option<usize>,
}

impl KanbanColumn {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            items: Vec::new(),
            wip_limit: None,
        }
    }

    fn with_wip_limit(mut self, limit: usize) -> Self {
        self.wip_limit = Some(limit);
        self
    }
}

/// A kanban board projection over work items.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KanbanProjection {
    pub columns: Vec<KanbanColumn>,
}

/// The standard column names.
const COLUMN_NAMES: &[&str] = &["Backlog", "Ready", "In Progress", "Review", "Done", "Blocked"];

impl KanbanProjection {
    /// Build a kanban projection from a slice of work items.
    ///
    /// Maps `WorkStatus` variants to column names:
    /// - `Proposed` → Backlog
    /// - `Ready` → Ready
    /// - `Running` → In Progress
    /// - `Review` → Review
    /// - `Done` → Done
    /// - `Blocked(_)` → Blocked
    pub fn from_work_items(items: &[WorkItem]) -> Self {
        let mut columns: Vec<KanbanColumn> = COLUMN_NAMES
            .iter()
            .map(|name| {
                let mut col = KanbanColumn::new(name);
                // Default WIP limit for In Progress
                if *name == "In Progress" {
                    col = col.with_wip_limit(5);
                }
                col
            })
            .collect();

        for item in items {
            let col_name = item.status.column_name();
            if let Some(col) = columns.iter_mut().find(|c| c.name == col_name) {
                col.items.push(item.id);
            }
        }

        Self { columns }
    }

    /// Get a specific column by name.
    pub fn column(&self, name: &str) -> Option<&KanbanColumn> {
        self.columns.iter().find(|c| c.name == name)
    }

    /// Total number of items across all columns.
    pub fn total_items(&self) -> usize {
        self.columns.iter().map(|c| c.items.len()).sum()
    }
}
