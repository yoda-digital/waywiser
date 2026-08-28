//! Security Kernel — full authorization flow (blueprint §18).
//!
//! The security kernel has:
//! - no LLM dependency
//! - no model-generated policy
//! - no ability to silently reinterpret unknown behavior as safe

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use pi_types::{ActionIntent, CapabilityName, CapabilitySpec, RiskLevel};

use crate::audit::AuditEntry;
use crate::leases::ApprovalLease;

/// The central authorization authority. No LLM involvement.
pub struct SecurityKernel {
    pub registry: HashMap<CapabilityName, CapabilitySpec>,
    pub leases: Vec<ApprovalLease>,
    pub audit_log: Vec<AuditEntry>,
}

/// Result of the authorization pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SecurityDecision {
    Allowed(AuthorizationSource),
    RequiresApproval(ApprovalKind),
    Denied(DenialReason),
}

/// How the action was authorized.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuthorizationSource {
    DefaultPolicy,
    Lease(Uuid),
    UserApproval(DateTime<Utc>),
    BiometricApproval(DateTime<Utc>),
}

/// What kind of approval is needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalKind {
    /// Tap "Allow".
    UserConfirm,
    /// Fingerprint / face + tap.
    BiometricConfirm,
}

/// Why the action was denied.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DenialReason {
    UnknownCapability(CapabilityName),
    PolicyViolation(String),
    OsPermissionMissing(String),
    LeaseExpired(Uuid),
    BudgetExceeded {
        lease_id: Uuid,
        used: u32,
        max: u32,
    },
    InvariantViolation(String),
}

impl SecurityKernel {
    /// Create a new empty security kernel.
    pub fn new() -> Self {
        Self {
            registry: HashMap::new(),
            leases: Vec::new(),
            audit_log: Vec::new(),
        }
    }

    /// Register a capability specification.
    pub fn register_capability(&mut self, spec: CapabilitySpec) {
        self.registry.insert(spec.name.clone(), spec);
    }

    /// Full 6-step authorization pipeline.
    ///
    /// Step 1: Capability exists?
    /// Step 2: Risk from CapabilitySpec
    /// Step 3: Policy check
    /// Step 4: OS permission check (stub)
    /// Step 5: Active approval lease?
    /// Step 6: Determine approval kind by risk
    pub fn authorize(&mut self, intent: &ActionIntent) -> SecurityDecision {
        let now = Utc::now();

        // Step 1: Capability exists?
        let cap = match self.registry.get(&intent.capability) {
            Some(c) => c.clone(),
            None => {
                let decision = SecurityDecision::Denied(DenialReason::UnknownCapability(
                    intent.capability.clone(),
                ));
                self.record_audit(intent, &decision, &cap_risk_or_default(None), None);
                return decision;
            }
        };

        let risk = cap.risk;

        // Step 3: Policy check (extensible; currently pass-through)
        // Future: configurable per-capability policy rules
        // No policy violations at this time.

        // Step 4: OS permission check (stub — returns Ok for now)
        // In production, this checks Android runtime permissions.

        // Step 5: Active approval lease?
        if let Some((idx, lease_id)) = self.find_valid_lease(&intent.capability, intent, now) {
            // Record lease use
            self.leases[idx].record_use(intent.id, &intent.arguments, pi_types::ActionStatus::Pending);
            let decision = SecurityDecision::Allowed(AuthorizationSource::Lease(lease_id));
            self.record_audit(intent, &decision, &risk, Some(lease_id));
            return decision;
        }

        // Step 6: Determine approval kind by risk level
        let decision = match risk {
            RiskLevel::None | RiskLevel::ReadPersonal => {
                SecurityDecision::Allowed(AuthorizationSource::DefaultPolicy)
            }
            RiskLevel::DeviceControl | RiskLevel::CrossAppWrite => {
                SecurityDecision::RequiresApproval(ApprovalKind::UserConfirm)
            }
            RiskLevel::Communication | RiskLevel::Financial | RiskLevel::Destructive => {
                SecurityDecision::RequiresApproval(ApprovalKind::BiometricConfirm)
            }
            RiskLevel::UiUnclassifiedWrite => {
                SecurityDecision::RequiresApproval(ApprovalKind::UserConfirm)
            }
        };

        self.record_audit(intent, &decision, &risk, None);
        decision
    }

    /// Find a valid, non-expired, in-budget lease for the given capability.
    fn find_valid_lease(
        &self,
        capability: &CapabilityName,
        intent: &ActionIntent,
        now: DateTime<Utc>,
    ) -> Option<(usize, Uuid)> {
        for (idx, lease) in self.leases.iter().enumerate() {
            if lease.capability != *capability {
                continue;
            }
            if lease.revoked {
                continue;
            }
            if now >= lease.valid_until {
                continue;
            }
            if let Some(max) = lease.max_executions {
                if lease.executions_used >= max {
                    continue;
                }
            }
            if !lease.scope.matches(intent) {
                continue;
            }
            if !lease.constraints.permits(intent) {
                continue;
            }
            return Some((idx, lease.id));
        }
        None
    }

    /// Record an audit entry for every authorization decision.
    fn record_audit(
        &mut self,
        intent: &ActionIntent,
        decision: &SecurityDecision,
        risk: &RiskLevel,
        lease_id: Option<Uuid>,
    ) {
        self.audit_log.push(AuditEntry::new(
            intent.id,
            decision.clone(),
            intent.capability.clone(),
            *risk,
            lease_id,
        ));
    }

    /// Add an approval lease.
    pub fn grant_lease(&mut self, lease: ApprovalLease) -> Uuid {
        let id = lease.id;
        self.leases.push(lease);
        id
    }

    /// Revoke a lease by ID. Immediate effect.
    pub fn revoke_lease(&mut self, id: Uuid) -> bool {
        for lease in &mut self.leases {
            if lease.id == id {
                lease.revoke();
                return true;
            }
        }
        false
    }
}

impl Default for SecurityKernel {
    fn default() -> Self {
        Self::new()
    }
}

fn cap_risk_or_default(risk: Option<&RiskLevel>) -> RiskLevel {
    risk.copied().unwrap_or(RiskLevel::UiUnclassifiedWrite)
}
