//! Session reducer — the recovery-aware state machine (§7.1).
//!
//! The reducer is the hardest porting target from Pi's `reducer.ts` (744 LOC).
//! It manages state transitions with corruption detection, TOCTOU guards,
//! and escalating recovery attempts.
//!
//! State transition table:
//!
//! | From            | Action                           | To               | Side Effects                    |
//! |-----------------|----------------------------------|------------------|---------------------------------|
//! | Idle            | StartPrepare                     | Preparing        | Begin context assembly          |
//! | Idle            | Steer(req)                       | Idle             | Enqueue in lane queue           |
//! | Preparing       | PrepareComplete(ctx)             | Executing        | Send to inference backend       |
//! | Preparing       | Steer(req)                       | Preparing        | Replace pending_steer, restart  |
//! | Preparing       | Abort                            | Aborted          | Cancel preparation              |
//! | Executing       | StreamChunk(evt)                 | Executing        | Forward to UI via FFI           |
//! | Executing       | ExecuteComplete(res)             | Finalizing       | Begin finalization              |
//! | Executing       | Steer(req)                       | Executing        | Enqueue; applied after turn     |
//! | Executing       | Abort                            | Aborted          | Cancel inference                |
//! | Finalizing      | FinalizeComplete(Done)           | Idle             | Persist records; drain queue    |
//! | Finalizing      | FinalizeComplete(ToolCalls)      | Idle             | Execute tools, enqueue result   |
//! | Finalizing      | FinalizeComplete(FollowUp)       | Preparing        | Re-enter loop                   |
//! | Finalizing      | FinalizeComplete(Steered)        | Preparing        | Apply steer, re-enter loop      |
//! | Any             | CorruptionDetected(kind)         | Recovering(0)    | Log corruption                  |
//! | Recovering(n)   | RecoverySucceeded                | Idle             | Resume normal operation         |
//! | Recovering(n<3) | RecoveryFailed                   | Recovering(n+1)  | Retry with broader repair       |
//! | Recovering(3)   | RecoveryFailed                   | Aborted          | Emit SessionCorrupted error     |

use serde::{Deserialize, Serialize};
use tracing::{info, warn, error};

use pi_types::{
    EntryId, FollowUpRequest, SessionId, SessionState, SteerRequest, ToolCall,
    WaywiserError,
};

use crate::agent_loop::{ExecutionResult, FinalizeOutcome, PreparedContext};

/// Maximum number of recovery attempts before aborting.
const MAX_RECOVERY_ATTEMPTS: u32 = 3;

/// State of the session reducer FSM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReducerState {
    /// Waiting for input — no active turn.
    Idle,
    /// Assembling context for the next model call.
    Preparing,
    /// Model inference is in progress (streaming).
    Executing,
    /// Processing the model's response (persisting, running tools).
    Finalizing,
    /// Attempting to recover from corruption.
    Recovering { attempt: u32 },
    /// Terminal state — session is unusable until reset.
    Aborted,
}

impl std::fmt::Display for ReducerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "Idle"),
            Self::Preparing => write!(f, "Preparing"),
            Self::Executing => write!(f, "Executing"),
            Self::Finalizing => write!(f, "Finalizing"),
            Self::Recovering { attempt } => write!(f, "Recovering({})", attempt),
            Self::Aborted => write!(f, "Aborted"),
        }
    }
}

/// Kind of corruption detected in session state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CorruptionKind {
    /// Record log has entries that don't match session state.
    RecordLogMismatch,
    /// Lane references an entry that doesn't exist.
    DanglingEntry(EntryId),
    /// Unexpected state after process recovery.
    StaleState {
        expected: String,
        found: String,
    },
}

impl std::fmt::Display for CorruptionKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RecordLogMismatch => write!(f, "RecordLogMismatch"),
            Self::DanglingEntry(id) => write!(f, "DanglingEntry({})", id.0),
            Self::StaleState { expected, found } => {
                write!(f, "StaleState(expected={}, found={})", expected, found)
            }
        }
    }
}

