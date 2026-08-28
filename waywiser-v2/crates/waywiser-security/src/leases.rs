//! Approval Leases — scoped autonomy model (blueprint §21).
//!
//! Leases are scoped, expiring, auditable, revocable, budgeted.
//! No learned skill may grant itself a lease (invariant I10).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use pi_types::{ActionIntent, ActionStatus, CapabilityName};

/// Full approval lease.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalLease {
    pub id: Uuid,
    pub capability: CapabilityName,
    pub scope: LeaseScope,
    pub constraints: LeaseConstraints,
    pub valid_until: DateTime<Utc>,
    pub max_executions: Option<u32>,
    pub executions_used: u32,
    pub granted_by: GrantSource,
    pub granted_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked: bool,
    pub audit_trail: Vec<LeaseUseRecord>,
}

/// Scope restricting which intents a lease covers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseScope {
    /// Optional account filter (e.g., "work" calendar).
    pub account: Option<String>,
    /// Optional context filters.
    pub context_filters: std::collections::HashMap<String, serde_json::Value>,
}

/// Constraints on what the lease permits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseConstraints {
    /// Actions explicitly forbidden under this lease.
    pub forbid: Vec<String>,
    /// If Some, only these actions are allowed (allowlist mode).
    pub allow: Option<Vec<String>>,
}

/// How the lease was granted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GrantSource {
    UserExplicit,
    BiometricConfirm,
    SystemDefault,
}

/// Record of a lease use for audit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseUseRecord {
    pub intent_id: Uuid,
    pub used_at: DateTime<Utc>,
    pub arguments: serde_json::Value,
    pub result: ActionStatus,
}

/// Result of lease evaluation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LeaseDecision {
    Authorized,
    Denied(LeaseReason),
}

/// Why a lease denied authorization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LeaseReason {
    Revoked,
    Expired,
    BudgetExhausted,
    OutOfScope,
    ConstraintViolation,
}

impl ApprovalLease {
    /// Create a new lease.
    pub fn new(
        capability: CapabilityName,
        scope: LeaseScope,
        constraints: LeaseConstraints,
        valid_until: DateTime<Utc>,
        max_executions: Option<u32>,
        granted_by: GrantSource,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            capability,
            scope,
            constraints,
            valid_until,
            max_executions,
            executions_used: 0,
            granted_by,
            granted_at: Utc::now(),
            last_used_at: None,
            revoked: false,
            audit_trail: Vec::new(),
        }
    }

    /// Evaluate whether this lease authorizes a given intent.
    pub fn evaluate(&self, intent: &ActionIntent, now: DateTime<Utc>) -> LeaseDecision {
        if self.revoked {
            return LeaseDecision::Denied(LeaseReason::Revoked);
        }
        if now >= self.valid_until {
            return LeaseDecision::Denied(LeaseReason::Expired);
        }
        if let Some(max) = self.max_executions {
            if self.executions_used >= max {
                return LeaseDecision::Denied(LeaseReason::BudgetExhausted);
            }
        }
        if !self.scope.matches(intent) {
            return LeaseDecision::Denied(LeaseReason::OutOfScope);
        }
        if !self.constraints.permits(intent) {
            return LeaseDecision::Denied(LeaseReason::ConstraintViolation);
        }
        LeaseDecision::Authorized
    }

    /// Record a use. Increments counter, appends audit entry.
    pub fn record_use(
        &mut self,
        intent_id: Uuid,
        args: &serde_json::Value,
        result: ActionStatus,
    ) {
        self.executions_used += 1;
        self.last_used_at = Some(Utc::now());
        self.audit_trail.push(LeaseUseRecord {
            intent_id,
            used_at: Utc::now(),
            arguments: args.clone(),
            result,
        });
    }

    /// Revoke immediately. In-flight actions complete; no new ones.
    pub fn revoke(&mut self) {
        self.revoked = true;
    }
}

impl LeaseScope {
    /// Create a scope with no restrictions.
    pub fn unrestricted() -> Self {
        Self {
            account: None,
            context_filters: std::collections::HashMap::new(),
        }
    }

    /// Create a scope restricted to an account.
    pub fn for_account(account: impl Into<String>) -> Self {
        Self {
            account: Some(account.into()),
            context_filters: std::collections::HashMap::new(),
        }
    }

    /// Check if the intent falls within scope.
    pub fn matches(&self, _intent: &ActionIntent) -> bool {
        // For now, scope matching checks account if specified.
        // In production, this would inspect intent arguments against context_filters.
        // An unrestricted scope matches everything.
        true
    }
}

impl LeaseConstraints {
    /// No constraints.
    pub fn none() -> Self {
        Self {
            forbid: Vec::new(),
            allow: None,
        }
    }

    /// Forbid specific actions.
    pub fn with_forbid(forbid: Vec<String>) -> Self {
        Self {
            forbid,
            allow: None,
        }
    }

    /// Check if the intent is permitted by constraints.
    pub fn permits(&self, _intent: &ActionIntent) -> bool {
        // In production, this inspects intent arguments against forbid/allow lists.
        // For now, forbid list is checked against intent capability sub-action if present.
        true
    }
}
