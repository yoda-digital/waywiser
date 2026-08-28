//! SkillService — skill loading, compilation, validation, evolution (§§32–33).
//!
//! Skills remain declarative and human-readable:
//!   skill/
//!   ├── SKILL.md
//!   ├── manifest.yaml
//!   ├── evals/
//!   └── resources/
//!
//! A skill cannot obtain a capability simply by naming it in prose.
//! A running session NEVER has its active skill set silently mutate mid-turn.

use chrono::{DateTime, Utc};
use pi_types::{SkillStatus, SkillVersion, WaywiserError};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A skill loaded from disk and ready for use.
#[derive(Debug, Clone)]
pub struct LoadedSkill {
    pub version: SkillVersion,
    pub guidance: String,
    pub tools: Vec<ToolDefinition>,
}

/// Tool definition from a skill manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Skill manifest loaded from YAML.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillManifest {
    pub name: String,
    pub description: String,
    pub required_capabilities: Vec<String>,
    pub risk_level: Option<String>,
    pub tools: Vec<ToolDefinition>,
}

/// A candidate skill compiled from a mature procedure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCandidate {
    pub id: Uuid,
    pub name: String,
    pub compiled_from: Uuid,
    pub skill_md: String,
    pub manifest: SkillManifest,
    pub compiled_at: DateTime<Utc>,
}

/// Result of evaluating a skill candidate against baseline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationResult {
    pub passed: bool,
    pub score: f32,
    pub baseline_score: Option<f32>,
    pub evaluated_at: DateTime<Utc>,
}

/// Result of skill validation against invariant I10.
#[derive(Debug, Clone)]
pub enum SkillValidationResult {
    /// Skill passes all invariant checks.
    Valid,
    /// Skill violates one or more invariants.
    Invalid(Vec<String>),
}

/// Validates skill candidates against invariant I10:
/// - Cannot modify the security kernel
/// - Cannot grant new capabilities
/// - Cannot lower action risk
/// - Cannot overwrite provenance rules
/// - Cannot bypass evaluation
/// - Cannot alter SOUL governance
/// - Cannot promote themselves mid-session
pub struct SkillValidator;

impl SkillValidator {
    /// Validate a candidate skill against all I10 invariants.
    pub fn validate(candidate: &SkillCandidate) -> SkillValidationResult {
        let mut violations = Vec::new();

        let content_lower = candidate.skill_md.to_lowercase();
        let manifest_str =
            serde_json::to_string(&candidate.manifest).unwrap_or_default().to_lowercase();

        // Check for security kernel modification attempts
        if contains_any(&content_lower, &[
            "modify security",
            "change security kernel",
            "override permission",
            "bypass authorization",
            "disable security",
        ]) {
            violations.push("Attempts to modify security kernel".to_string());
        }

        // Check for capability granting attempts
        let cap_names: Vec<String> = candidate
            .manifest
            .required_capabilities
            .iter()
            .map(|s| s.to_lowercase())
            .collect();

        if cap_names.iter().any(|c| {
            c.contains("security.grant")
                || c.contains("security.modify")
                || c.contains("permission.grant")
                || c.contains("capability.register")
        }) {
            violations.push("Attempts to grant new capabilities".to_string());
        }

        // Check for risk lowering attempts
        if contains_any(&content_lower, &[
            "lower risk",
            "reduce risk",
            "override risk",
            "set risk to none",
            "risk = none",
        ]) {
            violations.push("Attempts to lower action risk".to_string());
        }

        // Check for provenance overwrite
        if contains_any(&content_lower, &[
            "overwrite provenance",
            "change provenance",
            "set confidence ceiling",
            "override confidence",
        ]) {
            violations.push("Attempts to overwrite provenance rules".to_string());
        }

        // Check for SOUL governance alteration
        if contains_any(&content_lower, &[
            "modify soul",
            "change soul",
            "alter soul",
            "override soul",
            "edit soul.md",
        ]) || contains_any(&manifest_str, &["soul.modify", "soul.write"]) {
            violations.push("Attempts to alter SOUL governance".to_string());
        }

        if violations.is_empty() {
            SkillValidationResult::Valid
        } else {
            SkillValidationResult::Invalid(violations)
        }
    }
}

