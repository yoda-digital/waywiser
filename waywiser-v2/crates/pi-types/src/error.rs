//! Unified error taxonomy.
//!
//! Each variant carries enough context for structured Kotlin exceptions
//! when crossing the FFI boundary.

use uuid::Uuid;

use crate::ids::{CapabilityName, SessionId};

/// Unified error type crossing the FFI boundary.
#[derive(Debug, thiserror::Error)]
pub enum WaywiserError {
    // ── Pi core ──
    #[error("session not found: {0}")]
    SessionNotFound(SessionId),

    #[error("lane not found: {lane_id}")]
    LaneNotFound { lane_id: Uuid },

    #[error("session corrupted: {reason}")]
    SessionCorrupted {
        session_id: SessionId,
        reason: String,
    },

    #[error("compaction failed: {0}")]
    CompactionFailed(String),

    // ── Inference ──
    #[error("inference unavailable: {0}")]
    InferenceUnavailable(String),

    #[error("inference timeout after {ms}ms")]
    InferenceTimeout { ms: u64 },

    #[error("model identity mismatch: expected {expected}, got {actual}")]
    ModelMismatch { expected: String, actual: String },

    #[error("streaming interrupted: {0}")]
    StreamInterrupted(String),

    // ── Security ──
    #[error("capability not registered: {0}")]
    UnknownCapability(CapabilityName),

    #[error("action denied: {reason}")]
    ActionDenied { intent_id: Uuid, reason: String },

    #[error("lease expired: {lease_id}")]
    LeaseExpired { lease_id: Uuid },

    #[error("lease budget exhausted: {lease_id}")]
    LeaseBudgetExhausted { lease_id: Uuid },

    // ── Memory / Brain ──
    #[error("memory store error: {0}")]
    MemoryStore(String),

    #[error("brain pass failed: {0}")]
    BrainPassFailed(String),

    // ── Skill ──
    #[error("skill load error: {path}: {reason}")]
    SkillLoadError { path: String, reason: String },

    #[error("skill validation failed: {0}")]
    SkillValidationFailed(String),

    // ── Work ──
    #[error("work item not found: {0}")]
    WorkItemNotFound(Uuid),

    #[error("invalid work transition: {from} -> {to}")]
    InvalidWorkTransition { from: String, to: String },

    // ── Delegation ──
    #[error("delegation depth exceeded: max {max}, current {current}")]
    DelegationDepthExceeded { max: u8, current: u8 },

    #[error("delegation budget exceeded: {detail}")]
    DelegationBudgetExceeded { detail: String },

    // ── Accessibility ──
    #[error("accessibility unavailable: {0}")]
    AccessibilityUnavailable(String),

    #[error("TOCTOU mismatch: target changed between plan and execution")]
    TocTouMismatch { detail: String },

    #[error("secure window: visual automation unavailable")]
    SecureWindow,

    // ── Storage ──
    #[error("database error: {0}")]
    Database(String),

    // ── FFI ──
    #[error("internal panic caught: {0}")]
    InternalPanic(String),

    // ── General ──
    #[error("{0}")]
    Other(String),
}
