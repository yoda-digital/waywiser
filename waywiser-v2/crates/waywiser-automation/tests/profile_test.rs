use std::collections::HashMap;
use chrono::Utc;
use pi_types::{CapabilityName, RiskLevel};
use waywiser_automation::{A11yNode, AutomationProfile, NodeProfile, ProfileRegistry};

fn make_profile() -> AutomationProfile {
    let mut nodes = HashMap::new();
    nodes.insert(
        "com.company.mail:id/send".into(),
        NodeProfile {
            resource_id: "com.company.mail:id/send".into(),
            effect: CapabilityName("communication.send".into()),
            risk: RiskLevel::Communication,
            description: "Send email button".into(),
        },
    );
    nodes.insert(
        "com.company.mail:id/archive".into(),
        NodeProfile {
            resource_id: "com.company.mail:id/archive".into(),
            effect: CapabilityName("mail.archive".into()),
            risk: RiskLevel::CrossAppWrite,
            description: "Archive button".into(),
        },
    );
    AutomationProfile {
        package: "com.company.mail".into(),
        app_version: "2.1.0".into(),
        reviewed_at: Utc::now(),
        reviewer: "security-team".into(),
        nodes,
    }
}

#[test]
fn match_send_button() {
    let mut reg = ProfileRegistry::empty();
    reg.register(make_profile());

    let node = A11yNode::builder(1, "com.company.mail")
        .resource_id("com.company.mail:id/send")
        .text("Send")
        .build();

    let matched = reg.match_node("com.company.mail", &node);
    assert!(matched.is_some());
    let np = matched.unwrap();
    assert_eq!(np.risk, RiskLevel::Communication);
    assert_eq!(np.effect.0, "communication.send");
}

#[test]
fn match_archive_button() {
    let mut reg = ProfileRegistry::empty();
    reg.register(make_profile());

    let node = A11yNode::builder(1, "com.company.mail")
        .resource_id("com.company.mail:id/archive")
        .build();

    let matched = reg.match_node("com.company.mail", &node);
    assert!(matched.is_some());
    assert_eq!(matched.unwrap().risk, RiskLevel::CrossAppWrite);
}

#[test]
fn no_match_unknown_resource_id() {
    let mut reg = ProfileRegistry::empty();
    reg.register(make_profile());

    let node = A11yNode::builder(1, "com.company.mail")
        .resource_id("com.company.mail:id/delete")
        .build();

    assert!(reg.match_node("com.company.mail", &node).is_none());
}

#[test]
fn no_match_no_resource_id() {
    let mut reg = ProfileRegistry::empty();
    reg.register(make_profile());

    let node = A11yNode::builder(1, "com.company.mail")
        .text("Send")
        .build();

    // No resource_id → can't match
    assert!(reg.match_node("com.company.mail", &node).is_none());
}

#[test]
fn no_match_unknown_package() {
    let mut reg = ProfileRegistry::empty();
    reg.register(make_profile());

    let node = A11yNode::builder(1, "com.other.app")
        .resource_id("com.other.app:id/send")
        .build();

    assert!(reg.match_node("com.other.app", &node).is_none());
}

#[test]
fn stale_when_version_differs() {
    let mut reg = ProfileRegistry::empty();
    reg.register(make_profile());

    assert!(reg.is_stale("com.company.mail", "3.0.0"));
}

#[test]
fn not_stale_when_version_matches() {
    let mut reg = ProfileRegistry::empty();
    reg.register(make_profile());

    assert!(!reg.is_stale("com.company.mail", "2.1.0"));
}

#[test]
fn unknown_package_not_stale() {
    let reg = ProfileRegistry::empty();
    assert!(!reg.is_stale("com.unknown", "1.0.0"));
}

#[test]
fn empty_registry_has_no_profiles() {
    let reg = ProfileRegistry::empty();
    assert!(reg.packages().is_empty());
    assert!(!reg.has_profile("com.test"));
}

#[test]
fn load_from_nonexistent_dir() {
    let reg = ProfileRegistry::load_from_dir(std::path::Path::new("/nonexistent/path")).unwrap();
    assert!(reg.packages().is_empty());
}
