//! IdentityService — parses and budgets SOUL.md / USER.md (§10).
//!
//! Human-readable identity files remain inspectable, exportable,
//! versionable, and editable. The runtime parses and budgets them
//! before injection into agent context.

use pi_types::WaywiserError;
use std::path::Path;

/// A parsed section from an identity file.
#[derive(Debug, Clone)]
pub struct IdentitySection {
    pub heading: String,
    pub content: String,
    pub token_estimate: u32,
}

/// A parsed identity file (SOUL.md or USER.md).
#[derive(Debug, Clone)]
pub struct ParsedIdentity {
    pub raw: String,
    pub sections: Vec<IdentitySection>,
    pub total_token_estimate: u32,
}

impl ParsedIdentity {
    /// Parse a markdown identity file into sections.
    pub fn parse(content: &str) -> Self {
        let mut sections = Vec::new();
        let mut current_heading = String::from("Preamble");
        let mut current_content = String::new();

        for line in content.lines() {
            if line.starts_with('#') {
                // Save previous section if non-empty
                if !current_content.trim().is_empty() {
                    let token_est = estimate_tokens(&current_content);
                    sections.push(IdentitySection {
                        heading: current_heading.clone(),
                        content: current_content.trim().to_string(),
                        token_estimate: token_est,
                    });
                }
                current_heading = line.trim_start_matches('#').trim().to_string();
                current_content = String::new();
            } else {
                current_content.push_str(line);
                current_content.push('\n');
            }
        }

        // Save final section
        if !current_content.trim().is_empty() {
            let token_est = estimate_tokens(&current_content);
            sections.push(IdentitySection {
                heading: current_heading,
                content: current_content.trim().to_string(),
                token_estimate: token_est,
            });
        }

        let total = sections.iter().map(|s| s.token_estimate).sum();
        Self {
            raw: content.to_string(),
            sections,
            total_token_estimate: total,
        }
    }
}

/// Service for managing identity files (SOUL.md, USER.md).
#[derive(Debug, Clone)]
pub struct IdentityService {
    pub soul: ParsedIdentity,
    pub user: ParsedIdentity,
}

impl IdentityService {
    /// Load identity from SOUL.md and USER.md file paths.
    pub fn load(soul_path: &Path, user_path: &Path) -> Result<Self, WaywiserError> {
        let soul_content = std::fs::read_to_string(soul_path).map_err(|e| {
            WaywiserError::SkillLoadError {
                path: soul_path.display().to_string(),
                reason: format!("Failed to read SOUL.md: {e}"),
            }
        })?;
        let user_content = std::fs::read_to_string(user_path).map_err(|e| {
            WaywiserError::SkillLoadError {
                path: user_path.display().to_string(),
                reason: format!("Failed to read USER.md: {e}"),
            }
        })?;

        Ok(Self {
            soul: ParsedIdentity::parse(&soul_content),
            user: ParsedIdentity::parse(&user_content),
        })
    }

    /// Create an IdentityService from raw content strings (useful for testing).
    pub fn from_content(soul_content: &str, user_content: &str) -> Self {
        Self {
            soul: ParsedIdentity::parse(soul_content),
            user: ParsedIdentity::parse(user_content),
        }
    }

    /// Returns identity text budgeted to fit within max_tokens.
    ///
    /// SOUL.md is prioritized over USER.md. Sections are included
    /// in order until the budget is exhausted.
    pub fn project(&self, max_tokens: u32) -> String {
        let mut result = String::new();
        let mut remaining = max_tokens;

        // SOUL first — always higher priority
        for section in &self.soul.sections {
            if section.token_estimate <= remaining {
                if !result.is_empty() {
                    result.push_str("\n\n");
                }
                result.push_str(&format!("## {}\n\n{}", section.heading, section.content));
                remaining = remaining.saturating_sub(section.token_estimate);
            }
        }

        // Then USER sections
        for section in &self.user.sections {
            if section.token_estimate <= remaining {
                if !result.is_empty() {
                    result.push_str("\n\n");
                }
                result.push_str(&format!("## {}\n\n{}", section.heading, section.content));
                remaining = remaining.saturating_sub(section.token_estimate);
            }
        }

        result
    }

    /// Total estimated tokens for both identity files.
    pub fn total_tokens(&self) -> u32 {
        self.soul.total_token_estimate + self.user.total_token_estimate
    }
}

/// Rough token estimate: ~4 chars per token for English text.
fn estimate_tokens(text: &str) -> u32 {
    (text.len() as u32 + 3) / 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_identity() {
        let content = "# Name\n\nI am Waywiser.\n\n# Values\n\nHelpful and honest.\n";
        let parsed = ParsedIdentity::parse(content);
        assert_eq!(parsed.sections.len(), 2);
        assert_eq!(parsed.sections[0].heading, "Name");
        assert_eq!(parsed.sections[1].heading, "Values");
    }

    #[test]
    fn test_estimate_tokens() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
    }
}
