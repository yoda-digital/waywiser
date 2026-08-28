//! Agent message types.
//!
//! These are the messages exchanged between the agent, user, model, and tools
//! within a Pi session.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::EntryId;

/// Top-level message in an agent conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentMessage {
    User(UserMessage),
    Assistant(AssistantMessage),
    Tool(ToolMessage),
    System(SystemMessage),
}

/// A message from the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessage {
    pub id: EntryId,
    pub content: MessageContent,
    pub timestamp: DateTime<Utc>,
}

/// A message from the assistant/model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub id: EntryId,
    pub content: MessageContent,
    pub tool_calls: Vec<ToolCall>,
    pub thinking: Option<String>,
    pub usage: TokenUsage,
    pub timestamp: DateTime<Utc>,
}

/// A tool result message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolMessage {
    pub id: EntryId,
    pub tool_call_id: String,
    pub name: String,
    pub content: MessageContent,
    pub timestamp: DateTime<Utc>,
}

/// A system message (injected context, not user-visible).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMessage {
    pub id: EntryId,
    pub content: String,
    pub timestamp: DateTime<Utc>,
}

/// Content of a message — plain text or multipart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl MessageContent {
    /// Get the text representation of the content.
    pub fn as_text(&self) -> String {
        match self {
            MessageContent::Text(t) => t.clone(),
            MessageContent::Parts(parts) => parts
                .iter()
                .filter_map(|p| match p {
                    ContentPart::Text(t) => Some(t.as_str()),
                    ContentPart::Image { .. } => None,
                })
                .collect::<Vec<_>>()
                .join(""),
        }
    }
}

/// A part of a multipart message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ContentPart {
    Text(String),
    Image {
        media_type: String,
        data: Vec<u8>,
    },
}

/// A tool call requested by the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Token usage for a single model call.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub thinking_tokens: u32,
}
