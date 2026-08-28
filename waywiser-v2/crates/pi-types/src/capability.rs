//! Capability model (§16).
//!
//! A capability is a system primitive, not merely an LLM tool.
//! Every protected capability declares a CapabilitySpec.
//! Unknown capabilities do not execute.

use serde::{Deserialize, Serialize};

use crate::action::ReplayPolicy;
use crate::ids::CapabilityName;
use crate::observation::Sensitivity;

/// Deterministic risk levels (§23).
/// Risk may only stay the same or increase as uncertainty grows.
/// The ordering is significant: PartialOrd/Ord derives ensure
/// ReadPersonal < DeviceControl < ... < UiUnclassifiedWrite.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum RiskLevel {
    /// No risk — informational only.
    None,
    /// Reading personal data.
    ReadPersonal,
    /// Controlling device state (open app, click, toggle).
    DeviceControl,
    /// Writing across app boundaries (type text, paste, save, submit).
    CrossAppWrite,
    /// Sending communication (send, reply, publish, post).
    Communication,
    /// Financial operations (pay, purchase, transfer).
    Financial,
    /// Destructive operations (delete, remove, erase).
    Destructive,
    /// Unknown UI write — default: ASK_USER or block.
    UiUnclassifiedWrite,
}

impl RiskLevel {
    /// Whether this risk level requires user approval by default.
    pub fn requires_user_approval(&self) -> bool {
        matches!(
            self,
            RiskLevel::DeviceControl
                | RiskLevel::CrossAppWrite
                | RiskLevel::Communication
                | RiskLevel::Financial
                | RiskLevel::Destructive
                | RiskLevel::UiUnclassifiedWrite
        )
    }
}

/// How a capability is executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExecutionMode {
    /// Runs in the agent's own Rust context.
    InProcess,
    /// Delegates to Android platform via FFI.
    AndroidPlatform,
    /// Calls a remote service.
    Remote,
    /// UI automation via AccessibilityService.
    UiAutomation,
}

/// Every protected capability declares this spec (§16).
/// Unknown capabilities do not execute.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilitySpec {
    pub name: CapabilityName,
    pub description: String,

    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,

    pub risk: RiskLevel,
    pub permissions: Vec<String>,

    pub side_effect: bool,
    pub replay_policy: ReplayPolicy,
    pub execution_mode: ExecutionMode,

    pub reversible: bool,
    pub dry_run_support: bool,
    pub sensitivity: Sensitivity,

    /// Required Android runtime permission, if any.
    pub os_permission: Option<String>,
}
