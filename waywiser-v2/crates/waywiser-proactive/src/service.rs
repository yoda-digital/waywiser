//! Proactive service: OODA loop (Observe, Orient, Decide, Act).

use chrono::{DateTime, Duration, Utc};
use pi_types::Observation;
use serde::{Deserialize, Serialize};
use crate::queue::{InferencePriority, ReasoningCause, ReasoningJob, ReasoningQueueManager};
use crate::relevance::RelevanceRule;
use crate::signals::{ObservationId, ProactiveSignal, SignalSource};

/// Configuration for the proactive engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProactiveConfig {
    /// Maximum proactive actions per hour. Default: 5.
    pub max_actions_per_hour: u32,
    /// Minimum signal importance to trigger. Default: 0.7.
    pub min_signal_confidence: f32,
    /// Default TTL for deferred jobs. Default: 4 hours.
    pub deferred_job_ttl: Duration,
}

impl Default for ProactiveConfig {
    fn default() -> Self {
        Self {
            max_actions_per_hour: 5,
            min_signal_confidence: 0.7,
            deferred_job_ttl: Duration::hours(4),
        }
    }
}

/// Result of the Orient phase.
#[derive(Debug, Clone)]
pub enum OrientResult {
    /// Signal is actionable — proceed to Decide.
    Actionable {
        signal: ProactiveSignal,
        urgency: Urgency,
    },
    /// Signal is low importance — drop.
    BelowThreshold {
        signal: ProactiveSignal,
        importance: f32,
    },
}

/// How urgent this proactive action is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    /// Notify user immediately.
    Immediate,
    /// Defer to reasoning queue.
    Deferred,
}

/// Decision from the Decide phase.
#[derive(Debug, Clone)]
pub enum ProactiveDecision {
    /// Create a deferred reasoning job.
    DeferReasoning {
        signal: ProactiveSignal,
        priority: InferencePriority,
    },
    /// Notify the user immediately (no reasoning needed).
    NotifyImmediately {
        signal: ProactiveSignal,
        message: String,
    },
    /// Rate-limited — too many actions this hour.
    RateLimited {
        signal: ProactiveSignal,
        actions_this_hour: u32,
    },
    /// Below threshold — drop.
    Drop,
}

/// Error from proactive operations.
#[derive(Debug, Clone)]
pub enum ProactiveError {
    QueueFull,
    InternalError(String),
}

impl std::fmt::Display for ProactiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::QueueFull => write!(f, "reasoning queue is full"),
            Self::InternalError(msg) => write!(f, "proactive error: {msg}"),
        }
    }
}

impl std::error::Error for ProactiveError {}

/// Proactive cognition engine implementing the OODA loop.
pub struct ProactiveService {
    pub signal_queue: Vec<ProactiveSignal>,
    pub config: ProactiveConfig,
    actions_this_hour: Vec<DateTime<Utc>>,
    pub queue_manager: ReasoningQueueManager,
}

