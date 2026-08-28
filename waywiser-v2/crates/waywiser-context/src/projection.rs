//! Context Projection — the model never receives the complete graph.
//!
//! Blueprint §13. The ProjectionEngine scores context nodes by relevance
//! to the current query/task, then greedily fills a token budget.

use crate::graph::ContextGraphSnapshot;

/// The type of task determines the default token budget for context projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskType {
    /// Simple voice/chat — budget ~2K tokens
    SimpleChat,
    /// Normal tool call — budget ~4K tokens
    ToolCall,
    /// Research task — budget ~16K tokens
    Research,
    /// Brain reflection — budget ~8K tokens
    BrainReflection,
}

impl TaskType {
    /// Default token budget for this task type.
    pub fn default_budget(&self) -> usize {
        match self {
            TaskType::SimpleChat => 2_000,
            TaskType::ToolCall => 4_000,
            TaskType::Research => 16_000,
            TaskType::BrainReflection => 8_000,
        }
    }
}

/// A single entry in a context projection.
#[derive(Debug, Clone)]
pub struct ProjectedEntry {
    /// The domain key (e.g., "user.activity").
    pub key: String,
    /// Human-readable text representation.
    pub text: String,
    /// Relevance score (0.0–1.0, higher = more relevant).
    pub relevance: f32,
}

/// The projected context: a relevance-ordered, budget-constrained subset
/// of the full context graph.
#[derive(Debug, Clone)]
pub struct ContextProjection {
    pub entries: Vec<ProjectedEntry>,
    pub tokens_used: usize,
}

