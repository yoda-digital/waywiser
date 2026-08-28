//! 5-Layer Deterministic Risk Classifier (blueprint §§23-23.5).
//!
//! INVARIANT: Risk may only stay the same or INCREASE as layers execute.
//! A lower layer cannot reduce a higher layer's classification.
//! LLM interpretation is logged as a non-authoritative hint — it cannot lower risk.

use std::collections::HashMap;

use regex::Regex;
use serde::{Deserialize, Serialize};

use pi_types::RiskLevel;

/// Per-package security policy (Layer 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackagePolicy {
    pub package: String,
    pub automation: AutomationPolicy,
    pub floor: Option<RiskLevel>,
}

/// Whether automation is allowed for a package.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AutomationPolicy {
    Allow,
    Block,
}

/// Semantic text rule (Layer 3).
#[derive(Debug, Clone)]
pub struct SemanticRule {
    pub pattern: Regex,
    pub floor: RiskLevel,
    pub label: &'static str,
}

/// Primitive UI action kind (Layer 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PrimitiveActionKind {
    InspectTree,
    Scroll,
    OpenApp,
    Click,
    Toggle,
    TypeText,
    Paste,
    Gesture,
}

/// Non-authoritative LLM risk hint (logged, never used for final risk).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRiskHint {
    pub suggested_risk: RiskLevel,
    pub reasoning: Option<String>,
}

/// Input to the classifier.
#[derive(Debug, Clone)]
pub struct ClassificationRequest {
    pub package: String,
    pub node_text: String,
    pub action: PrimitiveActionKind,
    pub llm_hint: Option<LlmRiskHint>,
}

/// Classification layer identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ClassificationLayer {
    SensitivePackage,
    ReviewedProfile,
    SemanticRule,
    PrimitiveActionFloor,
    UnknownFallback,
}

/// One layer's contribution to the audit trace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerDecision {
    pub layer: ClassificationLayer,
    pub matched: bool,
    pub risk_at: RiskLevel,
    pub reason: String,
}

/// Approval mode determined from final risk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalMode {
    Auto,
    AskUser,
    Block,
}

/// Output from the classifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassificationResult {
    pub final_risk: RiskLevel,
    pub layer_trace: Vec<LayerDecision>,
    pub llm_hint_used: bool,
    pub approval_mode: ApprovalMode,
    pub blocked: bool,
}

/// Five-layer risk classification pipeline.
pub struct RiskClassifier {
    pub sensitive_packages: HashMap<String, PackagePolicy>,
    pub semantic_rules: Vec<SemanticRule>,
    pub primitive_floors: HashMap<PrimitiveActionKind, RiskLevel>,
}

impl RiskClassifier {
    /// Create a classifier with default rules.
    pub fn with_defaults() -> Self {
        let mut sensitive_packages = HashMap::new();
        // Default protected packages
        for pkg in &[
            "com.example.bank",
            "com.chase.mobile",
            "com.paypal.android",
        ] {
            sensitive_packages.insert(
                pkg.to_string(),
                PackagePolicy {
                    package: pkg.to_string(),
                    automation: AutomationPolicy::Block,
                    floor: Some(RiskLevel::Financial),
                },
            );
        }
        for pkg in &["com.android.settings"] {
            sensitive_packages.insert(
                pkg.to_string(),
                PackagePolicy {
                    package: pkg.to_string(),
                    automation: AutomationPolicy::Allow,
                    floor: Some(RiskLevel::DeviceControl),
                },
            );
        }

        let semantic_rules = vec![
            SemanticRule {
                pattern: Regex::new(r"(?i)\b(send|reply|publish|post|share)\b").expect("valid regex"),
                floor: RiskLevel::Communication,
                label: "communication",
            },
            SemanticRule {
                pattern: Regex::new(r"(?i)\b(pay|purchase|buy|checkout|transfer|wire)\b")
                    .expect("valid regex"),
                floor: RiskLevel::Financial,
                label: "financial",
            },
            SemanticRule {
                pattern: Regex::new(r"(?i)\b(delete|remove|erase|clear|wipe)\b")
                    .expect("valid regex"),
                floor: RiskLevel::Destructive,
                label: "destructive",
            },
            SemanticRule {
                pattern: Regex::new(r"(?i)\b(install|uninstall|permission|grant|revoke)\b")
                    .expect("valid regex"),
                floor: RiskLevel::DeviceControl,
                label: "device_control",
            },
            SemanticRule {
                pattern: Regex::new(r"(?i)\b(save|submit|apply|confirm|accept|agree)\b")
                    .expect("valid regex"),
                floor: RiskLevel::CrossAppWrite,
                label: "cross_app_write",
            },
        ];

        let mut primitive_floors = HashMap::new();
        primitive_floors.insert(PrimitiveActionKind::InspectTree, RiskLevel::ReadPersonal);
        primitive_floors.insert(PrimitiveActionKind::Scroll, RiskLevel::ReadPersonal);
        primitive_floors.insert(PrimitiveActionKind::OpenApp, RiskLevel::DeviceControl);
        primitive_floors.insert(PrimitiveActionKind::Click, RiskLevel::DeviceControl);
        primitive_floors.insert(PrimitiveActionKind::Toggle, RiskLevel::DeviceControl);
        primitive_floors.insert(PrimitiveActionKind::TypeText, RiskLevel::CrossAppWrite);
        primitive_floors.insert(PrimitiveActionKind::Paste, RiskLevel::CrossAppWrite);
        primitive_floors.insert(PrimitiveActionKind::Gesture, RiskLevel::DeviceControl);

        Self {
            sensitive_packages,
            semantic_rules,
            primitive_floors,
        }
    }

