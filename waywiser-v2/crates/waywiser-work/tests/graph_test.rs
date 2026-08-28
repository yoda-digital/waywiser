use pi_types::WorkItemId;
use std::collections::HashSet;
use uuid::Uuid;
use waywiser_work::DependencyGraph;

fn wid() -> WorkItemId {
    WorkItemId(Uuid::now_v7())
}

#[test]
fn empty_graph_sorts_empty() {
    let g = DependencyGraph::new();
    let sorted = g.topological_sort().unwrap();
    assert!(sorted.is_empty());
}

#[test]
fn single_item_no_deps() {
    let mut g = DependencyGraph::new();
    let a = wid();
    g.add_item(a, vec![]);
    let sorted = g.topological_sort().unwrap();
    assert_eq!(sorted, vec![a]);
}

#[test]
fn linear_chain() {
    let mut g = DependencyGraph::new();
    let a = wid();
    let b = wid();
    let c = wid();
    g.add_item(a, vec![]);
    g.add_item(b, vec![a]);
    g.add_item(c, vec![b]);
    let sorted = g.topological_sort().unwrap();
    let pos_a = sorted.iter().position(|x| *x == a).unwrap();
    let pos_b = sorted.iter().position(|x| *x == b).unwrap();
    let pos_c = sorted.iter().position(|x| *x == c).unwrap();
    assert!(pos_a < pos_b);
    assert!(pos_b < pos_c);
}

#[test]
fn diamond_shape() {
    let mut g = DependencyGraph::new();
    let a = wid();
    let b = wid();
    let c = wid();
    let d = wid();
    g.add_item(a, vec![]);
    g.add_item(b, vec![a]);
    g.add_item(c, vec![a]);
    g.add_item(d, vec![b, c]);
    let sorted = g.topological_sort().unwrap();
    let pos_a = sorted.iter().position(|x| *x == a).unwrap();
    let pos_b = sorted.iter().position(|x| *x == b).unwrap();
    let pos_c = sorted.iter().position(|x| *x == c).unwrap();
    let pos_d = sorted.iter().position(|x| *x == d).unwrap();
    assert!(pos_a < pos_b);
    assert!(pos_a < pos_c);
    assert!(pos_b < pos_d);
    assert!(pos_c < pos_d);
}

#[test]
fn cycle_detected() {
    let mut g = DependencyGraph::new();
    let a = wid();
    let b = wid();
    g.add_item(a, vec![b]);
    g.add_item(b, vec![a]);
    assert!(g.detect_cycle().is_some());
    assert!(g.topological_sort().is_err());
}

#[test]
fn three_node_cycle() {
    let mut g = DependencyGraph::new();
    let a = wid();
    let b = wid();
    let c = wid();
    g.add_item(a, vec![c]);
    g.add_item(b, vec![a]);
    g.add_item(c, vec![b]);
    assert!(g.detect_cycle().is_some());
}

#[test]
fn no_cycle_in_dag() {
    let mut g = DependencyGraph::new();
    let a = wid();
    let b = wid();
    let c = wid();
    g.add_item(a, vec![]);
    g.add_item(b, vec![a]);
    g.add_item(c, vec![a, b]);
    assert!(g.detect_cycle().is_none());
}

#[test]
fn dependencies_met_all_completed() {
    let mut g = DependencyGraph::new();
    let a = wid();
    let b = wid();
    let c = wid();
    g.add_item(a, vec![]);
    g.add_item(b, vec![]);
    g.add_item(c, vec![a, b]);

    let mut completed = HashSet::new();
    completed.insert(a);
    completed.insert(b);
    assert!(g.dependencies_met(&c, &completed));
}

#[test]
fn dependencies_met_partial() {
    let mut g = DependencyGraph::new();
    let a = wid();
    let b = wid();
    let c = wid();
    g.add_item(a, vec![]);
    g.add_item(b, vec![]);
    g.add_item(c, vec![a, b]);

    let mut completed = HashSet::new();
    completed.insert(a);
    // b not completed
    assert!(!g.dependencies_met(&c, &completed));
}

#[test]
fn dependencies_met_no_deps() {
    let mut g = DependencyGraph::new();
    let a = wid();
    g.add_item(a, vec![]);
    assert!(g.dependencies_met(&a, &HashSet::new()));
}

#[test]
fn remove_item_cleans_edges() {
    let mut g = DependencyGraph::new();
    let a = wid();
    let b = wid();
    let c = wid();
    g.add_item(a, vec![]);
    g.add_item(b, vec![a]);
    g.add_item(c, vec![b]);
    g.remove_item(&b);
    // c no longer depends on b
    assert!(g.dependencies_met(&c, &HashSet::new()));
}
