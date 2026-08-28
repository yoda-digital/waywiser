//! Focused context: subset of full context given to child agents.

use pi_types::CapabilityName;
use serde::{Deserialize, Serialize};

/// Focused context provided to a child agent.
/// Does NOT include full user conversation history — only what's relevant to the task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FocusedContext {
    /// Description of the task for this child agent.
    pub task_description: String,
    /// Relevant memories selected for this task.
    pub relevant_memories: Vec<MemoryRef>,
    /// Relevant procedures selected for this task.
    pub relevant_procedures: Vec<ProcedureRef>,
    /// Capabilities available to this child (after filtering by AgentClass).
    pub available_capabilities: Vec<CapabilityName>,
}

/// Lightweight reference to a memory record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRef {
    pub id: String,
    pub content_preview: String,
    pub confidence: f32,
}

/// Lightweight reference to a procedure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcedureRef {
    pub id: String,
    pub pattern: String,
    pub maturity: String,
}

impl FocusedContext {
    /// Create a minimal context for a task.
    pub fn new(task_description: String) -> Self {
        Self {
            task_description,
            relevant_memories: Vec::new(),
            relevant_procedures: Vec::new(),
            available_capabilities: Vec::new(),
        }
    }

    /// Estimated token count for this context.
    pub fn estimated_tokens(&self) -> u64 {
        let desc_tokens = self.task_description.len() as u64 / 4;
        let mem_tokens: u64 = self
            .relevant_memories
            .iter()
            .map(|m| m.content_preview.len() as u64 / 4)
            .sum();
        let proc_tokens: u64 = self
            .relevant_procedures
            .iter()
            .map(|p| p.pattern.len() as u64 / 4)
            .sum();
        desc_tokens + mem_tokens + proc_tokens + 50 // overhead
    }
}
