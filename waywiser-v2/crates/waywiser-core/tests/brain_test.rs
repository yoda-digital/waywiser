//! Tests for BrainService — learning pipeline.

use chrono::Utc;
use pi_types::{ExperienceRecord, Provenance, ProvenanceSource, SessionId};
use uuid::Uuid;
use waywiser_core::brain::{
    BrainService, CandidateKind, ConfidenceCeilings, MemoryCandidate, SignalKind, ValidationResult,
    ValidationStatus,
};

fn test_experience(summary: &str) -> ExperienceRecord {
    ExperienceRecord {
        id: Uuid::now_v7(),
        session_id: SessionId(Uuid::now_v7()),
        summary: summary.to_string(),
        raw_context: serde_json::json!({}),
        pass1_signals: Vec::new(),
        pass2_complete: false,
        created_at: Utc::now(),
    }
}

fn test_candidate(
    source: ProvenanceSource,
    model_confidence: f32,
    kind: CandidateKind,
    evidence_count: usize,
) -> MemoryCandidate {
    MemoryCandidate {
        id: Uuid::now_v7(),
        kind,
        content: "Test candidate".to_string(),
        source_experiences: (0..evidence_count).map(|_| Uuid::now_v7()).collect(),
        model_confidence,
        assigned_confidence: 0.0,
        provenance: Provenance {
            source,
            session_id: None,
            created_at: Utc::now(),
            confidence_ceiling: ConfidenceCeilings::ceiling_for(source),
        },
        validation_status: ValidationStatus::Pending,
    }
}

#[test]
fn test_pass1_detects_user_preference() {
    let brain = BrainService::new();
    let exp = test_experience("I prefer morning meetings over afternoon ones");
    let signals = brain.pass1_extract(&exp);

    assert!(!signals.is_empty());
    assert!(signals.iter().any(|s| s.kind == SignalKind::UserPreference));
}

#[test]
fn test_pass1_detects_user_correction() {
    let brain = BrainService::new();
    let exp = test_experience("No, actually my address is 123 Main St");
    let signals = brain.pass1_extract(&exp);

    assert!(!signals.is_empty());
    assert!(signals.iter().any(|s| s.kind == SignalKind::UserCorrection));
}

#[test]
fn test_pass1_detects_explicit_fact() {
    let brain = BrainService::new();
    let exp = test_experience("My name is Alice and I work at Acme Corp");
    let signals = brain.pass1_extract(&exp);

    assert!(!signals.is_empty());
    assert!(signals.iter().any(|s| s.kind == SignalKind::ExplicitFact));
}

#[test]
fn test_pass1_detects_task_outcome() {
    let brain = BrainService::new();
    let exp = test_experience("The deployment was successfully completed");
    let signals = brain.pass1_extract(&exp);

    assert!(!signals.is_empty());
    assert!(signals.iter().any(|s| s.kind == SignalKind::TaskOutcome));
}

#[test]
fn test_pass1_no_signals_for_generic() {
    let brain = BrainService::new();
    let exp = test_experience("The weather is nice today");
    let signals = brain.pass1_extract(&exp);

    assert!(signals.is_empty());
}

#[test]
fn test_confidence_ceiling_model_inference() {
    // Single model inference → 0.5 (one clever answer ≠ knowledge)
    let brain = BrainService::new();
    let candidate = test_candidate(
        ProvenanceSource::BrainReflection,
        0.9, // model claims 0.9
        CandidateKind::PersonalMemory,
        1,
    );

    match brain.validate_candidate(&candidate) {
        ValidationResult::Accept { adjusted_confidence } => {
            assert!(
                adjusted_confidence <= 0.5,
                "Model inference ceiling should cap at 0.5, got {}",
                adjusted_confidence
            );
        }
        other => panic!("Expected Accept, got {:?}", other),
    }
}

#[test]
fn test_confidence_ceiling_user_correction() {
    // User correction → 0.95
    let brain = BrainService::new();
    let candidate = test_candidate(
        ProvenanceSource::UserCorrection,
        0.99,
        CandidateKind::PersonalMemory,
        1,
    );

    match brain.validate_candidate(&candidate) {
        ValidationResult::Accept { adjusted_confidence } => {
            assert!(
                adjusted_confidence <= 0.95,
                "User correction ceiling should cap at 0.95, got {}",
                adjusted_confidence
            );
        }
        other => panic!("Expected Accept, got {:?}", other),
    }
}

