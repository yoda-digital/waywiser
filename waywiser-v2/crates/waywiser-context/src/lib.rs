//! Waywiser Context Graph — structured ephemeral working memory of device state.
//!
//! Android callbacks enter an observation bus; deterministic reducers update
//! typed graph nodes. The graph is primarily working memory, NOT permanent history.
//! Blueprint §§12–13.

pub mod domains;
pub mod graph;
pub mod bus;
pub mod decay;
pub mod projection;

pub use domains::*;
pub use graph::{ContextGraph, ContextGraphSnapshot, ContextNode};
pub use bus::{DeterministicReducer, ObservationBus};
pub use decay::DecayConfig;
pub use projection::{ContextProjection, ProjectedEntry, ProjectionEngine, TaskType};
