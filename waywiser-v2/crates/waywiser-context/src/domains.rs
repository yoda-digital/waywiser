//! Context domain types — UserContext, DeviceContext, EnvironmentContext.
//!
//! These represent the structured working memory of the device state.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ── User domain ──

/// Physical activity state of the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActivityState {
    Walking,
    Driving,
    Stationary,
    Running,
    Unknown,
}

/// Audio output route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioRoute {
    Speaker,
    Headphones,
    Bluetooth,
    None,
}

/// Approximate place classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlaceContext {
    Home,
    Office,
    Commute,
    Unknown,
}

/// User's current attention state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttentionState {
    Idle,
    Focused,
    DoNotDisturb,
}

/// An upcoming calendar event or deadline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpcomingEvent {
    pub title: String,
    pub start: DateTime<Utc>,
    /// Minutes until the event starts (computed at snapshot time).
    pub minutes_until: i64,
}

/// User context node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContext {
    pub activity: Option<ActivityState>,
    pub audio_route: Option<AudioRoute>,
    pub place_context: Option<PlaceContext>,
    pub next_event: Option<UpcomingEvent>,
    pub attention_state: Option<AttentionState>,
}

impl UserContext {
    pub fn empty() -> Self {
        Self {
            activity: None,
            audio_route: None,
            place_context: None,
            next_event: None,
            attention_state: None,
        }
    }
}

// ── Device domain ──

/// Network connectivity state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NetworkState {
    Wifi,
    Cellular,
    Offline,
}

/// Device thermal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThermalState {
    Nominal,
    Elevated,
    Throttling,
    Critical,
}

/// Screen state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScreenState {
    On,
    Off,
    Locked,
}

/// Device context node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceContext {
    pub battery_pct: u8,
    pub charging: bool,
    pub network: NetworkState,
    pub thermal: ThermalState,
    pub screen: ScreenState,
}

impl DeviceContext {
    pub fn default_state() -> Self {
        Self {
            battery_pct: 100,
            charging: false,
            network: NetworkState::Wifi,
            thermal: ThermalState::Nominal,
            screen: ScreenState::On,
        }
    }
}

// ── Environment domain ──

/// Time of day classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimeOfDay {
    Morning,
    Afternoon,
    Evening,
    Night,
}

/// Ambient noise level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoiseLevel {
    Quiet,
    Moderate,
    Loud,
}

/// Basic weather summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherSummary {
    pub condition: String,
    pub temperature_c: f32,
}

/// Environment context node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentContext {
    pub time_of_day: TimeOfDay,
    pub ambient_noise: Option<NoiseLevel>,
    pub weather: Option<WeatherSummary>,
}

impl EnvironmentContext {
    pub fn empty() -> Self {
        Self {
            time_of_day: TimeOfDay::Morning,
            ambient_noise: None,
            weather: None,
        }
    }
}

// ── Domain wrapper ──

/// Typed wrapper for all context domains.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ContextDomain {
    User(UserContext),
    Device(DeviceContext),
    Environment(EnvironmentContext),
}

impl ContextDomain {
    /// Human-readable summary for context projection.
    pub fn summarize(&self) -> String {
        match self {
            ContextDomain::User(u) => {
                let mut parts = Vec::new();
                if let Some(act) = &u.activity {
                    parts.push(format!("activity={act:?}"));
                }
                if let Some(route) = &u.audio_route {
                    parts.push(format!("audio={route:?}"));
                }
                if let Some(place) = &u.place_context {
                    parts.push(format!("place={place:?}"));
                }
                if let Some(evt) = &u.next_event {
                    parts.push(format!("next_event=\"{}\" in {}min", evt.title, evt.minutes_until));
                }
                if let Some(att) = &u.attention_state {
                    parts.push(format!("attention={att:?}"));
                }
                if parts.is_empty() {
                    "User: no context".to_string()
                } else {
                    format!("User: {}", parts.join(", "))
                }
            }
            ContextDomain::Device(d) => {
                format!(
                    "Device: battery={}%{}, network={:?}, thermal={:?}, screen={:?}",
                    d.battery_pct,
                    if d.charging { " (charging)" } else { "" },
                    d.network,
                    d.thermal,
                    d.screen,
                )
            }
            ContextDomain::Environment(e) => {
                let mut parts = vec![format!("time={:?}", e.time_of_day)];
                if let Some(noise) = &e.ambient_noise {
                    parts.push(format!("noise={noise:?}"));
                }
                if let Some(weather) = &e.weather {
                    parts.push(format!("weather={}°C {}", weather.temperature_c, weather.condition));
                }
                format!("Environment: {}", parts.join(", "))
            }
        }
    }
}
