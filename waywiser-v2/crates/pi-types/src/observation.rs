//! Observation model (§11).
//!
//! Environmental state is ephemeral by default. The pipeline is:
//! Observation → Working Context → Experience → Learning Gate → Possible Durable Memory/Procedure

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Retention classes for observations (§11).
/// Raw environmental observations default to Ephemeral.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RetentionClass {
    /// Discarded at end of processing cycle.
    Ephemeral,
    /// Lives until the session ends.
    Session,
    /// Persisted as durable experience; candidate for learning.
    Experience,
    /// Proposed for promotion to durable memory/procedure after validation.
    DurableCandidate,
}

/// Data sensitivity classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Sensitivity {
    Public,
    Internal,
    Personal,
    Sensitive,
}

/// How consent was obtained for an observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConsentScope {
    /// User explicitly granted access.
    Explicit,
    /// Derived from a broader grant.
    Implicit,
    /// System-level observation (battery, network).
    System,
}

/// What kind of observation this is.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ObservationKind {
    UserActivity,
    DeviceState,
    Notification,
    CalendarEvent,
    LocationContext,
    ScreenContent,
    CameraFrame,
    VoiceTranscript,
    AppState,
    SensorReading,
    UserInput,
    VisualCapture,
    Custom(String),
}

/// Where the observation came from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ObservationSource {
    Android,
    User,
    Agent,
    Capability,
    EdgeModel,
    Integration(String),
}

/// Core observation type (§11).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Observation {
    pub id: Uuid,
    pub kind: ObservationKind,
    pub subject: String,
    pub value: serde_json::Value,

    pub source: ObservationSource,
    pub source_id: Option<String>,

    /// 0.0–1.0 deterministic confidence ceiling.
    pub confidence: f32,

    pub observed_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,

    pub sensitivity: Sensitivity,
    pub retention: RetentionClass,
    pub consent_scope: Option<ConsentScope>,
}

impl Observation {
    /// Create a new observation with sensible defaults.
    pub fn new(kind: ObservationKind, subject: impl Into<String>, value: serde_json::Value) -> Self {
        Self {
            id: Uuid::now_v7(),
            kind,
            subject: subject.into(),
            value,
            source: ObservationSource::Android,
            source_id: None,
            confidence: 1.0,
            observed_at: Utc::now(),
            expires_at: None,
            sensitivity: Sensitivity::Internal,
            retention: RetentionClass::Ephemeral,
            consent_scope: None,
        }
    }
}