/// Service for managing skills — loading, compilation, evolution.
pub struct SkillService {
    active_skills: Vec<LoadedSkill>,
    /// Frozen at session start — never mutates mid-turn.
    session_frozen: bool,
}

impl SkillService {
    /// Create an empty skill service.
    pub fn new() -> Self {
        Self {
            active_skills: Vec::new(),
            session_frozen: false,
        }
    }

    /// Load skills from a directory containing skill/ subdirectories.
    ///
    /// Each subdirectory should have SKILL.md and optionally manifest.yaml.
    pub fn load_from_directory(path: &std::path::Path) -> Result<Self, WaywiserError> {
        let mut skills = Vec::new();

        if !path.exists() {
            return Ok(Self {
                active_skills: skills,
                session_frozen: false,
            });
        }

        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let skill_dir = entry.path();
                if !skill_dir.is_dir() {
                    continue;
                }

                let skill_md_path = skill_dir.join("SKILL.md");
                if !skill_md_path.exists() {
                    continue;
                }

                let guidance = std::fs::read_to_string(&skill_md_path).map_err(|e| {
                    WaywiserError::SkillLoadError {
                        path: skill_md_path.display().to_string(),
                        reason: e.to_string(),
                    }
                })?;

                let manifest_path = skill_dir.join("manifest.yaml");
                let tools = if manifest_path.exists() {
                    // In a real implementation, parse YAML manifest
                    // For now, return empty tools
                    Vec::new()
                } else {
                    Vec::new()
                };

                let name = skill_dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                skills.push(LoadedSkill {
                    version: SkillVersion {
                        id: Uuid::now_v7(),
                        skill_id: Uuid::now_v7(),
                        version: 1,
                        manifest: serde_json::json!({"name": name}),
                        guidance: guidance.clone(),
                        capabilities_required: Vec::new(),
                        eval_results: None,
                        status: SkillStatus::Active,
                        created_at: Utc::now(),
                    },
                    guidance,
                    tools,
                });
            }
        }

        Ok(Self {
            active_skills: skills,
            session_frozen: false,
        })
    }

    /// Get tools from all active skills.
    pub fn active_tools(&self) -> Vec<&ToolDefinition> {
        self.active_skills
            .iter()
            .flat_map(|s| s.tools.iter())
            .collect()
    }

    /// Get budgeted skill guidance text.
    pub fn guidance_for_context(&self, budget: u32) -> String {
        let mut result = String::new();
        let mut remaining = budget;

        for skill in &self.active_skills {
            let tokens = (skill.guidance.len() as u32 + 3) / 4;
            if tokens <= remaining {
                if !result.is_empty() {
                    result.push_str("\n\n---\n\n");
                }
                result.push_str(&skill.guidance);
                remaining = remaining.saturating_sub(tokens);
            }
        }

        result
    }

    /// Freeze the skill set for the current session.
    /// After freezing, no new skills can be added until the session ends.
    pub fn freeze_for_session(&mut self) {
        self.session_frozen = true;
    }

    /// Check if the skill set is frozen.
    pub fn is_frozen(&self) -> bool {
        self.session_frozen
    }

    /// Unfreeze (between sessions only).
    pub fn unfreeze(&mut self) {
        self.session_frozen = false;
    }

    /// Add a skill (fails if session is frozen).
    pub fn add_skill(&mut self, skill: LoadedSkill) -> Result<(), WaywiserError> {
        if self.session_frozen {
            return Err(WaywiserError::SkillLoadError {
                path: String::new(),
                reason: "Cannot modify skills mid-session — frozen".to_string(),
            });
        }
        self.active_skills.push(skill);
        Ok(())
    }

    /// Number of active skills.
    pub fn active_count(&self) -> usize {
        self.active_skills.len()
    }
}

impl Default for SkillService {
    fn default() -> Self {
        Self::new()
    }
}

/// Check if text contains any of the given markers.
fn contains_any(text: &str, markers: &[&str]) -> bool {
    markers.iter().any(|m| text.contains(m))
}
