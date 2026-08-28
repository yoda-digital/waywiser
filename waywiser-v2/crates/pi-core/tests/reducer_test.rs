//! Comprehensive tests for the SessionReducer state machine.
//!
//! Tests every valid transition from the spec's state transition table,
//! verifies invalid transitions are rejected, and tests recovery escalation.

use chrono::Utc;
use pi_core::reducer::*;
use pi_core::agent_loop::*;
use pi_types::*;

fn make_reducer() -> (SessionReducer, SessionState) {
    let session = SessionState::new();
    let reducer = SessionReducer::new(session.id);
    (reducer, session)
}

fn make_steer() -> SteerRequest {
    SteerRequest {
        content: "new direction".to_string(),
        requested_at: Utc::now(),
    }
}

fn make_follow_up() -> FollowUpRequest {
    FollowUpRequest {
        reason: "needs more info".to_string(),
        requested_at: Utc::now(),
    }
}

fn make_prepared_context() -> PreparedContext {
    PreparedContext {
        messages: vec![],
        tools: vec![],
        estimated_tokens: 100,
    }
}

fn make_execution_result() -> ExecutionResult {
    ExecutionResult {
        message: AgentMessage::System(SystemMessage {
            id: EntryId::new(),
            content: "response".to_string(),
            timestamp: Utc::now(),
        }),
        tool_calls: vec![],
        usage: TokenUsage::default(),
        model_id: "qwen3.8-27b".to_string(),
    }
}

// ══════════════════════════════════════════════════════════════
// Valid transitions from Idle
// ══════════════════════════════════════════════════════════════

#[test]
fn idle_start_prepare_to_preparing() {
    let (mut r, mut s) = make_reducer();
    assert_eq!(*r.state(), ReducerState::Idle);
    let (state, _) = r.apply(ReducerAction::StartPrepare, &mut s).unwrap();
    assert_eq!(state, ReducerState::Preparing);
}

#[test]
fn idle_steer_stays_idle_enqueues() {
    let (mut r, mut s) = make_reducer();
    let (state, _) = r.apply(ReducerAction::Steer(make_steer()), &mut s).unwrap();
    assert_eq!(state, ReducerState::Idle);
    assert!(s.active_lane().unwrap().queue.pending_steer.is_some());
}

// ══════════════════════════════════════════════════════════════
// Valid transitions from Preparing
// ══════════════════════════════════════════════════════════════

#[test]
fn preparing_complete_to_executing() {
    let (mut r, mut s) = make_reducer();
    r.apply(ReducerAction::StartPrepare, &mut s).unwrap();
    let (state, effect) = r
        .apply(ReducerAction::PrepareComplete(make_prepared_context()), &mut s)
        .unwrap();
    assert_eq!(state, ReducerState::Executing);
    assert!(matches!(effect, ReducerEffect::ContextReady(_)));
}

#[test]
fn preparing_steer_stays_preparing() {
    let (mut r, mut s) = make_reducer();
    r.apply(ReducerAction::StartPrepare, &mut s).unwrap();
    let (state, _) = r.apply(ReducerAction::Steer(make_steer()), &mut s).unwrap();
    assert_eq!(state, ReducerState::Preparing);
    assert!(s.active_lane().unwrap().queue.pending_steer.is_some());
}

#[test]
fn preparing_abort_to_aborted() {
    let (mut r, mut s) = make_reducer();
    r.apply(ReducerAction::StartPrepare, &mut s).unwrap();
    let (state, _) = r.apply(ReducerAction::Abort, &mut s).unwrap();
    assert_eq!(state, ReducerState::Aborted);
}

// ══════════════════════════════════════════════════════════════
// Valid transitions from Executing
// ══════════════════════════════════════════════════════════════

fn go_to_executing(r: &mut SessionReducer, s: &mut SessionState) {
    r.apply(ReducerAction::StartPrepare, s).unwrap();
    r.apply(ReducerAction::PrepareComplete(make_prepared_context()), s)
        .unwrap();
    assert_eq!(*r.state(), ReducerState::Executing);
}

#[test]
fn executing_stream_chunk_stays_executing() {
    let (mut r, mut s) = make_reducer();
    go_to_executing(&mut r, &mut s);
    let (state, effect) = r
        .apply(
            ReducerAction::StreamChunk(StreamChunkEvent {
                data: "hello".to_string(),
            }),
            &mut s,
        )
        .unwrap();
    assert_eq!(state, ReducerState::Executing);
    assert!(matches!(effect, ReducerEffect::ForwardStreamChunk(_)));
}

#[test]
fn executing_complete_to_finalizing() {
    let (mut r, mut s) = make_reducer();
    go_to_executing(&mut r, &mut s);
    let (state, effect) = r
        .apply(
            ReducerAction::ExecuteComplete(make_execution_result()),
            &mut s,
        )
        .unwrap();
    assert_eq!(state, ReducerState::Finalizing);
    assert!(matches!(effect, ReducerEffect::ResultReady(_)));
}

