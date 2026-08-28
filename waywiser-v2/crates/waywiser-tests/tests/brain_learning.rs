//! Integration test: Brain learning pipeline (P2 acceptance criteria).

use pi_types::*;
use waywiser_core::brain::{BrainService, CandidateKind, ConfidenceCeilings, MemoryCandidate, ValidationStatus};

#[test]
fn pass1_extracts_signals_from_experiences() {
    let brain = BrainService::new();

    let experiences: Vec<ExperienceRecord> = (0..4)
        .map(|i| ExperienceRecord {
            id: uuid::Uuid::now_v7(),
            session_id: SessionId::new(),
            summary: format!(
                "User asked to schedule meeting in the morning. User said 'I prefer mornings'. Attempt {}.",
                i + 1
            ),
            raw_context: serde_json::json!({
                "user_message": "Schedule it for the morning please",
                "topic": "scheduling_preference"
            }),
            pass1_signals: vec![],
            pass2_complete: false,
            created_at: chrono::Utc::now(),
        })
        .collect();

    for exp in &experiences {
        let signals = brain.pass1_extract(exp);
        assert!(!signals.is_empty(),
            "each experience should produce at least one signal");
    }
}

#[test]
fn confidence_ceilings_enforced() {
    let brain = BrainService::new();

    // Model inference ceiling = 0.5
    let model_candidate = MemoryCandidate {
        id: uuid::Uuid::now_v7(),
        kind: CandidateKind::PersonalMemory,
        content: "User prefers morning meetings".into(),
        source_experiences: vec![uuid::Uuid::now_v7()],
        model_confidence: 0.95,
        assigned_confidence: 0.0,
        provenance: Provenance {
            source: ProvenanceSource::BrainReflection,
            session_id: None,
            created_at: chrono::Utc::now(),
            confidence_ceiling: ConfidenceCeilings::ceiling_for(ProvenanceSource::BrainReflection),
        },
        validation_status: ValidationStatus::Pending,
    };

    let result = brain.validate_candidate(&model_candidate);
    match result {
        waywiser_core::brain::ValidationResult::Accept { adjusted_confidence } => {
            assert!(adjusted_confidence <= 0.5,
                "model inference capped at 0.5, got {}", adjusted_confidence);
        }
        _ => {
            // NeedsMoreEvidence is also acceptable for single experience
        }
    }

    // User correction ceiling = 0.95
    let correction_candidate = MemoryCandidate {
        id: uuid::Uuid::now_v7(),
        kind: CandidateKind::Correction {
            corrects: uuid::Uuid::now_v7(),
        },
        content: "User corrected: prefers afternoon meetings".into(),
        source_experiences: vec![uuid::Uuid::now_v7()],
        model_confidence: 1.0,
        assigned_confidence: 0.0,
        provenance: Provenance {
            source: ProvenanceSource::UserCorrection,
            session_id: None,
            created_at: chrono::Utc::now(),
            confidence_ceiling: ConfidenceCeilings::ceiling_for(ProvenanceSource::UserCorrection),
        },
        validation_status: ValidationStatus::Pending,
    };

    let result = brain.validate_candidate(&correction_candidate);
    match result {
        waywiser_core::brain::ValidationResult::Accept { adjusted_confidence } => {
            assert!(adjusted_confidence <= 0.95,
                "user correction capped at 0.95, got {}", adjusted_confidence);
            assert!(adjusted_confidence > 0.5,
                "user correction should be higher than model inference");
        }
        other => {
            panic!("user correction should be accepted, got: {:?}", other);
        }
    }
}

#[test]
fn confidence_ceiling_values_match_spec() {
    assert_eq!(ConfidenceCeilings::ceiling_for(ProvenanceSource::BrainReflection), 0.5);
    assert_eq!(ConfidenceCeilings::ceiling_for(ProvenanceSource::UserExplicit), 0.9);
    assert_eq!(ConfidenceCeilings::ceiling_for(ProvenanceSource::UserCorrection), 0.95);
    assert_eq!(ConfidenceCeilings::ceiling_for(ProvenanceSource::AgentObservation), 0.5);
    assert_eq!(ConfidenceCeilings::ceiling_for(ProvenanceSource::SystemDefault), 0.85);
}

#[test]
fn procedure_maturity_progression() {
    let m1 = BrainService::assess_maturity(1);
    assert!(matches!(m1, ProcedureMaturity::Emerging));

    let m3 = BrainService::assess_maturity(3);
    assert!(matches!(m3, ProcedureMaturity::Emerging | ProcedureMaturity::Established));

    let m5 = BrainService::assess_maturity(5);
    assert!(matches!(m5, ProcedureMaturity::Mature));
}
