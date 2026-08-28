//! Tool execution types.

use serde::{Deserialize, Serialize};

/// How tool calls in a turn should be executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolExecutionMode {
    /// Execute tool calls one at a time, in order.
    Sequential,
    /// Execute tool calls concurrently.
    Parallel,
}

/// Definition of a tool available to the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// Tool name (unique within a session).
    pub name: String,
    /// Human-readable description shown to the model.
    pub description: String,
    /// JSON Schema for the tool's parameters.
    pub parameters: serde_json::Value,
}
