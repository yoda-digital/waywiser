//! Waywiser Security Kernel — the most critical component in the system.
//!
//! Implements blueprint invariant I2: "LLMs may propose protected state
//! transitions. They do not authorize them."

pub mod audit;
pub mod kernel;
pub mod leases;
pub mod pipeline;
pub mod risk;
pub mod toctou;
pub mod verification;

pub use audit::AuditEntry;
pub use kernel::{ApprovalKind, AuthorizationSource, DenialReason, SecurityDecision, SecurityKernel};
pub use leases::{
    ApprovalLease, GrantSource, LeaseConstraints, LeaseDecision, LeaseReason, LeaseScope,
    LeaseUseRecord,
};
pub use pipeline::{ActionPipeline, PipelineStage, RecoveryAction};
pub use risk::{
    AutomationPolicy, ClassificationLayer, ClassificationRequest, ClassificationResult,
    LayerDecision, LlmRiskHint, PackagePolicy, PrimitiveActionKind, RiskClassifier, SemanticRule,
};
pub use toctou::{FingerprintMatch, FingerprintMismatch, NodeFingerprint, TocTouError};
pub use verification::{ExpectedTransition, IndicatorKind, TransitionIndicator};
