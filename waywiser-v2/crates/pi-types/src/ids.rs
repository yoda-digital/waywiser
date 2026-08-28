//! Core identity types — all durable entity IDs are UUIDv7 (§69).
//!
//! Globally unique, sortable by creation time.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! define_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub struct $name(pub Uuid);

        impl $name {
            /// Create a new ID using UUIDv7 (time-sortable).
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            /// Create from an existing UUID (for deserialization / tests).
            pub fn from_uuid(id: Uuid) -> Self {
                Self(id)
            }

            /// Return the inner UUID.
            pub fn as_uuid(&self) -> &Uuid {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }
    };
}

define_id!(
    /// Identifies an agent session.
    SessionId
);

define_id!(
    /// Identifies a lane within a session.
    LaneId
);

define_id!(
    /// Identifies an entry within a lane.
    EntryId
);

define_id!(
    /// Identifies a user goal.
    GoalId
);

define_id!(
    /// Identifies a work item within the work graph.
    WorkItemId
);

define_id!(
    /// Identifies a device in the fleet.
    DeviceId
);

define_id!(
    /// Identifies an agent (primary or delegated).
    AgentId
);

/// Named capability identifier (e.g. "calendar.read", "device.battery_status").
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CapabilityName(pub String);

impl CapabilityName {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for CapabilityName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<&str> for CapabilityName {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}