impl ContextProjection {
    /// Render the projection as a single string for LLM context injection.
    pub fn render(&self) -> String {
        if self.entries.is_empty() {
            return "No relevant context available.".to_string();
        }
        self.entries
            .iter()
            .map(|e| e.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Projects relevant context from a snapshot for a given query within a token budget.
///
/// The projection engine:
/// 1. Scores each node for relevance to query + task type
/// 2. Sorts by score descending
/// 3. Greedily includes nodes until budget is exhausted
pub struct ProjectionEngine;

impl ProjectionEngine {
    pub fn new() -> Self {
        Self
    }

    /// Project relevant context for the current query.
    ///
    /// `budget_tokens` overrides the task type's default if provided.
    pub fn project(
        &self,
        snapshot: &ContextGraphSnapshot,
        query: &str,
        task_type: TaskType,
        budget_tokens: usize,
    ) -> ContextProjection {
        if snapshot.is_empty() {
            return ContextProjection {
                entries: Vec::new(),
                tokens_used: 0,
            };
        }

        // Score each node
        let mut scored: Vec<(f32, String, String)> = snapshot
            .nodes
            .iter()
            .map(|(key, node)| {
                let text = node.domain.summarize();
                let relevance = self.relevance_score(key, &text, query, task_type);
                (relevance, key.clone(), text)
            })
            .collect();

        // Sort by relevance descending
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        // Greedily fill budget
        let mut entries = Vec::new();
        let mut tokens_used = 0;

        for (relevance, key, text) in scored {
            let estimated_tokens = Self::estimate_tokens(&text);
            if tokens_used + estimated_tokens > budget_tokens {
                // Try to include a truncated version if the entry is large
                if estimated_tokens > 100 && tokens_used + 50 <= budget_tokens {
                    let truncated = Self::truncate_text(&text, budget_tokens - tokens_used);
                    let trunc_tokens = Self::estimate_tokens(&truncated);
                    entries.push(ProjectedEntry {
                        key,
                        text: truncated,
                        relevance,
                    });
                    tokens_used += trunc_tokens;
                }
                continue;
            }
            entries.push(ProjectedEntry {
                key,
                text,
                relevance,
            });
            tokens_used += estimated_tokens;
        }

        ContextProjection {
            entries,
            tokens_used,
        }
    }

    /// Estimate token count for a text string.
    /// Rough heuristic: ~4 characters per token (English average).
    fn estimate_tokens(text: &str) -> usize {
        // Rough estimate: 1 token ≈ 4 characters
        (text.len() + 3) / 4
    }

    /// Truncate text to fit within a token budget.
    fn truncate_text(text: &str, max_tokens: usize) -> String {
        let max_chars = max_tokens * 4;
        if text.len() <= max_chars {
            text.to_string()
        } else {
            let truncated = &text[..text.floor_char_boundary(max_chars.min(text.len()))];
            format!("{truncated}…")
        }
    }

    /// Score relevance of a context node to the current query and task type.
    ///
    /// Simple keyword-based scoring for now. Production version would use
    /// embeddings or the edge model.
    fn relevance_score(
        &self,
        key: &str,
        text: &str,
        query: &str,
        task_type: TaskType,
    ) -> f32 {
        let mut score: f32 = 0.0;
        let query_lower = query.to_lowercase();
        let text_lower = text.to_lowercase();
        let key_lower = key.to_lowercase();

        // Keyword overlap: each query word found in the text adds 0.15
        for word in query_lower.split_whitespace() {
            if word.len() < 3 {
                continue; // skip short words
            }
            if text_lower.contains(word) {
                score += 0.15;
            }
            if key_lower.contains(word) {
                score += 0.1;
            }
        }

        // Domain-based base relevance
        score += match key.split('.').next().unwrap_or("") {
            "user" => 0.3,        // user context is almost always relevant
            "device" => match task_type {
                TaskType::SimpleChat => 0.1,
                TaskType::ToolCall => 0.2,
                _ => 0.15,
            },
            "environment" => 0.1,
            _ => 0.05,
        };

        // Task-type specific boosts
        match task_type {
            TaskType::SimpleChat => {
                if key == "user.next_event" {
                    score += 0.2;
                }
            }
            TaskType::ToolCall => {
                if key.starts_with("device") {
                    score += 0.1;
                }
            }
            TaskType::Research => {
                // Research gets a broad boost — most context potentially relevant
                score += 0.1;
            }
            TaskType::BrainReflection => {
                if key == "user.activity" || key == "user.place_context" {
                    score += 0.15;
                }
            }
        }

        // Clamp to [0.0, 1.0]
        score.min(1.0)
    }
}

impl Default for ProjectionEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{ContextGraphSnapshot, ContextNode};
    use crate::domains::*;
    use chrono::Utc;
    use pi_types::ObservationSource;

    fn make_snapshot(nodes: Vec<(&str, ContextDomain)>) -> ContextGraphSnapshot {
        ContextGraphSnapshot {
            nodes: nodes
                .into_iter()
                .map(|(key, domain)| {
                    (
                        key.to_string(),
                        ContextNode {
                            domain,
                            updated_at: Utc::now(),
                            expires_at: None,
                            source: ObservationSource::Android,
                        },
                    )
                })
                .collect(),
            captured_at: Utc::now(),
        }
    }

    #[test]
    fn test_empty_snapshot_projects_empty() {
        let engine = ProjectionEngine::new();
        let snapshot = ContextGraphSnapshot {
            nodes: vec![],
            captured_at: Utc::now(),
        };
        let proj = engine.project(&snapshot, "hello", TaskType::SimpleChat, 2000);
        assert!(proj.entries.is_empty());
        assert_eq!(proj.tokens_used, 0);
    }

    #[test]
    fn test_budget_enforcement_simple_chat() {
        let engine = ProjectionEngine::new();
        // Create a large snapshot
        let mut nodes = Vec::new();
        for i in 0..100 {
            nodes.push((
                Box::leak(format!("user.item_{i}").into_boxed_str()) as &str,
                ContextDomain::User(UserContext {
                    activity: Some(ActivityState::Walking),
                    audio_route: None,
                    place_context: None,
                    next_event: None,
                    attention_state: None,
                }),
            ));
        }
        let snapshot = make_snapshot(nodes);

        // SimpleChat budget is 2000 tokens
        let proj = engine.project(&snapshot, "what time", TaskType::SimpleChat, 2000);
        assert!(proj.tokens_used <= 2000, "tokens_used={} exceeds budget 2000", proj.tokens_used);
    }

    #[test]
    fn test_task_type_budgets() {
        assert_eq!(TaskType::SimpleChat.default_budget(), 2_000);
        assert_eq!(TaskType::ToolCall.default_budget(), 4_000);
        assert_eq!(TaskType::Research.default_budget(), 16_000);
        assert_eq!(TaskType::BrainReflection.default_budget(), 8_000);
    }

    #[test]
    fn test_projection_includes_relevant_nodes() {
        let engine = ProjectionEngine::new();
        let snapshot = make_snapshot(vec![
            ("user.next_event", ContextDomain::User(UserContext {
                activity: None,
                audio_route: None,
                place_context: None,
                next_event: Some(UpcomingEvent {
                    title: "Team meeting".to_string(),
                    start: Utc::now(),
                    minutes_until: 15,
                }),
                attention_state: None,
            })),
            ("device.battery", ContextDomain::Device(DeviceContext {
                battery_pct: 42,
                charging: false,
                network: NetworkState::Wifi,
                thermal: ThermalState::Nominal,
                screen: ScreenState::On,
            })),
        ]);

        let proj = engine.project(&snapshot, "meeting", TaskType::SimpleChat, 2000);
        assert!(!proj.entries.is_empty());
        // The event node mentioning "meeting" should have high relevance
        let event_entry = proj.entries.iter().find(|e| e.key == "user.next_event");
        assert!(event_entry.is_some());
    }

    #[test]
    fn test_projection_render() {
        let proj = ContextProjection {
            entries: vec![
                ProjectedEntry {
                    key: "user.activity".to_string(),
                    text: "User: activity=Walking".to_string(),
                    relevance: 0.8,
                },
                ProjectedEntry {
                    key: "device.battery".to_string(),
                    text: "Device: battery=42%".to_string(),
                    relevance: 0.5,
                },
            ],
            tokens_used: 20,
        };
        let rendered = proj.render();
        assert!(rendered.contains("Walking"));
        assert!(rendered.contains("42%"));
    }
}
