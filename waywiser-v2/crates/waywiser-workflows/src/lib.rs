//! Cross-app workflows: multi-step action sequences with verification and rollback.
//!
//! Workflows execute steps sequentially, verifying each outcome.
//! On `Unexpected` verification → halt. Reversible steps can be rolled back.

pub mod workflow;
pub mod executor;
pub mod rollback;

pub use workflow::*;
pub use executor::*;
pub use rollback::*;
