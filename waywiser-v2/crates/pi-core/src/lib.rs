//! Pi Core — the portable agent runtime.
//!
//! Agent loop, session state machine (reducer), compaction engine,
//! operation records, and tool execution types.
//! No Android or Waywiser domain dependencies.

pub mod agent_loop;
pub mod compaction;
pub mod records;
pub mod reducer;
pub mod tool;

pub use agent_loop::{AgentLoop, ExecutionResult, FinalizeOutcome, PreparedContext};
pub use compaction::{CompactionBudget, CompactionEngine, CompactionPlan};
pub use records::OperationRecord;
pub use reducer::{CorruptionKind, ReducerAction, ReducerState, SessionReducer};
pub use tool::{ToolDefinition, ToolExecutionMode};