impl ProactiveService {
    pub fn new(config: ProactiveConfig) -> Self {
        let ttl = config.deferred_job_ttl;
        Self {
            signal_queue: Vec::new(),
            config,
            actions_this_hour: Vec::new(),
            queue_manager: ReasoningQueueManager::new(ttl),
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(ProactiveConfig::default())
    }

    // ── OODA: Observe ──

    /// Observe: assess whether an observation generates a proactive signal.
    pub fn observe(&mut self, obs: &Observation) -> Option<ProactiveSignal> {
        let (source, importance) = self.assess_observation(obs)?;
        let signal = ProactiveSignal::new(source, ObservationId::from(obs.id), importance);
        self.signal_queue.push(signal.clone());
        Some(signal)
    }

    /// Assess an observation for proactive relevance.
    fn assess_observation(&self, obs: &Observation) -> Option<(SignalSource, f32)> {
        // Check for calendar-related observations
        if let Some(value) = obs.value.as_object() {
            if value.contains_key("conflict") {
                return Some((
                    SignalSource::CalendarConflict {
                        event_a: value
                            .get("event_a")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        event_b: value
                            .get("event_b")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        overlap_minutes: value
                            .get("overlap_minutes")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u32,
                    },
                    0.9,
                ));
            }

            if value.contains_key("deadline_minutes") {
                let minutes = value
                    .get("deadline_minutes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(60) as u32;
                let importance = if minutes < 15 {
                    0.95
                } else if minutes < 60 {
                    0.8
                } else {
                    0.6
                };
                return Some((
                    SignalSource::UpcomingDeadline {
                        work_item: pi_types::WorkItemId::new(),
                        due_in_minutes: minutes,
                    },
                    importance,
                ));
            }
        }

        // Default: not proactively relevant
        None
    }

    // ── OODA: Orient ──

    /// Orient: apply deterministic filters to a signal.
    pub fn orient(&self, signal: &ProactiveSignal) -> OrientResult {
        if signal.assessed_importance < self.config.min_signal_confidence {
            return OrientResult::BelowThreshold {
                signal: signal.clone(),
                importance: signal.assessed_importance,
            };
        }

        let urgency = match &signal.source {
            SignalSource::CalendarConflict { overlap_minutes, .. } if *overlap_minutes > 0 => {
                Urgency::Immediate
            }
            SignalSource::UpcomingDeadline { due_in_minutes, .. } if *due_in_minutes < 15 => {
                Urgency::Immediate
            }
            _ => Urgency::Deferred,
        };

        OrientResult::Actionable {
            signal: signal.clone(),
            urgency,
        }
    }

    // ── OODA: Decide ──

    /// Decide: determine what action to take, with rate limiting.
    pub fn decide(&self, oriented: &OrientResult) -> ProactiveDecision {
        match oriented {
            OrientResult::BelowThreshold { .. } => ProactiveDecision::Drop,
            OrientResult::Actionable { signal, urgency } => {
                // Rate limit check
                let actions_count = self.actions_in_last_hour();
                if actions_count >= self.config.max_actions_per_hour {
                    return ProactiveDecision::RateLimited {
                        signal: signal.clone(),
                        actions_this_hour: actions_count,
                    };
                }

                match urgency {
                    Urgency::Immediate => ProactiveDecision::NotifyImmediately {
                        signal: signal.clone(),
                        message: format_signal_message(signal),
                    },
                    Urgency::Deferred => ProactiveDecision::DeferReasoning {
                        signal: signal.clone(),
                        priority: InferencePriority::Reflection,
                    },
                }
            }
        }
    }

    // ── OODA: Act ──

    /// Act: execute the decision (create job or notification).
    pub fn act(&mut self, decision: ProactiveDecision) -> Result<(), ProactiveError> {
        match decision {
            ProactiveDecision::DeferReasoning { signal, priority } => {
                let job = ReasoningJob::new(
                    ReasoningCause::Signal(signal.source),
                    priority,
                    RelevanceRule::TimeWindow {
                        expires_at: Utc::now() + self.config.deferred_job_ttl,
                    },
                    None,
                );
                self.queue_manager.enqueue(job);
                self.record_action();
                Ok(())
            }
            ProactiveDecision::NotifyImmediately { .. } => {
                // In production, this would send to the notification system.
                self.record_action();
                Ok(())
            }
            ProactiveDecision::RateLimited { .. } => {
                // Drop — rate limited
                Ok(())
            }
            ProactiveDecision::Drop => {
                // Drop — below threshold
                Ok(())
            }
        }
    }

    /// Run the full OODA cycle for an observation.
    pub fn process_observation(&mut self, obs: &Observation) -> Option<ProactiveDecision> {
        let signal = self.observe(obs)?;
        let oriented = self.orient(&signal);
        let decision = self.decide(&oriented);
        let _ = self.act(decision.clone());
        Some(decision)
    }

    /// Count actions in the last hour.
    fn actions_in_last_hour(&self) -> u32 {
        let one_hour_ago = Utc::now() - Duration::hours(1);
        self.actions_this_hour
            .iter()
            .filter(|t| **t > one_hour_ago)
            .count() as u32
    }

    /// Record that an action was taken.
    fn record_action(&mut self) {
        let now = Utc::now();
        self.actions_this_hour.push(now);
        // Cleanup old entries
        let one_hour_ago = now - Duration::hours(1);
        self.actions_this_hour.retain(|t| *t > one_hour_ago);
    }

    /// Process deferred jobs (called during idle time).
    pub fn process_deferred(&mut self) -> Vec<ReasoningJob> {
        let mut ready = Vec::new();
        while let Some(job) = self.queue_manager.next_ready() {
            ready.push(job);
        }
        ready
    }
}

/// Format a human-readable message for a signal.
fn format_signal_message(signal: &ProactiveSignal) -> String {
    match &signal.source {
        SignalSource::CalendarConflict {
            event_a,
            event_b,
            overlap_minutes,
        } => {
            format!("Calendar conflict: '{event_a}' and '{event_b}' overlap by {overlap_minutes} minutes")
        }
        SignalSource::UpcomingDeadline {
            due_in_minutes, ..
        } => {
            format!("Deadline approaching in {due_in_minutes} minutes")
        }
        SignalSource::ImportantNotification(_) => "Important notification received".to_string(),
        SignalSource::ScheduledReminder(_) => "Scheduled reminder".to_string(),
        SignalSource::BrainInsight(_) => "Brain insight identified".to_string(),
    }
}
