//! FFI bridge: the top-level entry point Kotlin calls via UniFFI.
//!
//! `WaywiserRuntime` is the main object. It owns the kernel, session backend,
//! inference backend, and event channel. Every public method wraps in
//! `std::panic::catch_unwind` to prevent Rust panics from aborting the
//! Android process.
//!
//! In production, this crate would use `uniffi::export` attributes.
//! For now, the logic is implemented without the UniFFI codegen dependency.

pub mod events;
pub mod runtime;

pub use events::{RuntimeConfig, RuntimeEvent};
pub use runtime::WaywiserRuntime;
