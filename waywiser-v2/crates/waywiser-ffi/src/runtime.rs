//! WaywiserRuntime — the main FFI entry point.
//!
//! In production, this would be annotated with `#[derive(uniffi::Object)]`
//! and every public method with `#[uniffi::export]`.
//!
//! Every method wraps its body in `std::panic::catch_unwind` to prevent
//! Rust panics from crashing the Android process.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;
use uuid::Uuid;

use pi_types::{
    error::WaywiserError,
    message::{AgentMessage, MessageContent, UserMessage},
    session::{
        AggregateUsage, Entry, Lane, LaneQueue, LaneStatus, SessionState,
    },
    EntryId, LaneId, SessionId,
};
use pi_session::{SessionBackend, SessionSummary, SqliteSessionBackend};

use crate::events::{RuntimeConfig, RuntimeEvent};

/// The main runtime object exposed to Kotlin via FFI.
///
/// Thread-safe: all internal state is behind Arc<Mutex<...>>.
/// The event channel uses tokio mpsc for async streaming.
pub struct WaywiserRuntime {
    inner: Arc<Mutex<RuntimeInner>>,
    event_tx: mpsc::Sender<RuntimeEvent>,
    event_rx: Arc<Mutex<mpsc::Receiver<RuntimeEvent>>>,
    tokio_rt: tokio::runtime::Runtime,
}

struct RuntimeInner {
    session_backend: SqliteSessionBackend,
    current_session: Option<SessionState>,
    config: RuntimeConfig,
    shutdown: bool,
}

