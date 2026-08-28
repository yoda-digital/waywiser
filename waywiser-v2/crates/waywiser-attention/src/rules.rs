//! Attention rules — sources, signals, and configurable rules.

use pi_types::AttentionDecision;
use serde::{Deserialize, Serialize};

/// A specific system notification channel type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SystemChannel {
    AlarmClock,
    IncomingCall,
    SecurityAlert,
    DeviceWarning,
}

/// The source of an attention signal. Used for floor/ceiling matching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttentionSource {
    /// A specific contact by ID.
    Contact(String),
    /// A contact group (e.g., "family", "vip").
    ContactGroup(String),
    /// A specific app + notification channel.
    AppChannel {
        package: String,
        channel_id: String,
    },
    /// All notifications from an app package.
    AppPackage(String),
    /// A notification category (e.g., "email", "social").
    NotificationCategory(String),
    /// A system channel (alarm, call, security).
    SystemChannel(SystemChannel),
}

/// A configurable attention rule: sets floor and/or ceiling for a source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttentionRule {
    /// The source this rule matches.
    pub source: AttentionSource,
    /// Minimum attention level for this source.
    pub floor: Option<AttentionDecision>,
    /// Maximum attention level for this source.
    pub ceiling: Option<AttentionDecision>,
    /// Rule priority (lower = higher priority; 0 is highest).
    pub priority: u8,
}

/// An incoming signal to be evaluated by the attention governor.
#[derive(Debug, Clone)]
pub struct AttentionSignal {
    /// The source of this signal.
    pub source: AttentionSource,
    /// Content text (for pattern matching or logging).
    pub content: String,
    /// Android notification priority, if applicable.
    pub android_priority: Option<i32>,
}

impl AttentionRule {
    /// Check whether this rule matches a given attention source.
    pub fn matches(&self, signal_source: &AttentionSource) -> bool {
        match (&self.source, signal_source) {
            // Exact match
            (a, b) if a == b => true,
            // ContactGroup matches individual contacts in that group
            // (caller must resolve group membership before calling)
            _ => false,
        }
    }
}
