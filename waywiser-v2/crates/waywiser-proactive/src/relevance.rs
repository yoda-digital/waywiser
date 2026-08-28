//! Relevance rules: determine if a deferred reasoning job is still worth executing.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Rule that determines whether a deferred job is still relevant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RelevanceRule {
    /// Still relevant if current time is before the deadline.
    TimeWindow { expires_at: DateTime<Utc> },
    /// Still relevant if a named condition is met (human-readable description).
    ConditionMet(String),
    /// Always relevant — execute when capacity is available.
    Always,
    /// Custom relevance check (identifier for a registered function).
    Custom(String),
}

impl RelevanceRule {
    /// Check if this rule says the job is still relevant at the given time.
    pub fn is_relevant(&self, now: DateTime<Utc>) -> bool {
        match self {
            Self::TimeWindow { expires_at } => now < *expires_at,
            Self::ConditionMet(_) => true, // External check needed; assume relevant
            Self::Always => true,
            Self::Custom(_) => true, // External check needed; assume relevant
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn time_window_before_expiry_is_relevant() {
        let rule = RelevanceRule::TimeWindow {
            expires_at: Utc::now() + Duration::hours(1),
        };
        assert!(rule.is_relevant(Utc::now()));
    }

    #[test]
    fn time_window_after_expiry_is_not_relevant() {
        let rule = RelevanceRule::TimeWindow {
            expires_at: Utc::now() - Duration::hours(1),
        };
        assert!(!rule.is_relevant(Utc::now()));
    }

    #[test]
    fn always_is_relevant() {
        assert!(RelevanceRule::Always.is_relevant(Utc::now()));
    }

    #[test]
    fn condition_met_defaults_to_relevant() {
        let rule = RelevanceRule::ConditionMet("user is home".to_string());
        assert!(rule.is_relevant(Utc::now()));
    }
}
