//! Reasoning queue: durable deferred reasoning jobs with coalescing and relevance checks.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::relevance::RelevanceRule;
use crate::signals::SignalSource;

/// Unique identifier for a reasoning job.
pub type JobId = Uuid;

/// Priority for inference scheduling. Lower = higher priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum InferencePriority {
    /// P0: interactive user request.
    Interactive = 0,
    /// P1: explicit foreground work.
    Foreground = 1,
    /// P2: delegated work.
    Delegated = 2,
    /// P3: Brain reflection.
    Reflection = 3,
    /// P4: evolution/evals.
    Evolution = 4,
}

/// A deferred reasoning job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningJob {
    pub id: JobId,
    pub cause: ReasoningCause,
    pub created_at: DateTime<Utc>,
    pub priority: InferencePriority,
    pub context_refs: Vec<ContextRef>,
    pub relevance_rule: RelevanceRule,
    pub status: ReasoningJobStatus,
    pub attempts: u32,
    pub last_attempt_at: Option<DateTime<Utc>>,
    /// Jobs with the same coalesce key are merged.
    pub coalesce_key: Option<String>,
}

/// What caused the reasoning job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ReasoningCause {
    Signal(SignalSource),
    BrainReflection { experience_id: Uuid },
    Consolidation,
    SkillCompilation { procedure_id: Uuid },
    UserDeferred { query: String },
}

/// Reference to context needed for the job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextRef {
    pub kind: String,
    pub reference: String,
}

/// Status of a reasoning job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ReasoningJobStatus {
    Pending,
    Executing,
    Completed { result: serde_json::Value },
    Expired { reason: String },
    Failed { error: String, retryable: bool },
}

impl ReasoningJob {
    /// Create a new pending reasoning job.
    pub fn new(
        cause: ReasoningCause,
        priority: InferencePriority,
        relevance_rule: RelevanceRule,
        coalesce_key: Option<String>,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            cause,
            created_at: Utc::now(),
            priority,
            context_refs: Vec::new(),
            relevance_rule,
            status: ReasoningJobStatus::Pending,
            attempts: 0,
            last_attempt_at: None,
            coalesce_key,
        }
    }

    /// Whether this job is still pending (not terminal).
    pub fn is_pending(&self) -> bool {
        matches!(self.status, ReasoningJobStatus::Pending)
    }

    /// Whether this job is in a terminal state.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            ReasoningJobStatus::Completed { .. }
                | ReasoningJobStatus::Expired { .. }
                | ReasoningJobStatus::Failed { retryable: false, .. }
        )
    }
}

/// Manages the deferred reasoning queue with coalescing and relevance checks.
pub struct ReasoningQueueManager {
    jobs: Vec<ReasoningJob>,
    /// Default time-to-live for jobs without an explicit relevance rule.
    default_ttl: Duration,
}

impl ReasoningQueueManager {
    pub fn new(default_ttl: Duration) -> Self {
        Self {
            jobs: Vec::new(),
            default_ttl,
        }
    }

    /// Default: 4-hour TTL.
    pub fn with_default_ttl() -> Self {
        Self::new(Duration::hours(4))
    }

    /// Enqueue a new job. Coalesces with existing job if same coalesce_key.
    pub fn enqueue(&mut self, job: ReasoningJob) -> Uuid {
        // Check for coalescing
        if let Some(key) = &job.coalesce_key {
            if let Some(existing) = self
                .jobs
                .iter_mut()
                .find(|j| j.is_pending() && j.coalesce_key.as_deref() == Some(key))
            {
                // Merge context refs into existing job
                existing.context_refs.extend(job.context_refs);
                // Upgrade priority if the new job is higher priority
                if job.priority < existing.priority {
                    existing.priority = job.priority;
                }
                return existing.id;
            }
        }

        let id = job.id;
        self.jobs.push(job);
        id
    }

    /// Get the next ready job by priority. Checks relevance before returning.
    /// Expired jobs are auto-expired.
    pub fn next_ready(&mut self) -> Option<ReasoningJob> {
        let now = Utc::now();

        // Sort pending jobs by priority
        let mut pending_indices: Vec<usize> = self
            .jobs
            .iter()
            .enumerate()
            .filter(|(_, j)| j.is_pending())
            .map(|(i, _)| i)
            .collect();

        pending_indices.sort_by_key(|&i| self.jobs[i].priority);

        for idx in pending_indices {
            if self.jobs[idx].relevance_rule.is_relevant(now) {
                // Clone and return, marking as executing
                self.jobs[idx].status = ReasoningJobStatus::Executing;
                self.jobs[idx].attempts += 1;
                self.jobs[idx].last_attempt_at = Some(now);
                return Some(self.jobs[idx].clone());
            } else {
                // Auto-expire irrelevant jobs
                self.jobs[idx].status = ReasoningJobStatus::Expired {
                    reason: "relevance check failed".to_string(),
                };
            }
        }

        None
    }

    /// Mark a job as completed.
    pub fn mark_completed(&mut self, id: Uuid, result: serde_json::Value) {
        if let Some(job) = self.jobs.iter_mut().find(|j| j.id == id) {
            job.status = ReasoningJobStatus::Completed { result };
        }
    }

    /// Mark a job as expired.
    pub fn mark_expired(&mut self, id: Uuid, reason: &str) {
        if let Some(job) = self.jobs.iter_mut().find(|j| j.id == id) {
            job.status = ReasoningJobStatus::Expired {
                reason: reason.to_string(),
            };
        }
    }

    /// Mark a job as failed.
    pub fn mark_failed(&mut self, id: Uuid, error: &str, retryable: bool) {
        if let Some(job) = self.jobs.iter_mut().find(|j| j.id == id) {
            if retryable {
                // Reset to pending for retry
                job.status = ReasoningJobStatus::Pending;
            } else {
                job.status = ReasoningJobStatus::Failed {
                    error: error.to_string(),
                    retryable: false,
                };
            }
        }
    }

    /// Expire all jobs that have exceeded the default TTL.
    pub fn expire_stale(&mut self, now: DateTime<Utc>) -> usize {
        let mut count = 0;
        for job in &mut self.jobs {
            if job.is_pending() && (now - job.created_at) > self.default_ttl {
                job.status = ReasoningJobStatus::Expired {
                    reason: "exceeded default TTL".to_string(),
                };
                count += 1;
            }
        }
        count
    }

    /// Get the count of pending jobs.
    pub fn pending_count(&self) -> usize {
        self.jobs.iter().filter(|j| j.is_pending()).count()
    }

    /// Get the total count of all jobs (including terminal).
    pub fn total_count(&self) -> usize {
        self.jobs.len()
    }

    /// Remove all terminal jobs (cleanup).
    pub fn cleanup_terminal(&mut self) -> usize {
        let before = self.jobs.len();
        self.jobs.retain(|j| !j.is_terminal());
        before - self.jobs.len()
    }

    /// Get a job by ID.
    pub fn get(&self, id: Uuid) -> Option<&ReasoningJob> {
        self.jobs.iter().find(|j| j.id == id)
    }
}
