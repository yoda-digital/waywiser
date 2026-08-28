//! Audit trail for security decisions.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use pi_types::{CapabilityName, RiskLevel};

use crate::kernel::SecurityDecision;

/// Every authorization decision is recorded for audit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: Uuid,
    pub intent_id: Uuid,
    pub decision: SecurityDecision,
    pub capability: CapabilityName,
    pub risk: RiskLevel,
    pub timestamp: DateTime<Utc>,
    pub lease_id: Option<Uuid>,
}

impl AuditEntry {
    pub fn new(
        intent_id: Uuid,
        decision: SecurityDecision,
        capability: CapabilityName,
        risk: RiskLevel,
        lease_id: Option<Uuid>,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            intent_id,
            decision,
            capability,
            risk,
            timestamp: Utc::now(),
            lease_id,
        }
    }
}
