//! Attention governor decisions (§14).
//!
//! The Attention Governor decides whether information should affect
//! the user's attention. Ordering is significant for floor/ceiling enforcement.

use serde::{Deserialize, Serialize};

/// Attention governor decisions (§14).
/// Ordering: Drop < Batch < Silent < Notify < HeadsUp < Voice < Urgent.
/// PartialOrd/Ord derive follows variant declaration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum AttentionDecision {
    /// Discard entirely — don't even log.
    Drop,
    /// Collect into a batch for periodic summary.
    Batch,
    /// Log but don't notify.
    Silent,
    /// Show a notification.
    Notify,
    /// Show a heads-up (high-priority) notification.
    HeadsUp,
    /// Speak the notification aloud.
    Voice,
    /// Urgent: requires immediate attention (alarm, emergency).
    Urgent,
}
