//! Compaction engine — strategy for reducing context size while preserving semantics (§7.1).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use pi_types::{Entry, EntryId, Lane, LaneId, WaywiserError};

/// Budget constraints for compaction.
#[derive(Debug, Clone)]
pub struct CompactionBudget {
    /// Maximum entries to retain after compaction.
    pub max_entries: usize,
    /// Maximum tokens in the context window.
    pub max_tokens: u32,
}

/// A plan describing which entries to keep and which to remove.
#[derive(Debug, Clone)]
pub struct CompactionPlan {
    /// The lane being compacted.
    pub lane_id: LaneId,
    /// Entries that will be removed and summarized.
    pub entries_to_remove: Vec<EntryId>,
    /// Entries that will be kept intact.
    pub entries_to_keep: Vec<EntryId>,
}

/// Result of a compaction operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionResult {
    /// The summary entry that replaces the removed entries.
    pub summary_entry: Entry,
    /// Number of entries removed.
    pub entries_removed: u32,
    /// Estimated tokens saved.
    pub tokens_saved: u32,
}

/// Strategy for reducing context size while preserving semantics.
///
/// Implementations decide which entries to compact and how to summarize them.
/// The default implementation uses the inference backend to generate summaries.
#[async_trait]
pub trait CompactionEngine: Send + Sync {
    /// Decide which entries to compact from a lane.
    ///
    /// Returns a plan describing which entries to remove and keep.
    /// The implementation should preserve the most recent and most important entries.
    async fn select_for_compaction(
        &self,
        lane: &Lane,
        budget: CompactionBudget,
    ) -> Result<CompactionPlan, WaywiserError>;

    /// Execute the compaction plan: summarize removed entries into a single summary entry.
    ///
    /// This typically calls the inference backend to generate a summary of the removed entries.
    async fn compact(
        &self,
        plan: CompactionPlan,
        entries: &[Entry],
    ) -> Result<CompactionResult, WaywiserError>;
}

/// A no-op compaction engine that never compacts. Useful for testing.
pub struct NoOpCompactionEngine;

#[async_trait]
impl CompactionEngine for NoOpCompactionEngine {
    async fn select_for_compaction(
        &self,
        _lane: &Lane,
        _budget: CompactionBudget,
    ) -> Result<CompactionPlan, WaywiserError> {
        Ok(CompactionPlan {
            lane_id: _lane.id,
            entries_to_remove: Vec::new(),
            entries_to_keep: _lane.entries.iter().map(|e| e.id).collect(),
        })
    }

    async fn compact(
        &self,
        _plan: CompactionPlan,
        _entries: &[Entry],
    ) -> Result<CompactionResult, WaywiserError> {
        Err(WaywiserError::CompactionFailed(
            "NoOpCompactionEngine does not compact".to_string(),
        ))
    }
}
