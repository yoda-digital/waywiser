//! Notification classifier — deterministic, no LLM involvement.

use pi_types::AttentionDecision;
use serde::{Deserialize, Serialize};

use crate::normalized::{AndroidPriority, NormalizedNotification};
use crate::policy::NotificationPolicy;
use crate::rules::ClassificationRule;

/// Result of classifying a notification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassificationResult {
    pub source_rule: ClassificationRule,
    pub attention: AttentionDecision,
    pub reason: String,
}

/// Trait for notification classifiers.
pub trait NotificationClassifier: Send + Sync {
    fn classify(&self, notif: &NormalizedNotification) -> ClassificationResult;
}

/// Deterministic classifier using rules and policy. No LLM.
pub struct DeterministicClassifier {
    policy: NotificationPolicy,
}

impl DeterministicClassifier {
    pub fn new(policy: NotificationPolicy) -> Self {
        Self { policy }
    }

    pub fn update_policy(&mut self, policy: NotificationPolicy) {
        self.policy = policy;
    }
}

impl NotificationClassifier for DeterministicClassifier {
    fn classify(&self, notif: &NormalizedNotification) -> ClassificationResult {
        // Rule 1: Important contact → minimum NOTIFY
        if let Some(person) = &notif.person {
            if let Some(contact_id) = &person.contact_id {
                if self.policy.is_important_contact(contact_id) {
                    return ClassificationResult {
                        source_rule: ClassificationRule::ImportantContact(*contact_id),
                        attention: AttentionDecision::Notify,
                        reason: "user-designated important contact".to_string(),
                    };
                }

                // Rule 5: Family contact → minimum NOTIFY
                if self.policy.is_family_contact(contact_id) {
                    return ClassificationResult {
                        source_rule: ClassificationRule::FamilyContact(*contact_id),
                        attention: AttentionDecision::Notify,
                        reason: "known family contact".to_string(),
                    };
                }
            }
        }

        // Rule 6: Security alert
        if notif.category.as_deref() == Some("sys") || notif.category.as_deref() == Some("err") {
            return ClassificationResult {
                source_rule: ClassificationRule::SecurityAlert,
                attention: AttentionDecision::Notify,
                reason: "Android system security alert".to_string(),
            };
        }

        // Rule 7: Alarm channel
        if notif.category.as_deref() == Some("alarm") {
            return ClassificationResult {
                source_rule: ClassificationRule::AlarmChannel,
                attention: AttentionDecision::HeadsUp,
                reason: "alarm/timer channel".to_string(),
            };
        }

        // Rule 3: High priority channel
        if notif.priority >= AndroidPriority::High {
            let mut attention = AttentionDecision::HeadsUp;
            // Apply ceiling if configured
            if let Some(ceiling) = self.policy.ceiling_for(&notif.app_package) {
                attention = attention.min(ceiling);
            }
            return ClassificationResult {
                source_rule: ClassificationRule::HighPriorityChannel,
                attention,
                reason: "app-declared high-priority notification".to_string(),
            };
        }

        // Rule 4: Known app policy (ceiling)
        if let Some(ceiling) = self.policy.ceiling_for(&notif.app_package) {
            let base = priority_to_attention(notif.priority);
            let capped = base.min(ceiling);
            return ClassificationResult {
                source_rule: ClassificationRule::KnownAppPolicy {
                    package: notif.app_package.clone(),
                    ceiling,
                },
                attention: capped,
                reason: format!(
                    "known app policy: {} capped at {:?}",
                    notif.app_package, ceiling
                ),
            };
        }

        // Check app floor
        let mut base = priority_to_attention(notif.priority);
        if let Some(floor) = self.policy.floor_for(&notif.app_package) {
            base = base.max(floor);
        }

        // Default: map Android priority to attention
        ClassificationResult {
            source_rule: ClassificationRule::Default(base),
            attention: base,
            reason: "default classification by Android priority".to_string(),
        }
    }
}

/// Map Android priority to a default attention decision.
fn priority_to_attention(priority: AndroidPriority) -> AttentionDecision {
    match priority {
        AndroidPriority::Min => AttentionDecision::Drop,
        AndroidPriority::Low => AttentionDecision::Batch,
        AndroidPriority::Default => AttentionDecision::Silent,
        AndroidPriority::High => AttentionDecision::Notify,
        AndroidPriority::Max => AttentionDecision::HeadsUp,
    }
}
