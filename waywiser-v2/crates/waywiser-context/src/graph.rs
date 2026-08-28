//! Context Graph — the structured working memory.
//!
//! A flat map of domain nodes keyed by string (e.g., "user.activity",
//! "device.battery"). Not permanent history — nodes expire via temporal decay.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use pi_types::ObservationSource;
use serde::{Deserialize, Serialize};

use crate::ContextDomain;

/// A single node in the context graph with metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextNode {
    pub domain: ContextDomain,
    pub updated_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub source: ObservationSource,
}

/// The full context graph: a flat map of domain nodes keyed by string.
///
/// Keys follow the pattern `"{domain}.{field}"`, e.g.:
/// - `"user.activity"`, `"user.audio_route"`, `"user.next_event"`
/// - `"device.battery"`, `"device.thermal"`
/// - `"environment.weather"`, `"environment.time_of_day"`
#[derive(Debug, Clone, Default)]
pub struct ContextGraph {
    nodes: HashMap<String, ContextNode>,
}

impl ContextGraph {
    /// Create a new empty context graph.
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
        }
    }

    /// Update (upsert) a node in the graph.
    pub fn update(&mut self, key: &str, node: ContextNode) {
        self.nodes.insert(key.to_string(), node);
    }

    /// Get a node by key.
    pub fn get(&self, key: &str) -> Option<&ContextNode> {
        self.nodes.get(key)
    }

    /// Check if a node exists (regardless of expiry).
    pub fn has_node(&self, key: &str) -> bool {
        self.nodes.contains_key(key)
    }

    /// Remove all nodes that have expired before `now`.
    /// Returns the number of nodes removed.
    pub fn remove_expired(&mut self, now: DateTime<Utc>) -> usize {
        let before = self.nodes.len();
        self.nodes.retain(|_key, node| {
            match node.expires_at {
                Some(exp) => exp > now,
                None => true, // no expiry → keep
            }
        });
        before - self.nodes.len()
    }

    /// Take an immutable snapshot of the current graph state.
    pub fn snapshot(&self) -> ContextGraphSnapshot {
        ContextGraphSnapshot {
            nodes: self
                .nodes
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            captured_at: Utc::now(),
        }
    }

    /// Iterate over all nodes as `(key, node)` pairs.
    pub fn all_nodes(&self) -> Vec<(&str, &ContextNode)> {
        self.nodes.iter().map(|(k, v)| (k.as_str(), v)).collect()
    }

    /// Number of nodes currently in the graph.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Whether the graph is empty.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Remove a specific node by key. Returns the removed node if it existed.
    pub fn remove(&mut self, key: &str) -> Option<ContextNode> {
        self.nodes.remove(key)
    }
}

/// Immutable snapshot of the context graph for projection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextGraphSnapshot {
    pub nodes: Vec<(String, ContextNode)>,
    pub captured_at: DateTime<Utc>,
}

impl ContextGraphSnapshot {
    /// Number of nodes in the snapshot.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Whether the snapshot is empty.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}
