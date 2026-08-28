//! Shared foundation types for the Waywiser v2 native runtime.
//!
//! This crate defines the canonical contracts used across every other crate
//! in the workspace. Types defined here are extended by later phases but
//! never redefined.

pub mod ids;
pub mod observation;
pub mod action;
pub mod capability;
pub mod memory;
pub mod message;
pub mod session;
pub mod attention;
pub mod error;

// Re-export commonly used types at crate root
pub use ids::*;
pub use observation::{
    ConsentScope, Observation, ObservationKind, ObservationSource, RetentionClass, Sensitivity,
};
pub use action::{
    ActionIntent, ActionOrigin, ActionReceipt, ActionStatus, EvidenceRef, ReplayPolicy,
    VerificationStatus,
};
pub use capability::{CapabilitySpec, ExecutionMode, RiskLevel};
pub use memory::{
    ExperienceRecord, MemoryRecord, Procedure, ProcedureMaturity, Provenance, ProvenanceSource,
    SkillStatus, SkillVersion,
};
pub use message::{
    AgentMessage, AssistantMessage, ContentPart, MessageContent, SystemMessage, ToolCall,
    ToolMessage, TokenUsage, UserMessage,
};
pub use session::{
    AggregateUsage, Branch, DeferredItem, Entry, FollowUpRequest, Lane, LaneQueue, LaneStatus,
    NextRunRequest, SessionState, SteerRequest,
};
pub use attention::AttentionDecision;
pub use error::WaywiserError;
