//! Agent loop — the core prepare → execute → finalize cycle.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use pi_types::{
    AgentMessage, SessionState, SteerRequest, TokenUsage, ToolCall, WaywiserError,
};

use crate::tool::ToolDefinition;

/// Prepared context ready to send to the inference backend.
#[derive(Debug, Clone)]
pub struct PreparedContext {
    /// Messages to send to the model.
    pub messages: Vec<AgentMessage>,
    /// Tools available in this turn.
    pub tools: Vec<ToolDefinition>,
    /// Estimated token count of the context.
    pub estimated_tokens: u32,
}

/// Result of executing inference.
#[derive(Debug, Clone)]
pub struct ExecutionResult {
    /// The assistant's response message.
    pub message: AgentMessage,
    /// Tool calls requested by the model.
    pub tool_calls: Vec<ToolCall>,
    /// Token usage for this turn.
    pub usage: TokenUsage,
    /// The model identifier that produced this result.
    pub model_id: String,
}

/// Outcome of finalizing a turn — determines what happens next.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FinalizeOutcome {
    /// Turn complete, no pending work.
    Done,
    /// Model requested tool calls; loop must execute them and re-enter.
    ToolCallsPending(Vec<ToolCall>),
    /// Model requested a follow-up turn.
    FollowUp,
    /// Steering request arrived mid-turn; re-prepare.
    Steered(SteerRequest),
    /// Abort requested.
    Aborted,
}

/// Core agent cycle: prepare context → send to model → process response.
///
/// The trait is implemented by the Waywiser kernel to provide domain-specific
/// context preparation (identity injection, memory recall, skill guidance)
/// while the loop mechanics remain portable.
#[async_trait]
pub trait AgentLoop: Send + Sync {
    /// Build the context window for the next model call.
    ///
    /// Assembles: identity, session history, relevant memories, skill guidance,
    /// context graph projection, and tool definitions.
    async fn prepare(
        &self,
        session: &SessionState,
    ) -> Result<PreparedContext, WaywiserError>;

    /// Send prepared context to the inference backend, streaming tokens back.
    ///
    /// The cancellation token allows mid-stream abort.
    async fn execute(
        &self,
        ctx: PreparedContext,
        cancel: CancellationToken,
    ) -> Result<ExecutionResult, WaywiserError>;

    /// Apply the model's response: persist records, enqueue follow-ups, run tools.
    ///
    /// Returns the outcome that determines the next action in the loop.
    async fn finalize(
        &self,
        result: ExecutionResult,
        session: &mut SessionState,
    ) -> Result<FinalizeOutcome, WaywiserError>;
}