/// A stream event from the inference backend (opaque at this level).
#[derive(Debug, Clone)]
pub struct StreamChunkEvent {
    /// Raw chunk data — the agent loop interprets this.
    pub data: String,
}

/// Actions that can be applied to the reducer.
#[derive(Debug, Clone)]
pub enum ReducerAction {
    /// Begin preparing context for a model call.
    StartPrepare,
    /// Context preparation is complete.
    PrepareComplete(PreparedContext),
    /// Begin executing inference.
    StartExecute,
    /// A streaming chunk arrived from the model.
    StreamChunk(StreamChunkEvent),
    /// Inference execution is complete.
    ExecuteComplete(ExecutionResult),
    /// Begin finalization of the model response.
    StartFinalize,
    /// Finalization is complete with an outcome.
    FinalizeComplete(FinalizeOutcome),
    /// User is steering the conversation.
    Steer(SteerRequest),
    /// A follow-up was requested.
    FollowUp(FollowUpRequest),
    /// Abort the current turn.
    Abort,
    /// A tool call completed with a result.
    ToolResult {
        call_id: String,
        success: bool,
    },
    /// Corruption was detected in session state.
    CorruptionDetected(CorruptionKind),
    /// Attempt recovery from corruption.
    RecoveryAttempt,
    /// Recovery succeeded.
    RecoverySucceeded,
    /// Recovery failed.
    RecoveryFailed(String),
}

/// Side effects produced by a state transition.
#[derive(Debug, Clone)]
pub enum ReducerEffect {
    /// No side effect.
    None,
    /// Context is ready to send to inference.
    ContextReady(PreparedContext),
    /// Stream chunk should be forwarded to UI.
    ForwardStreamChunk(StreamChunkEvent),
    /// Execution result is ready for finalization.
    ResultReady(ExecutionResult),
    /// Queue was drained and a new action is ready.
    DrainedSteer(SteerRequest),
    /// Queue was drained and a follow-up is ready.
    DrainedFollowUp(FollowUpRequest),
    /// Tool calls need to be executed.
    ExecuteTools(Vec<ToolCall>),
    /// Recovery should be attempted.
    AttemptRecovery { attempt: u32, kind: CorruptionKind },
    /// Session is corrupted beyond recovery.
    SessionCorrupted { session_id: SessionId, reason: String },
}

/// The session reducer — drives the agent loop state machine.
pub struct SessionReducer {
    /// Current FSM state.
    state: ReducerState,
    /// Session ID for error reporting.
    session_id: SessionId,
    /// The corruption kind being recovered from, if any.
    recovering_from: Option<CorruptionKind>,
}

impl SessionReducer {
    /// Create a new reducer in the Idle state.
    pub fn new(session_id: SessionId) -> Self {
        Self {
            state: ReducerState::Idle,
            session_id,
            recovering_from: None,
        }
    }

    /// Get the current state.
    pub fn state(&self) -> &ReducerState {
        &self.state
    }

