//! Tests for IdentityService — SOUL.md / USER.md parsing and projection.

use waywiser_core::identity::{IdentityService, ParsedIdentity};

#[test]
fn test_parse_sections() {
    let content = "# Identity\n\nI am Waywiser.\n\n# Values\n\nHelpful and honest.\n\n# Constraints\n\nNever lie.\n";
    let parsed = ParsedIdentity::parse(content);

    assert_eq!(parsed.sections.len(), 3);
    assert_eq!(parsed.sections[0].heading, "Identity");
    assert_eq!(parsed.sections[1].heading, "Values");
    assert_eq!(parsed.sections[2].heading, "Constraints");
}

#[test]
fn test_parse_no_headings() {
    let content = "Just some plain text without headings.\nMore text here.\n";
    let parsed = ParsedIdentity::parse(content);

    assert_eq!(parsed.sections.len(), 1);
    assert_eq!(parsed.sections[0].heading, "Preamble");
}

#[test]
fn test_parse_empty() {
    let parsed = ParsedIdentity::parse("");
    assert!(parsed.sections.is_empty());
}

#[test]
fn test_project_with_budget() {
    let soul = "# Name\n\nI am Waywiser, a personal intelligence.\n\n# Values\n\nI am helpful, honest, and safe.\n";
    let user = "# User\n\nAlice is a software engineer.\n\n# Preferences\n\nPrefers morning meetings.\n";

    let service = IdentityService::from_content(soul, user);

    // With a large budget, everything should be included
    let full = service.project(10000);
    assert!(full.contains("Waywiser"));
    assert!(full.contains("Alice"));
    assert!(full.contains("morning meetings"));
}

#[test]
fn test_project_prioritizes_soul() {
    let soul = "# Name\n\nI am Waywiser, a personal intelligence.\n";
    let user = "# User\n\nAlice is a software engineer.\n";

    let service = IdentityService::from_content(soul, user);

    // With a tiny budget, SOUL should come first
    let tiny = service.project(20);
    assert!(tiny.contains("Waywiser"));
}

#[test]
fn test_project_truncation() {
    // Create content that exceeds budget
    let soul = "# Name\n\nI am Waywiser.\n";
    let user = "# Preferences\n\nThis is a very long section that goes on and on about user preferences in great detail, covering many topics and subtopics that require extensive explanation and documentation.\n";

    let service = IdentityService::from_content(soul, user);

    // Very small budget — should include soul but maybe not user
    let result = service.project(10);
    assert!(result.contains("Waywiser"));
}

#[test]
fn test_total_tokens() {
    let service = IdentityService::from_content(
        "# Test\n\nFour characters here abcd.\n",
        "# User\n\nSome more text.\n",
    );

    // Token estimate is rough (chars/4)
    assert!(service.total_tokens() > 0);
}