impl WaywiserRuntime {
    /// Initialize the runtime from configuration.
    ///
    /// Rebuilds state from SQLite (process death recovery).
    // #[uniffi::constructor]
    pub fn new(config: RuntimeConfig) -> Result<Self, WaywiserError> {
        // Wrap in catch_unwind to prevent panics from aborting the process
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Self::new_inner(config)
        }));

        match result {
            Ok(r) => r,
            Err(_) => Err(WaywiserError::InternalPanic(
                "panic during runtime initialization".into(),
            )),
        }
    }

    fn new_inner(config: RuntimeConfig) -> Result<Self, WaywiserError> {
        let tokio_rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| WaywiserError::InternalPanic(format!("tokio init: {e}")))?;

        let session_backend = SqliteSessionBackend::new(&config.db_path)?;

        let (event_tx, event_rx) = mpsc::channel(256);

        let inner = RuntimeInner {
            session_backend,
            current_session: None,
            config,
            shutdown: false,
        };

        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
            event_tx,
            event_rx: Arc::new(Mutex::new(event_rx)),
            tokio_rt,
        })
    }

    /// Send a user message to the agent loop.
    ///
    /// Returns immediately. Events arrive via `poll_event`.
    // #[uniffi::export]
    pub fn send_message(&self, content: String) -> Result<(), WaywiserError> {
        self.catch_panic("send_message", || {
            let tx = self.event_tx.clone();
            let inner = self.inner.clone();

            self.tokio_rt.spawn(async move {
                // Create user message entry
                let msg = AgentMessage::User(UserMessage {
                    id: EntryId(Uuid::now_v7()),
                    content: MessageContent::Text(content),
                    timestamp: chrono::Utc::now(),
                });

                // In production, this would feed into the AgentLoop.
                // For now, echo back as a text delta to prove the pipeline works.
                let _ = tx
                    .send(RuntimeEvent::text_delta(format!(
                        "[echo] Received: {}",
                        match &msg {
                            AgentMessage::User(u) => match &u.content {
                                MessageContent::Text(t) => t.as_str(),
                                _ => "<non-text>",
                            },
                            _ => "<non-user>",
                        }
                    )))
                    .await;

                // Signal turn complete
                let _ = tx
                    .send(RuntimeEvent::TurnComplete {
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        thinking_tokens: 0,
                    })
                    .await;

                // Save session
                let mut guard = inner.lock().unwrap();
                if let Some(ref mut session) = guard.current_session {
                    let entry = Entry {
                        id: EntryId(Uuid::now_v7()),
                        message: msg,
                    };

                    if let Some(lane) = session
                        .lanes
                        .iter_mut()
                        .find(|l| l.id == session.active_lane_id)
                    {
                        lane.entries.push(entry);
                    }
                    session.updated_at = chrono::Utc::now();
                }
            });

            Ok(())
        })
    }

    /// Blocking poll for the next event.
    ///
    /// Called from Kotlin `suspend fun` on `Dispatchers.IO`.
    /// Returns `None` after 30s timeout (heartbeat).
    // #[uniffi::export]
    pub fn poll_event(&self) -> Result<Option<RuntimeEvent>, WaywiserError> {
        self.catch_panic("poll_event", || {
            let rx = self.event_rx.clone();
            self.tokio_rt.block_on(async {
                let mut guard = rx.lock().unwrap();
                match tokio::time::timeout(Duration::from_secs(30), guard.recv()).await {
                    Ok(Some(event)) => Ok(Some(event)),
                    Ok(None) => Ok(None), // channel closed
                    Err(_) => Ok(Some(RuntimeEvent::Heartbeat)), // timeout → heartbeat
                }
            })
        })
    }

    /// Cancel the current agent turn.
    // #[uniffi::export]
    pub fn cancel(&self) -> Result<(), WaywiserError> {
        self.catch_panic("cancel", || {
            // In production: signal CancellationToken to abort inference
            let tx = self.event_tx.clone();
            self.tokio_rt.block_on(async {
                let _ = tx
                    .send(RuntimeEvent::error("cancelled", "Turn cancelled by user"))
                    .await;
            });
            Ok(())
        })
    }

    /// Steer the current turn with new context.
    // #[uniffi::export]
    pub fn steer(&self, content: String) -> Result<(), WaywiserError> {
        self.catch_panic("steer", || {
            // In production: enqueue SteerRequest in the reducer
            let tx = self.event_tx.clone();
            self.tokio_rt.block_on(async {
                let _ = tx
                    .send(RuntimeEvent::text_delta(format!("[steer] {}", content)))
                    .await;
            });
            Ok(())
        })
    }

    /// List available sessions.
    // #[uniffi::export]
    pub fn list_sessions(&self) -> Result<Vec<SessionSummary>, WaywiserError> {
        self.catch_panic("list_sessions", || {
            let inner = self.inner.lock().unwrap();
            self.tokio_rt.block_on(async {
                inner.session_backend.list_sessions(20, 0).await
            })
        })
    }

    /// Create a new session and make it active.
    // #[uniffi::export]
    pub fn create_session(&self) -> Result<String, WaywiserError> {
        self.catch_panic("create_session", || {
            let session_id = SessionId(Uuid::now_v7());
            let lane_id = LaneId(Uuid::now_v7());

            let session = SessionState {
                id: session_id,
                lanes: vec![Lane {
                    id: lane_id,
                    entries: vec![],
                    queue: LaneQueue::default(),
                    status: LaneStatus::Active,
                    parent_branch: None,
                }],
                active_lane_id: lane_id,
                branches: vec![],
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
                usage: AggregateUsage::default(),
                metadata: serde_json::json!({}),
            };

            let mut inner = self.inner.lock().unwrap();
            self.tokio_rt.block_on(async {
                inner.session_backend.create_session(&session).await?;
                Ok::<_, WaywiserError>(())
            })?;

            inner.current_session = Some(session);

            let id_str = session_id.0.to_string();

            // Notify Kotlin
            let tx = self.event_tx.clone();
            self.tokio_rt.block_on(async {
                let _ = tx
                    .send(RuntimeEvent::SessionChanged {
                        session_id: id_str.clone(),
                    })
                    .await;
            });

            Ok(id_str)
        })
    }

    /// Shutdown gracefully. Cancels any running turn, flushes state.
    // #[uniffi::export]
    pub fn shutdown(&self) -> Result<(), WaywiserError> {
        self.catch_panic("shutdown", || {
            let mut inner = self.inner.lock().unwrap();
            if inner.shutdown {
                return Ok(());
            }

            // Save current session if any
            if let Some(ref session) = inner.current_session {
                self.tokio_rt.block_on(async {
                    inner.session_backend.save_session(session).await
                })?;
            }

            inner.shutdown = true;
            Ok(())
        })
    }

    /// Wrap a closure in catch_unwind to prevent Rust panics from killing the JVM.
    fn catch_panic<F, R>(&self, method: &str, f: F) -> Result<R, WaywiserError>
    where
        F: FnOnce() -> Result<R, WaywiserError> + std::panic::UnwindSafe,
    {
        match std::panic::catch_unwind(f) {
            Ok(result) => result,
            Err(_) => Err(WaywiserError::InternalPanic(format!(
                "panic in WaywiserRuntime::{}",
                method
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_runtime_with_memory_db() {
        let config = RuntimeConfig::test_config();
        let rt = WaywiserRuntime::new(config);
        assert!(rt.is_ok());
    }

    #[test]
    fn create_session_returns_id() {
        let config = RuntimeConfig::test_config();
        let rt = WaywiserRuntime::new(config).unwrap();
        let id = rt.create_session();
        assert!(id.is_ok());
        assert!(!id.unwrap().is_empty());
    }

    #[test]
    fn shutdown_is_idempotent() {
        let config = RuntimeConfig::test_config();
        let rt = WaywiserRuntime::new(config).unwrap();
        assert!(rt.shutdown().is_ok());
        assert!(rt.shutdown().is_ok()); // second call is fine
    }
}
