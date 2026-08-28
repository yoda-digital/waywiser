//! Accessibility automation types, tree quality assessment, and reviewed automation profiles.
//!
//! Provides the A11y node model, tree quality assessment, and versioned
//! automation profiles for reviewed apps.

pub mod a11y;
pub mod profiles;

pub use a11y::{
    A11yNode, Rect, SecureWindowState, TreeQuality, TreeSnapshot,
    assess_tree_quality, count_nodes, count_with,
};
pub use profiles::{AutomationProfile, NodeProfile, ProfileRegistry};
