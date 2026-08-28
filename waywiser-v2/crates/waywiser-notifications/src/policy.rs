//! User-configurable notification policies.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use pi_types::AttentionDecision;

use crate::normalized::ContactId;

/// User-configurable notification policies.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NotificationPolicy {
    /// Contacts the user marked as important → minimum NOTIFY.
    pub important_contacts: Vec<ContactId>,
    /// Known family contacts → minimum NOTIFY.
    pub family_contacts: Vec<ContactId>,
    /// Per-app attention ceilings (package → max level).
    pub app_ceilings: HashMap<String, AttentionDecision>,
    /// Per-app attention floors (package → min level).
    pub app_floors: HashMap<String, AttentionDecision>,
}

impl NotificationPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if a contact is designated as important.
    pub fn is_important_contact(&self, id: &ContactId) -> bool {
        self.important_contacts.contains(id)
    }

    /// Check if a contact is a family member.
    pub fn is_family_contact(&self, id: &ContactId) -> bool {
        self.family_contacts.contains(id)
    }

    /// Get the attention ceiling for a package, if configured.
    pub fn ceiling_for(&self, package: &str) -> Option<AttentionDecision> {
        self.app_ceilings.get(package).copied()
    }

    /// Get the attention floor for a package, if configured.
    pub fn floor_for(&self, package: &str) -> Option<AttentionDecision> {
        self.app_floors.get(package).copied()
    }
}
