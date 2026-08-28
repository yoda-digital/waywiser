//! Classification rules for notifications.

use pi_types::AttentionDecision;
use serde::{Deserialize, Serialize};

use crate::normalized::ContactId;

/// Deterministic classification rule that matched.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClassificationRule {
    /// User-designated important contact → minimum NOTIFY.
    ImportantContact(ContactId),
    /// 2+ calls in 5 minutes → HEADS_UP.
    RepeatedIncomingCall { count: u32 },
    /// App-declared high-priority channel.
    HighPriorityChannel,
    /// Known app policy with ceiling (e.g., "routine CI bot" → max NOTIFY).
    KnownAppPolicy {
        package: String,
        ceiling: AttentionDecision,
    },
    /// Known family contact → minimum NOTIFY.
    FamilyContact(ContactId),
    /// Android system security alert.
    SecurityAlert,
    /// Alarm/timer channel.
    AlarmChannel,
    /// Default fallback by Android priority.
    Default(AttentionDecision),
}

impl ClassificationRule {
    /// Human-readable name of the rule.
    pub fn name(&self) -> &'static str {
        match self {
            Self::ImportantContact(_) => "important_contact",
            Self::RepeatedIncomingCall { .. } => "repeated_incoming_call",
            Self::HighPriorityChannel => "high_priority_channel",
            Self::KnownAppPolicy { .. } => "known_app_policy",
            Self::FamilyContact(_) => "family_contact",
            Self::SecurityAlert => "security_alert",
            Self::AlarmChannel => "alarm_channel",
            Self::Default(_) => "default",
        }
    }
}
