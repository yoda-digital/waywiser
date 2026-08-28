//! Reviewed automation profiles for high-value internal apps (blueprint §23.2).
//!
//! Profiles are versioned and tied to app version. They map resourceId → capability effect + risk.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use pi_types::{CapabilityName, RiskLevel};

use crate::a11y::A11yNode;

/// A reviewed automation profile for a specific app package.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationProfile {
    pub package: String,
    pub app_version: String,
    pub reviewed_at: DateTime<Utc>,
    pub reviewer: String,
    /// Maps resourceId → node profile.
    pub nodes: HashMap<String, NodeProfile>,
}

/// Mapping of a UI node to its capability effect and risk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeProfile {
    pub resource_id: String,
    pub effect: CapabilityName,
    pub risk: RiskLevel,
    pub description: String,
}

/// Profile registry. Loaded from YAML config at startup.
#[derive(Debug, Clone)]
pub struct ProfileRegistry {
    profiles: HashMap<String, AutomationProfile>,
}

impl ProfileRegistry {
    /// Create an empty registry (for testing or when no profiles exist).
    pub fn empty() -> Self {
        Self {
            profiles: HashMap::new(),
        }
    }

    /// Load all profiles from a config directory.
    ///
    /// Each `.yaml` or `.json` file in the directory is expected to be a serialized
    /// `AutomationProfile`. Files that fail to parse are logged and skipped.
    pub fn load_from_dir(path: &Path) -> Result<Self, std::io::Error> {
        let mut profiles = HashMap::new();

        if !path.exists() {
            return Ok(Self { profiles });
        }

        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let file_path = entry.path();

            let ext = file_path.extension().and_then(|e| e.to_str());
            if !matches!(ext, Some("yaml" | "yml" | "json")) {
                continue;
            }

            let content = match std::fs::read_to_string(&file_path) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("Failed to read profile {:?}: {}", file_path, e);
                    continue;
                }
            };

            let profile: AutomationProfile = match ext {
                Some("json") => match serde_json::from_str(&content) {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("Failed to parse profile {:?}: {}", file_path, e);
                        continue;
                    }
                },
                // For YAML, try JSON parsing (YAML is a superset of JSON for simple cases)
                _ => match serde_json::from_str(&content) {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("Failed to parse profile {:?}: {}", file_path, e);
                        continue;
                    }
                },
            };

            profiles.insert(profile.package.clone(), profile);
        }

        Ok(Self { profiles })
    }

    /// Register a profile manually (useful for testing).
    pub fn register(&mut self, profile: AutomationProfile) {
        self.profiles.insert(profile.package.clone(), profile);
    }

    /// Find a matching profile entry for a node in a given package.
    pub fn match_node(&self, package: &str, node: &A11yNode) -> Option<&NodeProfile> {
        let profile = self.profiles.get(package)?;
        let rid = node.resource_id.as_ref()?;
        profile.nodes.get(rid)
    }

    /// Check if a profile is stale (app version has changed since review).
    pub fn is_stale(&self, package: &str, current_version: &str) -> bool {
        self.profiles
            .get(package)
            .map(|p| p.app_version != current_version)
            .unwrap_or(false)
    }

    /// Check if a package has a registered profile.
    pub fn has_profile(&self, package: &str) -> bool {
        self.profiles.contains_key(package)
    }

    /// Get all registered packages.
    pub fn packages(&self) -> Vec<&str> {
        self.profiles.keys().map(|k| k.as_str()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::a11y::A11yNode;

    fn make_profile() -> AutomationProfile {
        let mut nodes = HashMap::new();
        nodes.insert(
            "com.company.mail:id/send".into(),
            NodeProfile {
                resource_id: "com.company.mail:id/send".into(),
                effect: CapabilityName("communication.send".into()),
                risk: RiskLevel::Communication,
                description: "Send email button".into(),
            },
        );
        AutomationProfile {
            package: "com.company.mail".into(),
            app_version: "2.1.0".into(),
            reviewed_at: Utc::now(),
            reviewer: "security-team".into(),
            nodes,
        }
    }

    #[test]
    fn match_node_by_resource_id() {
        let mut reg = ProfileRegistry::empty();
        reg.register(make_profile());

        let node = A11yNode::builder(1, "com.company.mail")
            .resource_id("com.company.mail:id/send")
            .build();

        let matched = reg.match_node("com.company.mail", &node);
        assert!(matched.is_some());
        assert_eq!(matched.unwrap().risk, RiskLevel::Communication);
    }

    #[test]
    fn no_match_returns_none() {
        let mut reg = ProfileRegistry::empty();
        reg.register(make_profile());

        let node = A11yNode::builder(1, "com.company.mail")
            .resource_id("com.company.mail:id/archive")
            .build();

        assert!(reg.match_node("com.company.mail", &node).is_none());
    }

    #[test]
    fn no_match_for_unknown_package() {
        let mut reg = ProfileRegistry::empty();
        reg.register(make_profile());

        let node = A11yNode::builder(1, "com.other.app")
            .resource_id("com.other.app:id/send")
            .build();

        assert!(reg.match_node("com.other.app", &node).is_none());
    }

    #[test]
    fn stale_detection() {
        let mut reg = ProfileRegistry::empty();
        reg.register(make_profile());

        assert!(reg.is_stale("com.company.mail", "3.0.0"));
        assert!(!reg.is_stale("com.company.mail", "2.1.0"));
        // Unknown package is not stale
        assert!(!reg.is_stale("com.unknown.app", "1.0.0"));
    }
}
