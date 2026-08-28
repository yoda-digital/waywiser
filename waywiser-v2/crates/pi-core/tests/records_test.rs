//! Serialization round-trip tests for all 13 OperationRecord variants.

use chrono::Utc;
use pi_core::records::OperationRecord;
use pi_core::reducer::CorruptionKind;
use pi_types::*;

fn roundtrip(record: &OperationRecord) {
    let json = serde_json::to_string(record).expect("serialize");
    let back: OperationRecord = serde_json::from_str(&json).expect("deserialize");
    // Verify timestamp is preserved
    assert_eq!(record.timestamp(), back.timestamp());
}

#[test]
fn roundtrip_turn_started() {
    roundtrip(&OperationRecord::TurnStarted {
        entry_id: EntryId::new(),
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_turn_completed() {
    roundtrip(&OperationRecord::TurnCompleted {
        entry_id: EntryId::new(),
        usage: TokenUsage {
            prompt_tokens: 100,
            completion_tokens: 50,
            thinking_tokens: 20,
        },
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_tool_call_started() {
    roundtrip(&OperationRecord::ToolCallStarted {
        call_id: "tc_123".to_string(),
        name: "calendar.read".to_string(),
        replay: ReplayPolicy::SafeReplay,
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_tool_call_completed() {
    roundtrip(&OperationRecord::ToolCallCompleted {
        call_id: "tc_123".to_string(),
        success: true,
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_steer_applied() {
    roundtrip(&OperationRecord::SteerApplied {
        request: SteerRequest {
            content: "go left".to_string(),
            requested_at: Utc::now(),
        },
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_follow_up_queued() {
    roundtrip(&OperationRecord::FollowUpQueued {
        reason: "more info needed".to_string(),
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_abort_requested() {
    roundtrip(&OperationRecord::AbortRequested {
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_compaction_performed() {
    roundtrip(&OperationRecord::CompactionPerformed {
        lane_id: LaneId::new(),
        entries_removed: 5,
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_lane_created() {
    roundtrip(&OperationRecord::LaneCreated {
        lane_id: LaneId::new(),
        parent_branch: Some(uuid::Uuid::now_v7()),
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_lane_status_changed() {
    roundtrip(&OperationRecord::LaneStatusChanged {
        lane_id: LaneId::new(),
        from: LaneStatus::Active,
        to: LaneStatus::Completed,
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_branch_created() {
    roundtrip(&OperationRecord::BranchCreated {
        branch: Branch {
            id: uuid::Uuid::now_v7(),
            parent_lane_id: LaneId::new(),
            child_lane_id: LaneId::new(),
            branch_point: EntryId::new(),
            reason: "user branched".to_string(),
        },
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_context_transformed() {
    roundtrip(&OperationRecord::ContextTransformed {
        description: "injected identity and memory".to_string(),
        timestamp: Utc::now(),
    });
}

#[test]
fn roundtrip_recovery_performed() {
    roundtrip(&OperationRecord::RecoveryPerformed {
        kind: CorruptionKind::RecordLogMismatch,
        success: true,
        timestamp: Utc::now(),
    });
}
