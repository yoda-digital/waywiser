//! BrainService — learning pipeline (§§28–32).
//!
//! Pipeline: Experience → Pass 1 deterministic → durable signal? →
//! deferred Pass 2 reflection → candidate memory/procedure →
//! deterministic validation → persist.
//!
//! The reflective model proposes meaning. Deterministic validation
//! decides provenance and confidence ceilings.

use chrono::Utc;
use pi_types::{
    ExperienceRecord, MemoryRecord, Procedure, ProcedureMaturity, Provenance, ProvenanceSource,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A deterministic signal extracted from an experience (Pass 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pass1Signal {
    pub kind: SignalKind,
    pub content: String,
    pub confidence: f32,
}

/// Types of deterministic signals Pass 1 can extract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SignalKind {
    /// User stated a preference ("I prefer X").
    UserPreference,
    /// User made a correction ("No, it's actually X").
    UserCorrection,
    /// A pattern repeated from prior experiences.
    RepeatedPattern,
    /// A task outcome (success/failure) worth recording.
    TaskOutcome,
    /// An explicit fact stated by user.
    ExplicitFact,
}

/// A candidate memory or procedure proposed by Pass 2 reflection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryCandidate {
    pub id: Uuid,
    pub kind: CandidateKind,
    pub content: String,
    pub source_experiences: Vec<Uuid>,
    /// Model's proposed confidence — will be capped by deterministic ceiling.
    pub model_confidence: f32,
    /// Actual confidence after deterministic ceiling enforcement.
    pub assigned_confidence: f32,
    pub provenance: Provenance,
    pub validation_status: ValidationStatus,
}

/// What kind of candidate this is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CandidateKind {
    /// A personal memory about the user.
    PersonalMemory,
    /// An operational procedure (WHEN X / AVOID Y / PREFER Z).
    Procedure {
        trigger: String,
        action: String,
    },
    /// A correction to an existing belief.
    Correction {
        corrects: Uuid,
    },
}

/// Validation status of a candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ValidationStatus {
    Pending,
    Accepted,
    Rejected { reason: String },
    NeedsMoreEvidence { current: u32, required: u32 },
}

/// Result of validating a candidate.
#[derive(Debug, Clone)]
pub enum ValidationResult {
    /// Candidate accepted with adjusted confidence.
    Accept { adjusted_confidence: f32 },
    /// Candidate rejected.
    Reject { reason: String },
    /// Need more evidence before accepting.
    NeedsMoreEvidence { current: u32, required: u32 },
}

/// Result of consolidation.
#[derive(Debug, Clone)]
pub struct ConsolidationResult {
    /// Memories that were merged.
    pub merged_memories: Vec<(Uuid, Uuid)>,
    /// Procedures that were merged.
    pub merged_procedures: Vec<(Uuid, Uuid)>,
    /// Number of items examined.
    pub examined: usize,
}

/// Confidence ceilings by provenance source (§29).
///
/// Deterministic code decides the max confidence — the model cannot raise it.
pub struct ConfidenceCeilings;

impl ConfidenceCeilings {
    /// Single model inference → 0.5 (one clever answer ≠ knowledge).
    pub const MODEL_INFERENCE: f32 = 0.5;
    /// User explicit statement → 0.9 (high trust, not absolute).
    pub const USER_EXPLICIT: f32 = 0.9;
    /// User correction → 0.95 (deliberate correction > casual statement).
    pub const USER_CORRECTION: f32 = 0.95;
    /// Repeated observation (3+) → 0.7 (pattern emerging).
    pub const REPEATED_OBSERVATION: f32 = 0.7;
    /// Verified external data → 0.85 (calendar entry, API response).
    pub const VERIFIED_EXTERNAL: f32 = 0.85;

    /// Get the ceiling for a given provenance source.
    pub fn ceiling_for(source: ProvenanceSource) -> f32 {
        match source {
            ProvenanceSource::UserExplicit => Self::USER_EXPLICIT,
            ProvenanceSource::UserCorrection => Self::USER_CORRECTION,
            ProvenanceSource::AgentObservation => Self::MODEL_INFERENCE,
            ProvenanceSource::BrainReflection => Self::MODEL_INFERENCE,
            ProvenanceSource::BrainConsolidation => Self::MODEL_INFERENCE,
            ProvenanceSource::SystemDefault => Self::VERIFIED_EXTERNAL,
        }
    }
}

/// Brain service managing the learning pipeline.
pub struct BrainService;

impl BrainService {
    /// Create a new BrainService.
    pub fn new() -> Self {
        Self
    }

