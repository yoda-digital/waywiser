//! Memory, Experience, Procedure, and Skill types (§§28–33).
//!
//! Brain learning pipeline:
//! Experience → Pass 1 deterministic → durable signal? → deferred Pass 2 →
//! candidate memory/procedure → deterministic validation → persist

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::{CapabilityName, SessionId};

/// Where knowledge came from — deterministic code decides, not the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProvenanceSource {
    UserExplicit,
    UserCorrection,
    AgentObservation,
    BrainReflection,
    BrainConsolidation,
    SystemDefault,
}

/// Provenance metadata for memories and procedures (§I3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provenance {
    pub source: ProvenanceSource,
    pub session_id: Option<SessionId>,
    pub created_at: DateTime<Utc>,
    /// Deterministic ceiling — the model cannot raise this.
    pub confidence_ceiling: f32,
}

/// A durable memory record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: Uuid,
    pub content: String,
    pub scope: String,
    pub provenance: Provenance,
    pub confidence: f32,
    pub usage_count: u32,
    pub last_recalled: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A raw experience awaiting reflection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperienceRecord {
    pub id: Uuid,
    pub session_id: SessionId,
    pub summary: String,
    pub raw_context: serde_json::Value,
    pub pass1_signals: Vec<String>,
    pub pass2_complete: bool,
    pub created_at: DateTime<Utc>,
}

/// Maturity level of a procedure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProcedureMaturity {
    /// Seen once — one clever answer does NOT become a procedure (§31).
    Emerging,
    /// Seen 2-3 times.
    Established,
    /// 4+ occurrences, ready for skill compilation.
    Mature,
}

/// A repeated operational pattern: WHEN X / AVOID Y / PREFER Z (§31).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Procedure {
    pub id: Uuid,
    pub pattern: String,
    pub evidence: Vec<Uuid>,
    pub confidence: f32,
    pub provenance: Provenance,
    pub maturity: ProcedureMaturity,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Status of a skill version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SkillStatus {
    Candidate,
    Active,
    Retired,
}

/// A versioned skill compiled from a mature procedure (§32).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillVersion {
    pub id: Uuid,
    pub skill_id: Uuid,
    pub version: u32,
    pub manifest: serde_json::Value,
    pub guidance: String,
    pub capabilities_required: Vec<CapabilityName>,
    pub eval_results: Option<serde_json::Value>,
    pub status: SkillStatus,
    pub created_at: DateTime<Utc>,
}
