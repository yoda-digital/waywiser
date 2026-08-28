//! Waywiser Attention Governor — decides whether information should affect user attention.
//!
//! Deterministic policy engine informed by observations and optional edge model hints.
//! Neural hints may escalate but CANNOT suppress below deterministic floors.
//! Blueprint §§14–14.3.

pub mod rules;
pub mod hint;
pub mod governor;

pub use rules::{AttentionRule, AttentionSignal, AttentionSource, SystemChannel};
pub use hint::EdgeHint;
pub use governor::{AttentionGovernor, AttentionPolicy, AttentionResult};
