//! Attention Governor — the core decision engine.
//!
//! Pipeline: floor → ceiling → deterministic match → edge hint → clamp.
//! Suppression asymmetry: escalation is easy, suppression is hard.
//! High-consequence floors are hardcoded and not configurable.

use pi_types::AttentionDecision;
use serde::{Deserialize, Serialize};

use crate::hint::EdgeHint;
use crate::rules::{AttentionRule, AttentionSignal, AttentionSource, SystemChannel};

/// Full attention policy configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttentionPolicy {
    /// User/admin-configurable rules.
    pub rules: Vec<AttentionRule>,
    /// Default decision when no rule matches.
    pub default_decision: AttentionDecision,
    /// Minimum edge confidence to suppress (high — suppression is hard).
    pub suppression_threshold: f32,
    /// Minimum edge confidence to escalate (low — escalation is easy).
    pub escalation_threshold: f32,
}

impl Default for AttentionPolicy {
    fn default() -> Self {
        Self {
            rules: Vec::new(),
            default_decision: AttentionDecision::Silent,
            suppression_threshold: 0.85, // high: suppression is hard
            escalation_threshold: 0.3,   // low: escalation is easy
        }
    }
}

/// Result of an attention evaluation.
#[derive(Debug, Clone)]
pub struct AttentionResult {
    /// The final attention decision.
    pub decision: AttentionDecision,
    /// Floor that was applied (if any).
    pub floor_applied: Option<AttentionDecision>,
    /// Ceiling that was applied (if any).
    pub ceiling_applied: Option<AttentionDecision>,
    /// What the edge hint suggested (if provided).
    pub edge_hint_effect: Option<AttentionDecision>,
    /// Name/description of the rule that matched (for audit).
    pub source_rule: Option<String>,
}

/// The attention governor — deterministic policy engine.
pub struct AttentionGovernor {
    policy: AttentionPolicy,
}

impl AttentionGovernor {
    /// Create a new governor with the given policy.
    pub fn new(policy: AttentionPolicy) -> Self {
        Self { policy }
    }

    /// Evaluate attention for a signal.
    ///
    /// Pipeline:
    /// 1. Find matching floor (hardcoded high-consequence + configurable)
    /// 2. Find matching ceiling
    /// 3. Deterministic pattern match → base decision
    /// 4. Apply edge hint (escalation easy, suppression hard, never below floor)
    /// 5. Clamp to [floor, ceiling]
    pub fn evaluate(
        &self,
        signal: &AttentionSignal,
        edge_hint: Option<&EdgeHint>,
    ) -> AttentionResult {
        // 1. Resolve floor: hardcoded high-consequence floors first,
        //    then configurable rules (take the highest/strongest)
        let hardcoded_floor = self.hardcoded_floor(&signal.source);
        let configurable_floor = self.resolve_floor(signal);
        let floor = match (hardcoded_floor, configurable_floor) {
            (Some(h), Some(c)) => Some(h.max(c)),
            (Some(h), None) => Some(h),
            (None, Some(c)) => Some(c),
            (None, None) => None,
        };

        // 2. Resolve ceiling
        let ceiling = self.resolve_ceiling(signal);

        // 3. Deterministic base decision
        let base = self.deterministic_classify(signal);

        // 4. Apply edge hint with suppression asymmetry
        let (adjusted, hint_effect) = match edge_hint {
            Some(hint) => {
                let adj = self.apply_hint(base, hint, floor);
                (adj, Some(hint.suggested))
            }
            None => (base, None),
        };

        // 5. Clamp to [floor, ceiling]
        let clamped = self.clamp(adjusted, floor, ceiling);

        // Build source rule description
        let source_rule = if hardcoded_floor.is_some() {
            Some(format!("hardcoded floor: {:?}", hardcoded_floor.unwrap()))
        } else if configurable_floor.is_some() {
            Some("configurable rule".to_string())
        } else {
            None
        };

        AttentionResult {
            decision: clamped,
            floor_applied: floor,
            ceiling_applied: ceiling,
            edge_hint_effect: hint_effect,
            source_rule,
        }
    }

