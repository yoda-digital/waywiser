use std::collections::HashMap;

use chrono::Utc;
use uuid::Uuid;

use pi_types::AttentionDecision;
use waywiser_notifications::*;
use waywiser_notifications::normalized::{NotificationId, ContactId};

fn test_notification(
    package: &str,
    title: &str,
    priority: AndroidPriority,
    person: Option<PersonRef>,
    category: Option<&str>,
) -> NormalizedNotification {
    NormalizedNotification {
        id: NotificationId(Uuid::now_v7()),
        app_package: package.to_string(),
        channel_id: None,
        title: title.to_string(),
        text: "test body".to_string(),
        big_text: None,
        person,
        actions: vec![],
        priority,
        category: category.map(String::from),
        posted_at: Utc::now(),
        is_group_summary: false,
        conversation_id: None,
    }
}

fn important_contact_id() -> ContactId {
    ContactId(Uuid::from_u128(1))
}

fn family_contact_id() -> ContactId {
    ContactId(Uuid::from_u128(2))
}

fn policy_with_contacts() -> NotificationPolicy {
    NotificationPolicy {
        important_contacts: vec![important_contact_id()],
        family_contacts: vec![family_contact_id()],
        app_ceilings: HashMap::new(),
        app_floors: HashMap::new(),
    }
}

#[test]
fn important_contact_gets_notify_minimum() {
    let policy = policy_with_contacts();
    let classifier = DeterministicClassifier::new(policy);

    let notif = test_notification(
        "com.messaging.app",
        "Hey",
        AndroidPriority::Low, // even low priority
        Some(PersonRef {
            contact_id: Some(important_contact_id()),
            name: Some("Boss".to_string()),
            uri: None,
        }),
        None,
    );

    let result = classifier.classify(&notif);
    assert!(
        result.attention >= AttentionDecision::Notify,
        "Important contact should get at least Notify, got {:?}",
        result.attention
    );
}

#[test]
fn family_contact_gets_notify_minimum() {
    let policy = policy_with_contacts();
    let classifier = DeterministicClassifier::new(policy);

    let notif = test_notification(
        "com.messaging.app",
        "Dinner",
        AndroidPriority::Min,
        Some(PersonRef {
            contact_id: Some(family_contact_id()),
            name: Some("Mom".to_string()),
            uri: None,
        }),
        None,
    );

    let result = classifier.classify(&notif);
    assert!(result.attention >= AttentionDecision::Notify);
}

#[test]
fn alarm_gets_heads_up() {
    let policy = NotificationPolicy::new();
    let classifier = DeterministicClassifier::new(policy);

    let notif = test_notification(
        "com.android.deskclock",
        "Alarm",
        AndroidPriority::Default,
        None,
        Some("alarm"),
    );

    let result = classifier.classify(&notif);
    assert!(result.attention >= AttentionDecision::HeadsUp);
}

#[test]
fn security_alert_gets_notify() {
    let policy = NotificationPolicy::new();
    let classifier = DeterministicClassifier::new(policy);

    let notif = test_notification(
        "com.android.systemui",
        "Security warning",
        AndroidPriority::Default,
        None,
        Some("sys"),
    );

    let result = classifier.classify(&notif);
    assert!(result.attention >= AttentionDecision::Notify);
}

#[test]
fn app_ceiling_enforced() {
    let mut policy = NotificationPolicy::new();
    policy
        .app_ceilings
        .insert("com.ci.bot".to_string(), AttentionDecision::Notify);

    let classifier = DeterministicClassifier::new(policy);

    let notif = test_notification(
        "com.ci.bot",
        "Build passed",
        AndroidPriority::High, // would normally be HeadsUp
        None,
        None,
    );

    let result = classifier.classify(&notif);
    assert!(
        result.attention <= AttentionDecision::Notify,
        "CI bot should be capped at Notify, got {:?}",
        result.attention
    );
}

#[test]
fn low_priority_default_batched() {
    let policy = NotificationPolicy::new();
    let classifier = DeterministicClassifier::new(policy);

    let notif = test_notification(
        "com.random.app",
        "Update available",
        AndroidPriority::Low,
        None,
        None,
    );

    let result = classifier.classify(&notif);
    assert_eq!(result.attention, AttentionDecision::Batch);
}

#[test]
fn min_priority_default_dropped() {
    let policy = NotificationPolicy::new();
    let classifier = DeterministicClassifier::new(policy);

    let notif = test_notification(
        "com.random.app",
        "Background task",
        AndroidPriority::Min,
        None,
        None,
    );

    let result = classifier.classify(&notif);
    assert_eq!(result.attention, AttentionDecision::Drop);
}

#[test]
fn app_floor_enforced() {
    let mut policy = NotificationPolicy::new();
    policy
        .app_floors
        .insert("com.work.app".to_string(), AttentionDecision::Notify);

    let classifier = DeterministicClassifier::new(policy);

    let notif = test_notification(
        "com.work.app",
        "Message",
        AndroidPriority::Low, // would normally be Batch
        None,
        None,
    );

    let result = classifier.classify(&notif);
    assert!(
        result.attention >= AttentionDecision::Notify,
        "Work app should have Notify floor, got {:?}",
        result.attention
    );
}
