//! Durable session storage for the Pi agent runtime.
//!
//! Defines the `SessionBackend` trait and provides a SQLite implementation.
//! Operation records are stored as opaque JSON values to avoid coupling
//! to pi-core's concrete OperationRecord enum.

pub mod backend;
pub mod migrations;
pub mod sqlite;

pub use backend::{MutationMeta, SessionBackend, SessionSummary};
pub use sqlite::SqliteSessionBackend;
