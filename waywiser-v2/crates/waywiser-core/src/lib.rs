//! Waywiser domain services kernel.
//!
//! Central service registry (§9). Not an extension chain — a service graph.
//! Each service is a focused struct behind a trait for testability.

pub mod kernel;
pub mod identity;
pub mod memory;
pub mod brain;
pub mod permissions;
pub mod skills;

pub use kernel::WaywiserKernel;
pub use identity::{IdentityService, ParsedIdentity, IdentitySection};
pub use memory::{MemoryStore, SqliteMemoryStore};
pub use brain::{
    BrainService, CandidateKind, ConsolidationResult, MemoryCandidate, Pass1Signal,
    ValidationResult,
};
pub use permissions::{PermissionDecision, PermissionService};
pub use skills::{
    EvaluationResult, LoadedSkill, SkillCandidate, SkillManifest, SkillService,
    SkillValidationResult, SkillValidator,
};
