use waywiser_automation::a11y::*;

fn leaf(id: i64) -> A11yNode {
    A11yNode::builder(id, "com.test").build()
}

fn leaf_with_id(id: i64, rid: &str) -> A11yNode {
    A11yNode::builder(id, "com.test")
        .resource_id(rid)
        .build()
}

fn leaf_with_text(id: i64, text: &str) -> A11yNode {
    A11yNode::builder(id, "com.test")
        .text(text)
        .build()
}

fn leaf_with_both(id: i64, rid: &str, text: &str) -> A11yNode {
    A11yNode::builder(id, "com.test")
        .resource_id(rid)
        .text(text)
        .build()
}

#[test]
fn all_nodes_with_ids_and_text_is_good() {
    let root = A11yNode::builder(1, "com.test")
        .resource_id("root")
        .text("Root")
        .child(leaf_with_both(2, "child1", "Child 1"))
        .child(leaf_with_both(3, "child2", "Child 2"))
        .build();

    assert_eq!(assess_tree_quality(&root), TreeQuality::Good);
}

#[test]
fn no_ids_no_text_is_unusable() {
    let root = A11yNode::builder(1, "com.test")
        .child(leaf(2))
        .child(leaf(3))
        .build();

    assert_eq!(assess_tree_quality(&root), TreeQuality::Unusable);
}

#[test]
fn mixed_metadata_is_partial() {
    // 5 nodes, 2 with resource_id, 1 with text = ratio (2+1)/(5*2) = 0.3 → Partial
    let root = A11yNode::builder(1, "com.test")
        .resource_id("root_id")
        .child(leaf_with_id(2, "child1_id"))
        .child(leaf_with_text(3, "some text"))
        .child(leaf(4))
        .child(leaf(5))
        .build();

    let quality = assess_tree_quality(&root);
    assert_eq!(quality, TreeQuality::Partial);
}

#[test]
fn sparse_metadata_is_poor() {
    // 10 nodes, 1 with resource_id, 1 with text = ratio 2/20 = 0.1 → Poor
    let mut children = Vec::new();
    children.push(leaf_with_id(2, "only_id"));
    children.push(leaf_with_text(3, "only_text"));
    for i in 4..=10 {
        children.push(leaf(i));
    }
    let root = A11yNode::builder(1, "com.test")
        .children(children)
        .build();

    let quality = assess_tree_quality(&root);
    assert_eq!(quality, TreeQuality::Poor);
}

#[test]
fn combined_text_concatenates_fields() {
    let node = A11yNode::builder(1, "com.test")
        .text("Hello")
        .content_description("World")
        .hint_text("Tap here")
        .build();

    assert_eq!(node.combined_text(), "Hello World Tap here");
}

#[test]
fn combined_text_skips_empty() {
    let node = A11yNode::builder(1, "com.test")
        .text("Only text")
        .build();

    assert_eq!(node.combined_text(), "Only text");
}

#[test]
fn combined_text_empty_when_none() {
    let node = A11yNode::builder(1, "com.test").build();
    assert_eq!(node.combined_text(), "");
}

#[test]
fn count_nodes_recursive() {
    let root = A11yNode::builder(1, "com.test")
        .child(
            A11yNode::builder(2, "com.test")
                .child(leaf(3))
                .child(leaf(4))
                .build(),
        )
        .child(leaf(5))
        .build();

    assert_eq!(count_nodes(&root), 5);
}

#[test]
fn count_with_predicate() {
    let root = A11yNode::builder(1, "com.test")
        .clickable()
        .child(A11yNode::builder(2, "com.test").clickable().build())
        .child(leaf(3))
        .build();

    let clickable_count = count_with(&root, &|n| n.is_clickable);
    assert_eq!(clickable_count, 2);
}

#[test]
fn tree_snapshot_creation() {
    let root = leaf_with_both(1, "root", "Root");
    let snapshot = TreeSnapshot {
        window_id: 1,
        package: "com.test".into(),
        root: root.clone(),
        quality: assess_tree_quality(&root),
        secure_state: SecureWindowState::Normal,
        captured_at: chrono::Utc::now(),
    };

    assert_eq!(snapshot.quality, TreeQuality::Good);
    assert_eq!(snapshot.secure_state, SecureWindowState::Normal);
}