    /// Apply an action to the state machine.
    ///
    /// Returns the new state and any side effects that should be executed.
    /// Invalid transitions return an error — the state does not change.
    pub fn apply(
        &mut self,
        action: ReducerAction,
        session: &mut SessionState,
    ) -> Result<(ReducerState, ReducerEffect), WaywiserError> {
        // CorruptionDetected is valid from ANY state
        if let ReducerAction::CorruptionDetected(kind) = action {
            warn!(
                state = %self.state,
                corruption = %kind,
                "Corruption detected, entering recovery"
            );
            self.recovering_from = Some(kind.clone());
            self.state = ReducerState::Recovering { attempt: 0 };
            return Ok((
                self.state.clone(),
                ReducerEffect::AttemptRecovery { attempt: 0, kind },
            ));
        }

        let (new_state, effect) = match (&self.state, action) {
            // ── Idle transitions ──
            (ReducerState::Idle, ReducerAction::StartPrepare) => {
                info!("Idle → Preparing");
                (ReducerState::Preparing, ReducerEffect::None)
            }
            (ReducerState::Idle, ReducerAction::Steer(req)) => {
                info!("Idle: enqueuing steer request");
                if let Some(lane) = session.active_lane_mut() {
                    lane.queue.pending_steer = Some(req);
                }
                (ReducerState::Idle, ReducerEffect::None)
            }

            // ── Preparing transitions ──
            (ReducerState::Preparing, ReducerAction::PrepareComplete(ctx)) => {
                info!("Preparing → Executing");
                (ReducerState::Executing, ReducerEffect::ContextReady(ctx))
            }
            (ReducerState::Preparing, ReducerAction::Steer(req)) => {
                info!("Preparing: replacing steer, restarting prepare");
                if let Some(lane) = session.active_lane_mut() {
                    lane.queue.pending_steer = Some(req);
                }
                (ReducerState::Preparing, ReducerEffect::None)
            }
            (ReducerState::Preparing, ReducerAction::Abort) => {
                info!("Preparing → Aborted");
                (ReducerState::Aborted, ReducerEffect::None)
            }

            // ── Executing transitions ──
            (ReducerState::Executing, ReducerAction::StreamChunk(evt)) => {
                (ReducerState::Executing, ReducerEffect::ForwardStreamChunk(evt))
            }
            (ReducerState::Executing, ReducerAction::ExecuteComplete(result)) => {
                info!("Executing → Finalizing");
                (ReducerState::Finalizing, ReducerEffect::ResultReady(result))
            }
            (ReducerState::Executing, ReducerAction::Steer(req)) => {
                info!("Executing: enqueuing steer for after turn");
                if let Some(lane) = session.active_lane_mut() {
                    lane.queue.pending_steer = Some(req);
                }
                (ReducerState::Executing, ReducerEffect::None)
            }
            (ReducerState::Executing, ReducerAction::Abort) => {
                info!("Executing → Aborted");
                (ReducerState::Aborted, ReducerEffect::None)
            }

            // ── Finalizing transitions ──
            (ReducerState::Finalizing, ReducerAction::FinalizeComplete(outcome)) => {
                match outcome {
                    FinalizeOutcome::Done => {
                        info!("Finalizing → Idle (done)");
                        // Drain the queue: steer > follow-up > next_run
                        let effect = self.drain_queue(session);
                        (ReducerState::Idle, effect)
                    }
                    FinalizeOutcome::ToolCallsPending(calls) => {
                        info!("Finalizing → Idle (tool calls pending)");
                        (ReducerState::Idle, ReducerEffect::ExecuteTools(calls))
                    }
                    FinalizeOutcome::FollowUp => {
                        info!("Finalizing → Preparing (follow-up)");
                        (ReducerState::Preparing, ReducerEffect::None)
                    }
                    FinalizeOutcome::Steered(req) => {
                        info!("Finalizing → Preparing (steered)");
                        (ReducerState::Preparing, ReducerEffect::DrainedSteer(req))
                    }
                    FinalizeOutcome::Aborted => {
                        info!("Finalizing → Aborted");
                        (ReducerState::Aborted, ReducerEffect::None)
                    }
                }
            }

            // ── Recovery transitions ──
            (ReducerState::Recovering { .. }, ReducerAction::RecoverySucceeded) => {
                info!("Recovery succeeded → Idle");
                self.recovering_from = None;
                (ReducerState::Idle, ReducerEffect::None)
            }
            (ReducerState::Recovering { attempt }, ReducerAction::RecoveryFailed(reason)) => {
                let attempt = *attempt;
                if attempt >= MAX_RECOVERY_ATTEMPTS {
                    error!(
                        attempt,
                        reason = %reason,
                        "Recovery failed after max attempts → Aborted"
                    );
                    let corruption_reason = self
                        .recovering_from
                        .as_ref()
                        .map(|k| format!("recovery failed after {} attempts: {} ({})", attempt + 1, k, reason))
                        .unwrap_or_else(|| format!("recovery failed: {}", reason));
                    self.recovering_from = None;
                    (
                        ReducerState::Aborted,
                        ReducerEffect::SessionCorrupted {
                            session_id: self.session_id,
                            reason: corruption_reason,
                        },
                    )
                } else {
                    warn!(attempt, reason = %reason, "Recovery failed, escalating");
                    let kind = self.recovering_from.clone().unwrap_or(CorruptionKind::RecordLogMismatch);
                    (
                        ReducerState::Recovering { attempt: attempt + 1 },
                        ReducerEffect::AttemptRecovery {
                            attempt: attempt + 1,
                            kind,
                        },
                    )
                }
            }

            // ── Invalid transitions ──
            (state, action) => {
                let action_name = match &action {
                    ReducerAction::StartPrepare => "StartPrepare",
                    ReducerAction::PrepareComplete(_) => "PrepareComplete",
                    ReducerAction::StartExecute => "StartExecute",
                    ReducerAction::StreamChunk(_) => "StreamChunk",
                    ReducerAction::ExecuteComplete(_) => "ExecuteComplete",
                    ReducerAction::StartFinalize => "StartFinalize",
                    ReducerAction::FinalizeComplete(_) => "FinalizeComplete",
                    ReducerAction::Steer(_) => "Steer",
                    ReducerAction::FollowUp(_) => "FollowUp",
                    ReducerAction::Abort => "Abort",
                    ReducerAction::ToolResult { .. } => "ToolResult",
                    ReducerAction::CorruptionDetected(_) => "CorruptionDetected",
                    ReducerAction::RecoveryAttempt => "RecoveryAttempt",
                    ReducerAction::RecoverySucceeded => "RecoverySucceeded",
                    ReducerAction::RecoveryFailed(_) => "RecoveryFailed",
                };
                return Err(WaywiserError::Other(format!(
                    "invalid reducer transition: {} + {} for session {}",
                    state, action_name, self.session_id
                )));
            }
        };

        self.state = new_state.clone();
        Ok((new_state, effect))
    }

