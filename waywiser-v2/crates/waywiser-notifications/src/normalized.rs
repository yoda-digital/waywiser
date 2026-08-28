//! Normalized notification data extracted from Android StatusBarNotification.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Unique notification ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NotificationId(pub Uuid);

/// Unique contact ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ContactId(pub Uuid);

/// Normalized notification extracted from Android StatusBarNotification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedNotification {
    pub id: NotificationId,
    pub app_package: String,
    pub channel_id: Option<String>,
    pub title: String,
    pub text: String,
    pub big_text: Option<String>,
    pub person: Option<PersonRef>,
    pub actions: Vec<NotificationAction>,
    pub priority: AndroidPriority,
    pub category: Option<String>,
    pub posted_at: DateTime<Utc>,
    pub is_group_summary: bool,
    pub conversation_id: Option<String>,
}

/// Reference to a person associated with a notification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonRef {
    pub contact_id: Option<ContactId>,
    pub name: Option<String>,
    pub uri: Option<String>,
}

/// An action attached to a notification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationAction {
    pub title: String,
    pub has_remote_input: bool,
}

/// Android notification priority/importance level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum AndroidPriority {
    Min,
    Low,
    Default,
    High,
    Max,
}