    /// Create an empty classifier (for testing).
    pub fn empty() -> Self {
        Self {
            sensitive_packages: HashMap::new(),
            semantic_rules: Vec::new(),
            primitive_floors: HashMap::new(),
        }
    }

    /// Classify risk. Layers execute in order 1→5.
    /// Risk floor can only increase; decrease is a logic error.
    pub fn classify(&self, req: &ClassificationRequest) -> ClassificationResult {
        let mut risk = RiskLevel::None;
        let mut trace = Vec::new();
        let mut blocked = false;

        // Layer 1: Sensitive-package policy
        if let Some(policy) = self.sensitive_packages.get(&req.package) {
            if policy.automation == AutomationPolicy::Block {
                blocked = true;
                trace.push(LayerDecision {
                    layer: ClassificationLayer::SensitivePackage,
                    matched: true,
                    risk_at: policy.floor.unwrap_or(RiskLevel::Financial),
                    reason: format!("sensitive-package: automation blocked for {}", req.package),
                });
                return ClassificationResult {
                    final_risk: policy.floor.unwrap_or(RiskLevel::Financial),
                    layer_trace: trace,
                    llm_hint_used: false,
                    approval_mode: ApprovalMode::Block,
                    blocked: true,
                };
            }
            if let Some(floor) = policy.floor {
                risk = risk.max(floor);
                trace.push(LayerDecision {
                    layer: ClassificationLayer::SensitivePackage,
                    matched: true,
                    risk_at: risk,
                    reason: format!("sensitive-package floor for {}", req.package),
                });
            }
        }

        // Layer 2: Reviewed automation profile
        // (Profiles are in waywiser-automation; here we just record no match)
        trace.push(LayerDecision {
            layer: ClassificationLayer::ReviewedProfile,
            matched: false,
            risk_at: risk,
            reason: "no reviewed profile for this package".to_string(),
        });

        // Layer 3: Deterministic semantic rules
        let text = &req.node_text;
        for rule in &self.semantic_rules {
            if rule.pattern.is_match(text) {
                risk = risk.max(rule.floor);
                trace.push(LayerDecision {
                    layer: ClassificationLayer::SemanticRule,
                    matched: true,
                    risk_at: risk,
                    reason: format!("semantic rule '{}' matched", rule.label),
                });
                break; // first match wins
            }
        }

        // Layer 4: Primitive action-type floor
        if let Some(&floor) = self.primitive_floors.get(&req.action) {
            risk = risk.max(floor);
            trace.push(LayerDecision {
                layer: ClassificationLayer::PrimitiveActionFloor,
                matched: true,
                risk_at: risk,
                reason: format!("primitive floor for {:?}", req.action),
            });
        }

        // Layer 5: Unknown fallback
        if risk == RiskLevel::None {
            risk = RiskLevel::UiUnclassifiedWrite;
            trace.push(LayerDecision {
                layer: ClassificationLayer::UnknownFallback,
                matched: true,
                risk_at: risk,
                reason: "unknown UI action — default to UiUnclassifiedWrite".to_string(),
            });
        }

        // Log LLM hint but NEVER let it lower risk
        if let Some(hint) = &req.llm_hint {
            tracing::info!(
                llm_suggested = ?hint.suggested_risk,
                final_risk = ?risk,
                "LLM risk hint logged (non-authoritative)"
            );
        }

        let approval_mode = match risk {
            RiskLevel::None | RiskLevel::ReadPersonal => ApprovalMode::Auto,
            RiskLevel::DeviceControl
            | RiskLevel::CrossAppWrite
            | RiskLevel::UiUnclassifiedWrite => ApprovalMode::AskUser,
            RiskLevel::Communication | RiskLevel::Financial | RiskLevel::Destructive => {
                ApprovalMode::AskUser
            }
        };

        ClassificationResult {
            final_risk: risk,
            layer_trace: trace,
            llm_hint_used: false, // always false — LLM hint is never authoritative
            approval_mode,
            blocked,
        }
    }

    /// Add a sensitive package policy.
    pub fn add_package_policy(&mut self, policy: PackagePolicy) {
        self.sensitive_packages
            .insert(policy.package.clone(), policy);
    }
}