    /// Drain the lane queue after a turn completes.
    /// Priority: pending_steer > pending_follow_up > next_run > deferred.
    fn drain_queue(&self, session: &mut SessionState) -> ReducerEffect {
        if let Some(lane) = session.active_lane_mut() {
            if let Some(steer) = lane.queue.pending_steer.take() {
                return ReducerEffect::DrainedSteer(steer);
            }
            if let Some(follow_up) = lane.queue.pending_follow_up.take() {
                return ReducerEffect::DrainedFollowUp(follow_up);
            }
            // next_run and deferred are handled at a higher level
        }
        ReducerEffect::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pi_types::SessionState;

    fn make_reducer() -> (SessionReducer, SessionState) {
        let session = SessionState::new();
        let reducer = SessionReducer::new(session.id);
        (reducer, session)
    }

    #[test]
    fn test_idle_to_preparing() {
        let (mut reducer, mut session) = make_reducer();
        let (state, _) = reducer.apply(ReducerAction::StartPrepare, &mut session).unwrap();
        assert_eq!(state, ReducerState::Preparing);
    }

    #[test]
    fn test_invalid_transition_idle_execute_complete() {
        let (mut reducer, mut session) = make_reducer();
        let result = reducer.apply(
            ReducerAction::ExecuteComplete(ExecutionResult {
                message: pi_types::AgentMessage::System(pi_types::SystemMessage {
                    id: pi_types::EntryId::new(),
                    content: "test".to_string(),
                    timestamp: chrono::Utc::now(),
                }),
                tool_calls: vec![],
                usage: pi_types::TokenUsage::default(),
                model_id: "test".to_string(),
            }),
            &mut session,
        );
        assert!(result.is_err());
    }
}