    /// Pass 1: Deterministic signal extraction (§29).
    ///
    /// Runs immediately after experience is created. No model calls.
    /// Pure rule-based extraction looking for:
    /// - User preferences ("I prefer", "I like", "I want")
    /// - User corrections ("No, actually", "That's wrong", "correct it to")
    /// - Repeated patterns (matching prior signals)
    /// - Task outcomes (success/failure markers)
    /// - Explicit facts ("My X is Y", "I am", "I have")
    pub fn pass1_extract(&self, experience: &ExperienceRecord) -> Vec<Pass1Signal> {
        let mut signals = Vec::new();
        let summary_lower = experience.summary.to_lowercase();

        // Detect user preferences
        for marker in &["i prefer", "i like", "i want", "i'd rather", "please always", "please never"] {
            if summary_lower.contains(marker) {
                signals.push(Pass1Signal {
                    kind: SignalKind::UserPreference,
                    content: experience.summary.clone(),
                    confidence: 0.8,
                });
                break;
            }
        }

        // Detect user corrections
        for marker in &["no, actually", "that's wrong", "that's not right", "correct it to", "i meant", "not that, "] {
            if summary_lower.contains(marker) {
                signals.push(Pass1Signal {
                    kind: SignalKind::UserCorrection,
                    content: experience.summary.clone(),
                    confidence: 0.9,
                });
                break;
            }
        }

        // Detect explicit facts
        for marker in &["my name is", "i am ", "i have ", "i live ", "i work "] {
            if summary_lower.contains(marker) {
                signals.push(Pass1Signal {
                    kind: SignalKind::ExplicitFact,
                    content: experience.summary.clone(),
                    confidence: 0.85,
                });
                break;
            }
        }

        // Detect task outcomes
        if summary_lower.contains("successfully") || summary_lower.contains("completed") {
            signals.push(Pass1Signal {
                kind: SignalKind::TaskOutcome,
                content: experience.summary.clone(),
                confidence: 0.7,
            });
        } else if summary_lower.contains("failed") || summary_lower.contains("error") {
            signals.push(Pass1Signal {
                kind: SignalKind::TaskOutcome,
                content: experience.summary.clone(),
                confidence: 0.7,
            });
        }

        signals
    }

    /// Validate a candidate memory/procedure against deterministic rules.
    ///
    /// Enforces confidence ceilings based on provenance source.
    /// A model cannot raise its own confidence above the ceiling.
    pub fn validate_candidate(&self, candidate: &MemoryCandidate) -> ValidationResult {
        let ceiling = ConfidenceCeilings::ceiling_for(candidate.provenance.source);

        // Enforce ceiling: assigned confidence cannot exceed provenance ceiling
        let adjusted = candidate.model_confidence.min(ceiling);

        // Procedures need evidence count check
        if let CandidateKind::Procedure { .. } = &candidate.kind {
            let evidence_count = candidate.source_experiences.len() as u32;
            if evidence_count < 2 {
                return ValidationResult::NeedsMoreEvidence {
                    current: evidence_count,
                    required: 2,
                };
            }
        }

        // Reject if confidence too low after ceiling
        if adjusted < 0.1 {
            return ValidationResult::Reject {
                reason: "Confidence too low after ceiling enforcement".to_string(),
            };
        }

        ValidationResult::Accept {
            adjusted_confidence: adjusted,
        }
    }

    /// Consolidation: merge related memories and procedures (§30).
    ///
    /// Runs periodically during idle time. Identifies similar
    /// memories/procedures and proposes merges.
    pub fn consolidate(
        &self,
        memories: &[MemoryRecord],
        procedures: &[Procedure],
    ) -> ConsolidationResult {
        let mut merged_memories = Vec::new();
        let mut merged_procedures = Vec::new();

        // Simple content-similarity check for memories
        for i in 0..memories.len() {
            for j in (i + 1)..memories.len() {
                if memories[i].scope == memories[j].scope
                    && simple_similarity(&memories[i].content, &memories[j].content) > 0.8
                {
                    merged_memories.push((memories[i].id, memories[j].id));
                }
            }
        }

        // Pattern-similarity check for procedures
        for i in 0..procedures.len() {
            for j in (i + 1)..procedures.len() {
                if simple_similarity(&procedures[i].pattern, &procedures[j].pattern) > 0.8 {
                    merged_procedures.push((procedures[i].id, procedures[j].id));
                }
            }
        }

        ConsolidationResult {
            merged_memories,
            merged_procedures,
            examined: memories.len() + procedures.len(),
        }
    }

    /// Determine procedure maturity based on evidence count.
    pub fn assess_maturity(evidence_count: usize) -> ProcedureMaturity {
        match evidence_count {
            0..=1 => ProcedureMaturity::Emerging,
            2..=3 => ProcedureMaturity::Established,
            _ => ProcedureMaturity::Mature,
        }
    }

    /// Create a new provenance with appropriate confidence ceiling.
    pub fn create_provenance(
        source: ProvenanceSource,
        session_id: Option<pi_types::SessionId>,
    ) -> Provenance {
        Provenance {
            source,
            session_id,
            created_at: Utc::now(),
            confidence_ceiling: ConfidenceCeilings::ceiling_for(source),
        }
    }
}

impl Default for BrainService {
    fn default() -> Self {
        Self::new()
    }
}

/// Simple word-overlap similarity (Jaccard index on words).
fn simple_similarity(a: &str, b: &str) -> f64 {
    let words_a: std::collections::HashSet<&str> = a.split_whitespace().collect();
    let words_b: std::collections::HashSet<&str> = b.split_whitespace().collect();

    if words_a.is_empty() && words_b.is_empty() {
        return 1.0;
    }

    let intersection = words_a.intersection(&words_b).count();
    let union = words_a.union(&words_b).count();

    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}
