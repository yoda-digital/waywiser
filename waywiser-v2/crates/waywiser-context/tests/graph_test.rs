use chrono::{Duration, Utc};
use pi_types::ObservationSource;
use waywiser_context::{
    ContextDomain, ContextGraph, ContextNode, DeviceContext, NetworkState, ScreenState,
    ThermalState, UserContext, ActivityState,
};

fn make_user_node(activity: ActivityState) -> ContextNode {
    ContextNode {
        domain: ContextDomain::User(UserContext {
            activity: Some(activity),
            audio_route: None,
            place_context: None,
            next_event: None,
            attention_state: None,
        }),
        updated_at: Utc::now(),
        expires_at: Some(Utc::now() + Duration::minutes(5)),
        source: ObservationSource::Android,
    }
}

fn make_device_node(battery: u8) -> ContextNode {
    ContextNode {
        domain: ContextDomain::Device(DeviceContext {
            battery_pct: battery,
            charging: false,
            network: NetworkState::Wifi,
            thermal: ThermalState::Nominal,
            screen: ScreenState::On,
        }),
        updated_at: Utc::now(),
        expires_at: Some(Utc::now() + Duration::minutes(10)),
        source: ObservationSource::Android,
    }
}

#[test]
fn test_new_graph_is_empty() {
    let graph = ContextGraph::new();
    assert!(graph.is_empty());
    assert_eq!(graph.len(), 0);
}

#[test]
fn test_update_and_get() {
    let mut graph = ContextGraph::new();
    graph.update("user.activity", make_user_node(ActivityState::Walking));

    assert!(graph.has_node("user.activity"));
    assert!(!graph.has_node("user.audio_route"));

    let node = graph.get("user.activity").unwrap();
    match &node.domain {
        ContextDomain::User(u) => assert_eq!(u.activity, Some(ActivityState::Walking)),
        _ => panic!("expected User domain"),
    }
}

#[test]
fn test_update_overwrites() {
    let mut graph = ContextGraph::new();
    graph.update("device.battery", make_device_node(80));
    graph.update("device.battery", make_device_node(42));

    assert_eq!(graph.len(), 1);
    let node = graph.get("device.battery").unwrap();
    match &node.domain {
        ContextDomain::Device(d) => assert_eq!(d.battery_pct, 42),
        _ => panic!("expected Device domain"),
    }
}

#[test]
fn test_remove_expired() {
    let mut graph = ContextGraph::new();

    // Node that expires in the past
    graph.update(
        "old",
        ContextNode {
            domain: ContextDomain::User(UserContext::empty()),
            updated_at: Utc::now() - Duration::hours(1),
            expires_at: Some(Utc::now() - Duration::minutes(5)),
            source: ObservationSource::Android,
        },
    );

    // Node that expires in the future
    graph.update(
        "new",
        ContextNode {
            domain: ContextDomain::User(UserContext::empty()),
            updated_at: Utc::now(),
            expires_at: Some(Utc::now() + Duration::minutes(30)),
            source: ObservationSource::Android,
        },
    );

    // Node with no expiry (lives forever)
    graph.update(
        "permanent",
        ContextNode {
            domain: ContextDomain::User(UserContext::empty()),
            updated_at: Utc::now(),
            expires_at: None,
            source: ObservationSource::Android,
        },
    );

    assert_eq!(graph.len(), 3);
    let removed = graph.remove_expired(Utc::now());
    assert_eq!(removed, 1);
    assert_eq!(graph.len(), 2);
    assert!(!graph.has_node("old"));
    assert!(graph.has_node("new"));
    assert!(graph.has_node("permanent"));
}

#[test]
fn test_snapshot() {
    let mut graph = ContextGraph::new();
    graph.update("user.activity", make_user_node(ActivityState::Driving));
    graph.update("device.battery", make_device_node(55));

    let snapshot = graph.snapshot();
    assert_eq!(snapshot.len(), 2);
    assert!(!snapshot.is_empty());

    let keys: Vec<&str> = snapshot.nodes.iter().map(|(k, _)| k.as_str()).collect();
    assert!(keys.contains(&"user.activity"));
    assert!(keys.contains(&"device.battery"));
}

#[test]
fn test_all_nodes() {
    let mut graph = ContextGraph::new();
    graph.update("a", make_user_node(ActivityState::Stationary));
    graph.update("b", make_device_node(99));

    let all = graph.all_nodes();
    assert_eq!(all.len(), 2);
}

#[test]
fn test_remove_node() {
    let mut graph = ContextGraph::new();
    graph.update("user.activity", make_user_node(ActivityState::Running));
    assert!(graph.has_node("user.activity"));

    let removed = graph.remove("user.activity");
    assert!(removed.is_some());
    assert!(!graph.has_node("user.activity"));

    let removed_again = graph.remove("user.activity");
    assert!(removed_again.is_none());
}