#[test]
fn executing_steer_enqueues_stays_executing() {
    let (mut r, mut s) = make_reducer();
    go_to_executing(&mut r, &mut s);
    let (state, _) = r.apply(ReducerAction::Steer(make_steer()), &mut s).unwrap();
    assert_eq!(state, ReducerState::Executing);
    assert!(s.active_lane().unwrap().queue.pending_steer.is_some());
}

#[test]
fn executing_abort_to_aborted() {
    let (mut r, mut s) = make_reducer();
    go_to_executing(&mut r, &mut s);
    let (state, _) = r.apply(ReducerAction::Abort, &mut s).unwrap();
    assert_eq!(state, ReducerState::Aborted);
}

// ══════════════════════════════════════════════════════════════
// Valid transitions from Finalizing
// ══════════════════════════════════════════════════════════════

fn go_to_finalizing(r: &mut SessionReducer, s: &mut SessionState) {
    go_to_executing(r, s);
    r.apply(ReducerAction::ExecuteComplete(make_execution_result()), s)
        .unwrap();
    assert_eq!(*r.state(), ReducerState::Finalizing);
}

#[test]
fn finalizing_done_to_idle() {
    let (mut r, mut s) = make_reducer();
    go_to_finalizing(&mut r, &mut s);
    let (state, _) = r
        .apply(
            ReducerAction::FinalizeComplete(FinalizeOutcome::Done),
            &mut s,
        )
        .unwrap();
    assert_eq!(state, ReducerState::Idle);
}

#[test]
fn finalizing_done_drains_pending_steer() {
    let (mut r, mut s) = make_reducer();
    go_to_executing(&mut r, &mut s);
    // Enqueue a steer while executing
    r.apply(ReducerAction::Steer(make_steer()), &mut s).unwrap();
    // Complete execution and finalize
    r.apply(ReducerAction::ExecuteComplete(make_execution_result()), &mut s)
        .unwrap();
    let (state, effect) = r
        .apply(
            ReducerAction::FinalizeComplete(FinalizeOutcome::Done),
            &mut s,
        )
        .unwrap();
    assert_eq!(state, ReducerState::Idle);
    assert!(matches!(effect, ReducerEffect::DrainedSteer(_)));
    // Steer was consumed from queue
    assert!(s.active_lane().unwrap().queue.pending_steer.is_none());
}

#[test]
fn finalizing_tool_calls_to_idle_with_tools() {
    let (mut r, mut s) = make_reducer();
    go_to_finalizing(&mut r, &mut s);
    let tools = vec![ToolCall {
        id: "tc1".to_string(),
        name: "test_tool".to_string(),
        arguments: serde_json::json!({}),
    }];
    let (state, effect) = r
        .apply(
            ReducerAction::FinalizeComplete(FinalizeOutcome::ToolCallsPending(tools)),
            &mut s,
        )
        .unwrap();
    assert_eq!(state, ReducerState::Idle);
    assert!(matches!(effect, ReducerEffect::ExecuteTools(_)));
}

#[test]
fn finalizing_follow_up_to_preparing() {
    let (mut r, mut s) = make_reducer();
    go_to_finalizing(&mut r, &mut s);
    let (state, _) = r
        .apply(
            ReducerAction::FinalizeComplete(FinalizeOutcome::FollowUp),
            &mut s,
        )
        .unwrap();
    assert_eq!(state, ReducerState::Preparing);
}

#[test]
fn finalizing_steered_to_preparing() {
    let (mut r, mut s) = make_reducer();
    go_to_finalizing(&mut r, &mut s);
    let (state, effect) = r
        .apply(
            ReducerAction::FinalizeComplete(FinalizeOutcome::Steered(make_steer())),
            &mut s,
        )
        .unwrap();
    assert_eq!(state, ReducerState::Preparing);
    assert!(matches!(effect, ReducerEffect::DrainedSteer(_)));
}

// ══════════════════════════════════════════════════════════════
// Recovery transitions
// ══════════════════════════════════════════════════════════════

#[test]
fn corruption_from_any_state_to_recovering() {
    // Test from Idle
    let (mut r, mut s) = make_reducer();
    let (state, effect) = r
        .apply(
            ReducerAction::CorruptionDetected(CorruptionKind::RecordLogMismatch),
            &mut s,
        )
        .unwrap();
    assert_eq!(state, ReducerState::Recovering { attempt: 0 });
    assert!(matches!(effect, ReducerEffect::AttemptRecovery { attempt: 0, .. }));

    // Test from Executing
    let (mut r, mut s) = make_reducer();
    go_to_executing(&mut r, &mut s);
    let (state, _) = r
        .apply(
            ReducerAction::CorruptionDetected(CorruptionKind::RecordLogMismatch),
            &mut s,
        )
        .unwrap();
    assert_eq!(state, ReducerState::Recovering { attempt: 0 });
}

#[test]
fn recovery_succeeded_to_idle() {
    let (mut r, mut s) = make_reducer();
    r.apply(
        ReducerAction::CorruptionDetected(CorruptionKind::RecordLogMismatch),
        &mut s,
    )
    .unwrap();
    let (state, _) = r
        .apply(ReducerAction::RecoverySucceeded, &mut s)
        .unwrap();
    assert_eq!(state, ReducerState::Idle);
}