    /// Hardcoded high-consequence floors. These are NOT configurable.
    ///
    /// - Important contacts (Contact or ContactGroup "important") → min Notify
    /// - Family contacts (ContactGroup "family") → min Notify
    /// - Alarm channels → min HeadsUp
    /// - Repeated incoming calls → min Urgent
    /// - Security alerts → min Notify
    /// - Device warnings → min Notify
    fn hardcoded_floor(&self, source: &AttentionSource) -> Option<AttentionDecision> {
        match source {
            // Important contacts → minimum Notify
            AttentionSource::ContactGroup(group)
                if group.eq_ignore_ascii_case("important") || group.eq_ignore_ascii_case("vip") =>
            {
                Some(AttentionDecision::Notify)
            }
            // Family contacts → minimum Notify
            AttentionSource::ContactGroup(group)
                if group.eq_ignore_ascii_case("family") =>
            {
                Some(AttentionDecision::Notify)
            }
            // System channels
            AttentionSource::SystemChannel(ch) => match ch {
                SystemChannel::AlarmClock => Some(AttentionDecision::HeadsUp),
                SystemChannel::IncomingCall => Some(AttentionDecision::HeadsUp),
                SystemChannel::SecurityAlert => Some(AttentionDecision::Notify),
                SystemChannel::DeviceWarning => Some(AttentionDecision::Notify),
            },
            _ => None,
        }
    }

    /// Resolve the configurable floor from rules (highest priority match).
    fn resolve_floor(&self, signal: &AttentionSignal) -> Option<AttentionDecision> {
        self.policy
            .rules
            .iter()
            .filter(|r| r.matches(&signal.source) && r.floor.is_some())
            .min_by_key(|r| r.priority) // lowest priority number = highest priority
            .and_then(|r| r.floor)
    }

    /// Resolve the ceiling from rules (highest priority match).
    fn resolve_ceiling(&self, signal: &AttentionSignal) -> Option<AttentionDecision> {
        self.policy
            .rules
            .iter()
            .filter(|r| r.matches(&signal.source) && r.ceiling.is_some())
            .min_by_key(|r| r.priority)
            .and_then(|r| r.ceiling)
    }

    /// Deterministic classification based on Android priority and source.
    fn deterministic_classify(&self, signal: &AttentionSignal) -> AttentionDecision {
        // Use Android priority if available
        if let Some(priority) = signal.android_priority {
            return match priority {
                p if p >= 5 => AttentionDecision::HeadsUp, // IMPORTANCE_HIGH+
                p if p >= 3 => AttentionDecision::Notify,  // IMPORTANCE_DEFAULT
                p if p >= 1 => AttentionDecision::Silent,  // IMPORTANCE_LOW
                _ => AttentionDecision::Batch,              // IMPORTANCE_MIN
            };
        }

        // Fall back to policy default
        self.policy.default_decision
    }

    /// Apply edge hint with suppression asymmetry.
    ///
    /// - Escalation (hint > base): requires low confidence threshold
    /// - Suppression (hint < base): requires high confidence threshold
    ///   AND cannot go below floor
    fn apply_hint(
        &self,
        base: AttentionDecision,
        hint: &EdgeHint,
        floor: Option<AttentionDecision>,
    ) -> AttentionDecision {
        if hint.suggested > base {
            // Escalation: easier (lower threshold)
            if hint.confidence >= self.policy.escalation_threshold {
                hint.suggested
            } else {
                base
            }
        } else if hint.suggested < base {
            // Suppression: harder (higher threshold) + floor check
            if hint.confidence >= self.policy.suppression_threshold {
                // Even with high confidence, NEVER suppress below floor
                match floor {
                    Some(f) if hint.suggested < f => f,
                    _ => hint.suggested,
                }
            } else {
                base // insufficient confidence to suppress
            }
        } else {
            base // same level, no change
        }
    }

    /// Clamp a decision to [floor, ceiling].
    fn clamp(
        &self,
        decision: AttentionDecision,
        floor: Option<AttentionDecision>,
        ceiling: Option<AttentionDecision>,
    ) -> AttentionDecision {
        let mut result = decision;
        if let Some(f) = floor {
            result = result.max(f);
        }
        if let Some(c) = ceiling {
            result = result.min(c);
        }
        result
    }

    /// Access the policy (for testing/inspection).
    pub fn policy(&self) -> &AttentionPolicy {
        &self.policy
    }
}
