//! SSE streaming parser for OpenAI-compatible chat completion responses.

use pi_types::TokenUsage;
use serde::{Deserialize, Serialize};

/// Events emitted during a streaming completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StreamEvent {
    /// A text content delta from the model.
    TextDelta(String),
    /// A thinking/reasoning block delta.
    ThinkingDelta(String),
    /// A tool call being incrementally constructed.
    ToolCallDelta {
        index: u32,
        id: Option<String>,
        name: Option<String>,
        arguments_delta: String,
    },
    /// Token usage information (typically arrives at end of stream).
    Usage(TokenUsage),
    /// Stream finished normally.
    Done,
    /// An error occurred during streaming.
    Error(String),
}

/// Parser for Server-Sent Events (SSE) in OpenAI chat completion format.
///
/// Processes raw SSE text lines and emits `StreamEvent` values.
pub struct SseParser {
    buffer: String,
}

/// Internal representation of an OpenAI SSE chunk delta.
#[derive(Debug, Deserialize)]
struct SseChunk {
    choices: Option<Vec<SseChoice>>,
    usage: Option<SseUsage>,
}

#[derive(Debug, Deserialize)]
struct SseChoice {
    delta: Option<SseDelta>,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SseDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
    tool_calls: Option<Vec<SseToolCallDelta>>,
}

#[derive(Debug, Deserialize)]
struct SseToolCallDelta {
    index: Option<u32>,
    id: Option<String>,
    function: Option<SseFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct SseFunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SseUsage {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
}

impl SseParser {
    /// Create a new SSE parser.
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    /// Feed raw bytes from the HTTP response. Returns any complete events parsed.
    ///
    /// SSE format:
    /// ```text
    /// data: {"choices":[{"delta":{"content":"Hello"}}]}
    /// data: [DONE]
    /// ```
    pub fn feed(&mut self, chunk: &str) -> Vec<StreamEvent> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();

        // Process complete lines
        while let Some(newline_pos) = self.buffer.find('\n') {
            let line = self.buffer[..newline_pos].trim_end_matches('\r').to_string();
            self.buffer = self.buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                // Empty line = end of SSE event block (but we process per data: line)
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if let Some(event) = self.parse_data_line(data) {
                    events.push(event);
                }
            }
            // Ignore non-data SSE lines (event:, id:, retry:, comments)
        }

        events
    }

    /// Parse a single `data:` payload.
    fn parse_data_line(&self, data: &str) -> Option<StreamEvent> {
        let data = data.trim();

        // Terminal signal
        if data == "[DONE]" {
            return Some(StreamEvent::Done);
        }

        // Parse JSON chunk
        let chunk: SseChunk = match serde_json::from_str(data) {
            Ok(c) => c,
            Err(e) => {
                return Some(StreamEvent::Error(format!(
                    "SSE JSON parse error: {e}: {data}"
                )));
            }
        };

        // Extract usage if present
        if let Some(usage) = chunk.usage {
            return Some(StreamEvent::Usage(TokenUsage {
                prompt_tokens: usage.prompt_tokens.unwrap_or(0),
                completion_tokens: usage.completion_tokens.unwrap_or(0),
                thinking_tokens: 0,
            }));
        }

        // Extract deltas from choices
        let choices = chunk.choices?;
        let choice = choices.into_iter().next()?;

        // Check for finish_reason
        if choice.finish_reason.is_some() && choice.delta.is_none() {
            return None; // finish_reason without delta is just a signal
        }

        let delta = choice.delta?;

        // Thinking/reasoning content
        if let Some(reasoning) = delta.reasoning_content {
            if !reasoning.is_empty() {
                return Some(StreamEvent::ThinkingDelta(reasoning));
            }
        }

        // Regular content
        if let Some(content) = delta.content {
            if !content.is_empty() {
                return Some(StreamEvent::TextDelta(content));
            }
        }

        // Tool calls
        if let Some(tool_calls) = delta.tool_calls {
            for tc in tool_calls {
                let func = tc.function.unwrap_or(SseFunctionDelta {
                    name: None,
                    arguments: None,
                });
                return Some(StreamEvent::ToolCallDelta {
                    index: tc.index.unwrap_or(0),
                    id: tc.id,
                    name: func.name,
                    arguments_delta: func.arguments.unwrap_or_default(),
                });
            }
        }

        None
    }
}

impl Default for SseParser {
    fn default() -> Self {
        Self::new()
    }
}
