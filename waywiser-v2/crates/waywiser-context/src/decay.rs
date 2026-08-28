//! Temporal decay — nodes expire based on their domain kind.
//!
//! Decay configuration maps domain keys to TTLs. The graph's
//! `remove_expired()` handles the actual removal; decay config
//! is used when creating nodes to set their `expires_at`.

use std::collections::HashMap;

use chrono::Duration;

/// Decay configuration: maps domain key prefixes to TTL durations.
///
/// When a context node is created, the decay config determines its expiry.
/// A key not matching any rule gets no expiry (lives until explicitly removed).
#[derive(Debug, Clone)]
pub struct DecayConfig {
    rules: HashMap<String, Duration>,
}

impl DecayConfig {
    /// Default decay configuration per the P2 spec:
    /// - `user.activity`: 5 minutes
    /// - `user.audio_route`: 10 minutes
    /// - `user.place_context`: 30 minutes
    /// - `user.attention_state`: 5 minutes
    /// - `device.battery`: 10 minutes
    /// - `device.thermal`: 2 minutes
    /// - `device.network`: 5 minutes
    /// - `device.screen`: 2 minutes
    /// - `environment.weather`: 30 minutes
    /// - `environment.ambient_noise`: 5 minutes
    /// - `environment.time_of_day`: 60 minutes
    ///
    /// `user.next_event` uses special logic: expires when the event time passes,
    /// handled by the reducer setting `expires_at` to the event start time.
    pub fn default_config() -> Self {
        let mut rules = HashMap::new();
        rules.insert("user.activity".to_string(), Duration::minutes(5));
        rules.insert("user.audio_route".to_string(), Duration::minutes(10));
        rules.insert("user.place_context".to_string(), Duration::minutes(30));
        rules.insert("user.attention_state".to_string(), Duration::minutes(5));
        rules.insert("device.battery".to_string(), Duration::minutes(10));
        rules.insert("device.thermal".to_string(), Duration::minutes(2));
        rules.insert("device.network".to_string(), Duration::minutes(5));
        rules.insert("device.screen".to_string(), Duration::minutes(2));
        rules.insert("environment.weather".to_string(), Duration::minutes(30));
        rules.insert("environment.ambient_noise".to_string(), Duration::minutes(5));
        rules.insert("environment.time_of_day".to_string(), Duration::minutes(60));
        Self { rules }
    }

    /// Create an empty config (no decay — nodes live forever).
    pub fn no_decay() -> Self {
        Self {
            rules: HashMap::new(),
        }
    }

    /// Look up the TTL for a given domain key.
    /// Returns `None` if no rule matches (node won't expire automatically).
    pub fn ttl_for(&self, key: &str) -> Option<Duration> {
        // Exact match first
        if let Some(ttl) = self.rules.get(key) {
            return Some(*ttl);
        }
        // Prefix match (e.g., "user" matches "user.activity")
        for (rule_key, ttl) in &self.rules {
            if key.starts_with(rule_key) {
                return Some(*ttl);
            }
        }
        None
    }

    /// Set a custom TTL for a domain key.
    pub fn set_ttl(&mut self, key: impl Into<String>, ttl: Duration) {
        self.rules.insert(key.into(), ttl);
    }

    /// Remove a TTL rule for a domain key.
    pub fn remove_rule(&mut self, key: &str) -> bool {
        self.rules.remove(key).is_some()
    }
}

impl Default for DecayConfig {
    fn default() -> Self {
        Self::default_config()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config_has_expected_keys() {
        let config = DecayConfig::default_config();
        assert_eq!(config.ttl_for("user.activity"), Some(Duration::minutes(5)));
        assert_eq!(config.ttl_for("device.thermal"), Some(Duration::minutes(2)));
        assert_eq!(config.ttl_for("environment.weather"), Some(Duration::minutes(30)));
    }

    #[test]
    fn test_unknown_key_returns_none() {
        let config = DecayConfig::default_config();
        assert_eq!(config.ttl_for("unknown.key"), None);
    }

    #[test]
    fn test_no_decay_config() {
        let config = DecayConfig::no_decay();
        assert_eq!(config.ttl_for("user.activity"), None);
    }

    #[test]
    fn test_custom_ttl() {
        let mut config = DecayConfig::no_decay();
        config.set_ttl("custom.sensor", Duration::seconds(30));
        assert_eq!(config.ttl_for("custom.sensor"), Some(Duration::seconds(30)));
    }
}
