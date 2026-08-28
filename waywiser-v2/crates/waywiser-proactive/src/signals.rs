//! Proactive signals: events that may trigger proactive reasoning.

use chrono::{DateTime, Utc};
use pi_types::WorkItemId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Unique identifier for a proactive signal.
pub type SignalId = Uuid;

/// Unique identifier for a notification.
pub type NotificationId = Uuid;

/// Unique identifier for a cron job.
pub type CronJobId = Uuid;

/// Unique identifier for an experience.
pub type ExperienceId = Uuid;

/// Unique identifier for an observation.
pub type ObservationId = Uuid;

/// A proactive signal that may trigger reasoning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProactiveSignal {
    pub id: SignalId,
    pub source: SignalSource,
    pub observation_id: ObservationId,
    /// Deterministic importance assessment: 0.0–1.0.
    pub assessed_importance: f32,
    pub created_at: DateTime<Utc>,
}

/// What generated this proactive signal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SignalSource {
    /// Two calendar events overlap.
    CalendarConflict {
        event_a: String,
        event_b: String,
        overlap_minutes: u32,
    },
    /// A work item's deadline is approaching.
    UpcomingDeadline {
        work_item: WorkItemId,
        due_in_minutes: u32,
    },
    /// An important notification was received.
    ImportantNotification(NotificationId),
    /// A scheduled reminder fired.
    ScheduledReminder(CronJobId),
    /// The Brain identified an insight during reflection.
    BrainInsight(ExperienceId),
}

impl ProactiveSignal {
    /// Create a new signal with a generated ID and current timestamp.
    pub fn new(source: SignalSource, observation_id: ObservationId, importance: f32) -> Self {
        Self {
            id: Uuid::now_v7(),
            source,
            observation_id,
            assessed_importance: importance.clamp(0.0, 1.0),
            created_at: Utc::now(),
        }
    }
}