#[test]
fn test_confidence_ceiling_user_explicit() {
    // User explicit → 0.9
    let brain = BrainService::new();
    let candidate = test_candidate(
        ProvenanceSource::UserExplicit,
        0.99,
        CandidateKind::PersonalMemory,
        1,
    );

    match brain.validate_candidate(&candidate) {
        ValidationResult::Accept { adjusted_confidence } => {
            assert!(
                adjusted_confidence <= 0.9,
                "User explicit ceiling should cap at 0.9, got {}",
                adjusted_confidence
            );
        }
        other => panic!("Expected Accept, got {:?}", other),
    }
}

#[test]
fn test_procedure_needs_evidence() {
    // A procedure needs at least 2 evidence observations
    let brain = BrainService::new();
    let candidate = test_candidate(
        ProvenanceSource::BrainReflection,
        0.5,
        CandidateKind::Procedure {
            trigger: "when user asks about weather".to_string(),
            action: "check outdoor temperature first".to_string(),
        },
        1, // only 1 evidence — not enough
    );

    match brain.validate_candidate(&candidate) {
        ValidationResult::NeedsMoreEvidence { current, required } => {
            assert_eq!(current, 1);
            assert_eq!(required, 2);
        }
        other => panic!("Expected NeedsMoreEvidence, got {:?}", other),
    }
}

#[test]
fn test_procedure_with_enough_evidence() {
    let brain = BrainService::new();
    let candidate = test_candidate(
        ProvenanceSource::AgentObservation,
        0.8,
        CandidateKind::Procedure {
            trigger: "meeting request".to_string(),
            action: "check calendar first".to_string(),
        },
        3, // 3 evidence — enough
    );

    match brain.validate_candidate(&candidate) {
        ValidationResult::Accept { adjusted_confidence } => {
            assert!(adjusted_confidence <= 0.5); // capped by AgentObservation ceiling
        }
        other => panic!("Expected Accept, got {:?}", other),
    }
}

#[test]
fn test_consolidation_finds_similar_memories() {
    let brain = BrainService::new();

    let memories = vec![
        pi_types::MemoryRecord {
            id: Uuid::now_v7(),
            content: "User likes coffee in the morning".to_string(),
            scope: "preferences".to_string(),
            provenance: Provenance {
                source: ProvenanceSource::UserExplicit,
                session_id: None,
                created_at: Utc::now(),
                confidence_ceiling: 0.9,
            },
            confidence: 0.8,
            usage_count: 1,
            last_recalled: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        },
        pi_types::MemoryRecord {
            id: Uuid::now_v7(),
            content: "User likes coffee in the morning time".to_string(),
            scope: "preferences".to_string(),
            provenance: Provenance {
                source: ProvenanceSource::UserExplicit,
                session_id: None,
                created_at: Utc::now(),
                confidence_ceiling: 0.9,
            },
            confidence: 0.7,
            usage_count: 0,
            last_recalled: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        },
    ];

    let result = brain.consolidate(&memories, &[]);
    // These memories are very similar and should be flagged for merge
    assert!(!result.merged_memories.is_empty());
}

#[test]
fn test_maturity_assessment() {
    assert_eq!(
        BrainService::assess_maturity(0),
        pi_types::ProcedureMaturity::Emerging
    );
    assert_eq!(
        BrainService::assess_maturity(1),
        pi_types::ProcedureMaturity::Emerging
    );
    assert_eq!(
        BrainService::assess_maturity(2),
        pi_types::ProcedureMaturity::Established
    );
    assert_eq!(
        BrainService::assess_maturity(3),
        pi_types::ProcedureMaturity::Established
    );
    assert_eq!(
        BrainService::assess_maturity(4),
        pi_types::ProcedureMaturity::Mature
    );
    assert_eq!(
        BrainService::assess_maturity(10),
        pi_types::ProcedureMaturity::Mature
    );
}
