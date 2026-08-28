//! Waywiser Notification Intelligence — deterministic classification.
//!
//! Classifies incoming notifications using deterministic rules only.
//! No LLM involvement in the classification pipeline.
//! Maps notifications to AttentionDecision levels.

pub mod normalized;
pub mod classifier;
pub mod policy;
pub mod rules;

pub use normalized::{NormalizedNotification, PersonRef, NotificationAction, AndroidPriority};
pub use classifier::{NotificationClassifier, DeterministicClassifier, ClassificationResult};
pub use policy::NotificationPolicy;
pub use rules::ClassificationRule;
