//! SessionBackend trait — the storage contract for session persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use pi_types::{
    Entry, EntryId, LaneId, LaneQueue, SessionId, SessionState, WaywiserError,
};
use uuid::Uuid;

/// Summary of a session for listing (without full state).
#[derive(Debug, Clone)]
pub struct SessionSummary {
    pub id: SessionId,
    pub turn_count: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Mutation metadata for future sync support (§69).
#[derive(Debug, Clone)]
pub struct MutationMeta {
    pub mutation_id: Uuid,
    pub device_id: pi_types::DeviceId,
    pub local_sequence: u64,
    pub wall_clock: DateTime<Utc>,
}

/// Durable session storage contract.
///
/// Implementations must be Send + Sync for use across async tasks.
/// All write operations should be atomic (single transaction).
#[async_trait]
pub trait SessionBackend: Send + Sync {
    /// Create a new session. Fails if session ID already exists.
    async fn create_session(&self, session: &SessionState) -> Result<(), WaywiserError>;

    /// Load a session by ID. Returns None if not found.
    async fn load_session(&self, id: SessionId) -> Result<Option<SessionState>, WaywiserError>;

    /// Save (overwrite) an existing session's state.
    async fn save_session(&self, session: &SessionState) -> Result<(), WaywiserError>;

    /// Delete a session by ID. Returns true if it existed.
    async fn delete_session(&self, id: SessionId) -> Result<bool, WaywiserError>;

    /// List session summaries with pagination.
    async fn list_sessions(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<SessionSummary>, WaywiserError>;

    /// Append an entry to a lane within a session.
    /// The implementation should load the session, find the lane, push the entry,
    /// and save — all in one transaction.
    async fn append_entry(
        &self,
        session_id: SessionId,
        lane_id: LaneId,
        entry: &Entry,
    ) -> Result<(), WaywiserError>;

    /// Update a lane's work queue.
    async fn update_lane_queue(
        &self,
        session_id: SessionId,
        lane_id: LaneId,
        queue: &LaneQueue,
    ) -> Result<(), WaywiserError>;

    /// Append an operation record (stored as opaque JSON with a type tag).
    async fn append_record(
        &self,
        session_id: SessionId,
        record_type: &str,
        data: &serde_json::Value,
    ) -> Result<(), WaywiserError>;

    /// Load all operation records for a session.
    async fn load_records(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<StoredRecord>, WaywiserError>;

    /// Remove entries from a lane (compaction).
    async fn remove_entries(
        &self,
        session_id: SessionId,
        lane_id: LaneId,
        ids: &[EntryId],
    ) -> Result<(), WaywiserError>;

    /// Record a mutation for future sync support (§69).
    async fn record_mutation(&self, meta: MutationMeta) -> Result<(), WaywiserError>;
}

/// An operation record as stored — opaque JSON with metadata.
#[derive(Debug, Clone)]
pub struct StoredRecord {
    pub id: i64,
    pub session_id: SessionId,
    pub record_type: String,
    pub data: serde_json::Value,
    pub timestamp: DateTime<Utc>,
}
