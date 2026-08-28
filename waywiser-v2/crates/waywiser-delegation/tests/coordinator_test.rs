use pi_types::{AgentId, WorkItemId};
use waywiser_delegation::*;

fn make_coordinator() -> AgentCoordinator {
    AgentCoordinator::new()
}

#[test]
fn claim_work_item_succeeds() {
    let mut coord = make_coordinator();
    let agent = AgentId::new();
    let item = WorkItemId::new();
    assert!(coord.claim_work_item(agent, item).is_ok());
    assert_eq!(coord.work_item_holder(&item), Some(agent));
}

#[test]
fn double_claim_by_same_agent_succeeds() {
    let mut coord = make_coordinator();
    let agent = AgentId::new();
    let item = WorkItemId::new();
    coord.claim_work_item(agent, item).unwrap();
    assert!(coord.claim_work_item(agent, item).is_ok());
}

#[test]
fn double_claim_by_different_agent_fails() {
    let mut coord = make_coordinator();
    let agent1 = AgentId::new();
    let agent2 = AgentId::new();
    let item = WorkItemId::new();
    coord.claim_work_item(agent1, item).unwrap();
    let err = coord.claim_work_item(agent2, item).unwrap_err();
    assert_eq!(err.holder, agent1);
    assert_eq!(err.item, item);
}

#[test]
fn release_allows_reclaim() {
    let mut coord = make_coordinator();
    let agent1 = AgentId::new();
    let agent2 = AgentId::new();
    let item = WorkItemId::new();
    coord.claim_work_item(agent1, item).unwrap();
    coord.release_work_item(&item);
    assert!(coord.claim_work_item(agent2, item).is_ok());
}

#[test]
fn depth_check_at_root_succeeds() {
    let mut coord = make_coordinator();
    let agent = AgentId::new();
    coord.register_agent(agent, None, 0, DelegationBudget::default());
    assert!(coord.check_depth(agent).is_ok());
}

#[test]
fn depth_check_at_depth_1_succeeds() {
    let mut coord = make_coordinator();
    let agent = AgentId::new();
    coord.register_agent(agent, None, 1, DelegationBudget::default());
    assert!(coord.check_depth(agent).is_ok());
}

#[test]
fn depth_check_at_depth_2_fails() {
    let mut coord = make_coordinator();
    let agent = AgentId::new();
    coord.register_agent(agent, None, 2, DelegationBudget::default());
    let err = coord.check_depth(agent).unwrap_err();
    assert_eq!(err.current, 2);
    assert_eq!(err.max, 2);
}

#[test]
fn budget_cascading_caps_at_parent() {
    let mut coord = make_coordinator();
    let parent = AgentId::new();
    coord.register_agent(
        parent,
        None,
        0,
        DelegationBudget {
            max_input_tokens: 50_000,
            max_output_tokens: 25_000,
            ..DelegationBudget::default()
        },
    );

    let requested = DelegationBudget {
        max_input_tokens: 30_000,
        max_output_tokens: 15_000,
        ..DelegationBudget::default()
    };

    let result = coord.allocate_child_budget(parent, &requested).unwrap();
    assert_eq!(result.max_input_tokens, 30_000);
    assert_eq!(result.max_output_tokens, 15_000);
}

#[test]
fn budget_cascading_fails_if_insufficient() {
    let mut coord = make_coordinator();
    let parent = AgentId::new();
    coord.register_agent(
        parent,
        None,
        0,
        DelegationBudget {
            max_input_tokens: 10_000,
            max_output_tokens: 5_000,
            ..DelegationBudget::default()
        },
    );

    let requested = DelegationBudget {
        max_input_tokens: 50_000,
        ..DelegationBudget::default()
    };

    let err = coord.allocate_child_budget(parent, &requested).unwrap_err();
    assert!(matches!(err, BudgetError::InsufficientParentBudget));
}

#[test]
fn unregister_releases_work_items() {
    let mut coord = make_coordinator();
    let agent = AgentId::new();
    let item = WorkItemId::new();
    coord.register_agent(agent, None, 0, DelegationBudget::default());
    coord.claim_work_item(agent, item).unwrap();
    coord.unregister_agent(&agent);
    assert_eq!(coord.work_item_holder(&item), None);
}
