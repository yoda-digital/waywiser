//! PermissionService — basic security kernel (§18).
//!
//! Registry of capabilities with risk-based authorization.
//! Unknown capabilities fail closed (invariant I9).
//! Full lease model in waywiser-security crate.

use pi_types::{ActionIntent, CapabilityName, CapabilitySpec, RiskLevel};
use std::collections::HashMap;

/// Result of evaluating an action intent against the permission service.
#[derive(Debug, Clone)]
pub enum PermissionDecision {
    /// Capability exists, risk acceptable, proceed.
    Allowed,
    /// Capability exists but requires user approval.
    RequiresApproval { risk: RiskLevel, reason: String },
    /// Unknown capability or policy violation — fail closed (I9).
    Denied { reason: String },
}

/// Basic permission service — capability registry with risk-based decisions.
///
/// This is the foundation layer. The full SecurityKernel in
/// waywiser-security extends this with leases, 5-layer risk
/// classification, and audit trails.
pub struct PermissionService {
    registry: HashMap<CapabilityName, CapabilitySpec>,
}

impl PermissionService {
    /// Create an empty permission service.
    pub fn new() -> Self {
        Self {
            registry: HashMap::new(),
        }
    }

    /// Register a capability spec. Overwrites if already present.
    pub fn register_capability(&mut self, spec: CapabilitySpec) {
        self.registry.insert(spec.name.clone(), spec);
    }

    /// Get a capability spec by name.
    pub fn get_capability(&self, name: &CapabilityName) -> Option<&CapabilitySpec> {
        self.registry.get(name)
    }

    /// Check whether a capability exists and classify risk.
    ///
    /// Invariant I9: Unknown capability behavior fails closed.
    /// Unknown capabilities cannot execute.
    pub fn evaluate(&self, intent: &ActionIntent) -> PermissionDecision {
        // Step 1: Capability must exist in registry
        let spec = match self.registry.get(&intent.capability) {
            Some(s) => s,
            None => {
                return PermissionDecision::Denied {
                    reason: format!(
                        "Unknown capability: {:?} — fail closed (I9)",
                        intent.capability
                    ),
                };
            }
        };

        // Step 2: Risk-based decision
        let risk = spec.risk;

        match risk {
            RiskLevel::None | RiskLevel::ReadPersonal => {
                // Low risk — allow without explicit approval
                PermissionDecision::Allowed
            }
            RiskLevel::DeviceControl | RiskLevel::CrossAppWrite => {
                // Medium risk — requires user confirmation
                PermissionDecision::RequiresApproval {
                    risk,
                    reason: format!(
                        "Capability {:?} has risk level {:?} — user confirmation required",
                        intent.capability, risk
                    ),
                }
            }
            RiskLevel::Communication | RiskLevel::Financial | RiskLevel::Destructive => {
                // High risk — requires biometric + user confirmation
                PermissionDecision::RequiresApproval {
                    risk,
                    reason: format!(
                        "Capability {:?} has risk level {:?} — biometric confirmation required",
                        intent.capability, risk
                    ),
                }
            }
            RiskLevel::UiUnclassifiedWrite => {
                // Unknown UI write — requires user confirmation
                PermissionDecision::RequiresApproval {
                    risk,
                    reason: format!(
                        "Unclassified UI write for {:?} — user must approve",
                        intent.capability
                    ),
                }
            }
        }
    }

    /// Number of registered capabilities.
    pub fn capability_count(&self) -> usize {
        self.registry.len()
    }

    /// All registered capability names.
    pub fn registered_capabilities(&self) -> Vec<&CapabilityName> {
        self.registry.keys().collect()
    }
}

impl Default for PermissionService {
    fn default() -> Self {
        Self::new()
    }
}