#[test]
fn recovery_escalation_three_failures_then_aborted() {
    let (mut r, mut s) = make_reducer();
    r.apply(
        ReducerAction::CorruptionDetected(CorruptionKind::RecordLogMismatch),
        &mut s,
    )
    .unwrap();
    assert_eq!(*r.state(), ReducerState::Recovering { attempt: 0 });

    // Failure 1 → attempt 1
    let (state, _) = r
        .apply(ReducerAction::RecoveryFailed("fail 1".to_string()), &mut s)
        .unwrap();
    assert_eq!(state, ReducerState::Recovering { attempt: 1 });

    // Failure 2 → attempt 2
    let (state, _) = r
        .apply(ReducerAction::RecoveryFailed("fail 2".to_string()), &mut s)
        .unwrap();
    assert_eq!(state, ReducerState::Recovering { attempt: 2 });

    // Failure 3 → attempt 3
    let (state, _) = r
        .apply(ReducerAction::RecoveryFailed("fail 3".to_string()), &mut s)
        .unwrap();
    assert_eq!(state, ReducerState::Recovering { attempt: 3 });

    // Failure 4 (attempt 3 is max) → Aborted with SessionCorrupted
    let (state, effect) = r
        .apply(ReducerAction::RecoveryFailed("fail 4".to_string()), &mut s)
        .unwrap();
    assert_eq!(state, ReducerState::Aborted);
    assert!(matches!(effect, ReducerEffect::SessionCorrupted { .. }));
}

// ══════════════════════════════════════════════════════════════
// Invalid transitions
// ══════════════════════════════════════════════════════════════

#[test]
fn idle_execute_complete_is_invalid() {
    let (mut r, mut s) = make_reducer();
    let result = r.apply(
        ReducerAction::ExecuteComplete(make_execution_result()),
        &mut s,
    );
    assert!(result.is_err());
}

#[test]
fn idle_finalize_complete_is_invalid() {
    let (mut r, mut s) = make_reducer();
    let result = r.apply(
        ReducerAction::FinalizeComplete(FinalizeOutcome::Done),
        &mut s,
    );
    assert!(result.is_err());
}

#[test]
fn preparing_execute_complete_is_invalid() {
    let (mut r, mut s) = make_reducer();
    r.apply(ReducerAction::StartPrepare, &mut s).unwrap();
    let result = r.apply(
        ReducerAction::ExecuteComplete(make_execution_result()),
        &mut s,
    );
    assert!(result.is_err());
}

#[test]
fn executing_start_prepare_is_invalid() {
    let (mut r, mut s) = make_reducer();
    go_to_executing(&mut r, &mut s);
    let result = r.apply(ReducerAction::StartPrepare, &mut s);
    assert!(result.is_err());
}

#[test]
fn finalizing_start_prepare_is_invalid() {
    let (mut r, mut s) = make_reducer();
    go_to_finalizing(&mut r, &mut s);
    let result = r.apply(ReducerAction::StartPrepare, &mut s);
    assert!(result.is_err());
}

#[test]
fn aborted_start_prepare_is_invalid() {
    let (mut r, mut s) = make_reducer();
    r.apply(ReducerAction::StartPrepare, &mut s).unwrap();
    r.apply(ReducerAction::Abort, &mut s).unwrap();
    assert_eq!(*r.state(), ReducerState::Aborted);
    let result = r.apply(ReducerAction::StartPrepare, &mut s);
    assert!(result.is_err());
}

#[test]
fn idle_recovery_succeeded_is_invalid() {
    let (mut r, mut s) = make_reducer();
    let result = r.apply(ReducerAction::RecoverySucceeded, &mut s);
    assert!(result.is_err());
}

// ══════════════════════════════════════════════════════════════
// Full lifecycle test
// ══════════════════════════════════════════════════════════════

#[test]
fn full_turn_lifecycle() {
    let (mut r, mut s) = make_reducer();

    // Start
    r.apply(ReducerAction::StartPrepare, &mut s).unwrap();
    assert_eq!(*r.state(), ReducerState::Preparing);

    // Prepare complete
    r.apply(ReducerAction::PrepareComplete(make_prepared_context()), &mut s)
        .unwrap();
    assert_eq!(*r.state(), ReducerState::Executing);

    // Stream chunks
    r.apply(
        ReducerAction::StreamChunk(StreamChunkEvent { data: "Hello".to_string() }),
        &mut s,
    )
    .unwrap();
    assert_eq!(*r.state(), ReducerState::Executing);

    // Execute complete
    r.apply(ReducerAction::ExecuteComplete(make_execution_result()), &mut s)
        .unwrap();
    assert_eq!(*r.state(), ReducerState::Finalizing);

    // Finalize done
    r.apply(
        ReducerAction::FinalizeComplete(FinalizeOutcome::Done),
        &mut s,
    )
    .unwrap();
    assert_eq!(*r.state(), ReducerState::Idle);
}
