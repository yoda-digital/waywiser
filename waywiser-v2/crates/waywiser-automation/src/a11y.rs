//! Accessibility tree types and quality assessment.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Bounding rectangle for a UI node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self { left, top, right, bottom }
    }

    pub fn zero() -> Self {
        Self { left: 0, top: 0, right: 0, bottom: 0 }
    }

    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

/// Normalized accessibility tree node — platform-independent representation.
/// Kotlin AccessibilityBridge converts AccessibilityNodeInfo → this via FFI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11yNode {
    pub node_id: i64,
    pub package: String,
    pub window_id: i32,
    pub resource_id: Option<String>,
    pub class_name: String,
    pub role: Option<String>,
    pub text: Option<String>,
    pub content_description: Option<String>,
    pub hint_text: Option<String>,
    pub state_description: Option<String>,
    pub bounds: Rect,
    pub is_clickable: bool,
    pub is_scrollable: bool,
    pub is_editable: bool,
    pub is_focusable: bool,
    pub is_checked: Option<bool>,
    pub children: Vec<A11yNode>,
}

impl A11yNode {
    /// Concatenate text and content_description into one search string.
    pub fn combined_text(&self) -> String {
        let mut parts = Vec::new();
        if let Some(ref t) = self.text {
            if !t.is_empty() {
                parts.push(t.as_str());
            }
        }
        if let Some(ref cd) = self.content_description {
            if !cd.is_empty() {
                parts.push(cd.as_str());
            }
        }
        if let Some(ref ht) = self.hint_text {
            if !ht.is_empty() {
                parts.push(ht.as_str());
            }
        }
        parts.join(" ")
    }

    /// Create a minimal builder-style node for tests.
    pub fn builder(node_id: i64, package: impl Into<String>) -> A11yNodeBuilder {
        A11yNodeBuilder {
            node_id,
            package: package.into(),
            window_id: 0,
            resource_id: None,
            class_name: "android.view.View".into(),
            role: None,
            text: None,
            content_description: None,
            hint_text: None,
            state_description: None,
            bounds: Rect::zero(),
            is_clickable: false,
            is_scrollable: false,
            is_editable: false,
            is_focusable: false,
            is_checked: None,
            children: Vec::new(),
        }
    }
}

/// Builder for constructing A11yNode in tests.
pub struct A11yNodeBuilder {
    node_id: i64,
    package: String,
    window_id: i32,
    resource_id: Option<String>,
    class_name: String,
    role: Option<String>,
    text: Option<String>,
    content_description: Option<String>,
    hint_text: Option<String>,
    state_description: Option<String>,
    bounds: Rect,
    is_clickable: bool,
    is_scrollable: bool,
    is_editable: bool,
    is_focusable: bool,
    is_checked: Option<bool>,
    children: Vec<A11yNode>,
}

impl A11yNodeBuilder {
    pub fn resource_id(mut self, id: impl Into<String>) -> Self {
        self.resource_id = Some(id.into());
        self
    }
    pub fn text(mut self, t: impl Into<String>) -> Self {
        self.text = Some(t.into());
        self
    }
    pub fn content_description(mut self, cd: impl Into<String>) -> Self {
        self.content_description = Some(cd.into());
        self
    }
    pub fn hint_text(mut self, ht: impl Into<String>) -> Self {
        self.hint_text = Some(ht.into());
        self
    }
    pub fn class_name(mut self, cn: impl Into<String>) -> Self {
        self.class_name = cn.into();
        self
    }
    pub fn clickable(mut self) -> Self {
        self.is_clickable = true;
        self
    }
    pub fn child(mut self, child: A11yNode) -> Self {
        self.children.push(child);
        self
    }
    pub fn children(mut self, children: Vec<A11yNode>) -> Self {
        self.children = children;
        self
    }
    pub fn build(self) -> A11yNode {
        A11yNode {
            node_id: self.node_id,
            package: self.package,
            window_id: self.window_id,
            resource_id: self.resource_id,
            class_name: self.class_name,
            role: self.role,
            text: self.text,
            content_description: self.content_description,
            hint_text: self.hint_text,
            state_description: self.state_description,
            bounds: self.bounds,
            is_clickable: self.is_clickable,
            is_scrollable: self.is_scrollable,
            is_editable: self.is_editable,
            is_focusable: self.is_focusable,
            is_checked: self.is_checked,
            children: self.children,
        }
    }
}

/// Quality of the inspected accessibility tree (blueprint §26).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TreeQuality {
    /// Rich metadata: semantic automation viable.
    Good,
    /// Some metadata: semantic + optional visual verification.
    Partial,
    /// Sparse metadata: visual reasoning + stronger approval.
    Poor,
    /// No usable metadata: refuse autonomous operation.
    Unusable,
}

/// Secure-window state for a given accessibility context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SecureWindowState {
    /// Normal window — all inspection/automation available.
    Normal,
    /// FLAG_SECURE detected — visual automation unavailable,
    /// semantic tree may or may not still be readable.
    SecureBlocked,
}

/// A snapshot of the current accessibility tree for a window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeSnapshot {
    pub window_id: i32,
    pub package: String,
    pub root: A11yNode,
    pub quality: TreeQuality,
    pub secure_state: SecureWindowState,
    pub captured_at: DateTime<Utc>,
}

/// Count total nodes in the tree (root + all descendants recursively).
pub fn count_nodes(root: &A11yNode) -> usize {
    1 + root.children.iter().map(count_nodes).sum::<usize>()
}

/// Count nodes matching a predicate, recursively.
pub fn count_with(root: &A11yNode, predicate: &dyn Fn(&A11yNode) -> bool) -> usize {
    let self_match = if predicate(root) { 1 } else { 0 };
    self_match + root.children.iter().map(|c| count_with(c, predicate)).sum::<usize>()
}

/// Assess tree quality from node metadata density.
///
/// Ratio = (nodes_with_resource_id + nodes_with_text_or_description) / (2 * total_nodes)
/// - ≥ 0.6 → Good
/// - ≥ 0.3 → Partial
/// - ≥ 0.1 → Poor
/// - < 0.1 → Unusable
pub fn assess_tree_quality(root: &A11yNode) -> TreeQuality {
    let total = count_nodes(root);
    if total == 0 {
        return TreeQuality::Unusable;
    }

    let with_id = count_with(root, &|n| n.resource_id.is_some());
    let with_text = count_with(root, &|n| {
        n.content_description.as_ref().is_some_and(|s| !s.is_empty())
            || n.text.as_ref().is_some_and(|s| !s.is_empty())
    });

    let ratio = (with_id + with_text) as f64 / (total * 2) as f64;

    if ratio >= 0.6 {
        TreeQuality::Good
    } else if ratio >= 0.3 {
        TreeQuality::Partial
    } else if ratio >= 0.1 {
        TreeQuality::Poor
    } else {
        TreeQuality::Unusable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(id: i64, pkg: &str) -> A11yNode {
        A11yNode::builder(id, pkg).build()
    }

    #[test]
    fn count_single_node() {
        assert_eq!(count_nodes(&leaf(1, "com.test")), 1);
    }

    #[test]
    fn count_with_children() {
        let root = A11yNode::builder(1, "com.test")
            .child(leaf(2, "com.test"))
            .child(
                A11yNode::builder(3, "com.test")
                    .child(leaf(4, "com.test"))
                    .build(),
            )
            .build();
        assert_eq!(count_nodes(&root), 4);
    }
}
