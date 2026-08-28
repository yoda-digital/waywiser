use pi_types::AgentId;
use waywiser_delegation::*;

fn make_supervisor() -> AgentSupervisor {
    AgentSupervisor::new(
        AgentId::new(),
        AgentClass::Primary,
        DelegationBudget::default(),
    )
}

fn make_context() -> FocusedContext {
    FocusedContext::new("Test task".to_string())
}

#[test]
fn spawn_child_appears_in_children() {
    let mut sup = make_supervisor();
    let ctx = make_context();
    let budget = DelegationBudget {
        max_input_tokens: 10_000,
        max_output_tokens: 5_000,
        ..DelegationBudget::default()
    };
    let id = sup.spawn(AgentClass::Leaf, ctx, budget, None).unwrap();
    assert_eq!(sup.children.len(), 1);
    assert_eq!(sup.children[0].id, id);
    assert!(sup.children[0].is_active());
}

#[test]
fn spawn_exceeds_max_children() {
    let mut sup = AgentSupervisor::new(
        AgentId::new(),
        AgentClass::Primary,
        DelegationBudget {
            max_children: 2,
            max_input_tokens: 1_000_000,
            max_output_tokens: 500_000,
            max_external_writes: 100,
            ..DelegationBudget::default()
        },
    );

    let small_budget = DelegationBudget {
        max_input_tokens: 1_000,
        max_output_tokens: 500,
        max_external_writes: 1,
        ..DelegationBudget::default()
    };

    sup.spawn(AgentClass::Leaf, make_context(), small_budget.clone(), None)
        .unwrap();
    sup.spawn(AgentClass::Leaf, make_context(), small_budget.clone(), None)
        .unwrap();

    let err = sup
        .spawn(AgentClass::Leaf, make_context(), small_budget, None)
        .unwrap_err();
    assert!(matches!(err, DelegationError::MaxChildrenExceeded { .. }));
}

#[test]
fn spawn_exceeds_depth() {
    let mut sup = AgentSupervisor::with_depth(
        AgentId::new(),
        AgentClass::Orchestrator,
        DelegationBudget::default(),
        2, // already at max depth
    );

    let err = sup
        .spawn(
            AgentClass::Leaf,
            make_context(),
            DelegationBudget {
                max_input_tokens: 1_000,
                max_output_tokens: 500,
                max_external_writes: 1,
                ..DelegationBudget::default()
            },
            None,
        )
        .unwrap_err();
    assert!(matches!(err, DelegationError::MaxDepthExceeded { .. }));
}

#[test]
fn leaf_cannot_delegate() {
    let mut sup = AgentSupervisor::new(
        AgentId::new(),
        AgentClass::Leaf,
        DelegationBudget::default(),
    );

    let err = sup
        .spawn(
            AgentClass::Leaf,
            make_context(),
            DelegationBudget::default(),
            None,
        )
        .unwrap_err();
    assert!(matches!(err, DelegationError::CannotDelegate(AgentClass::Leaf)));
}

#[test]
fn cancel_child() {
    let mut sup = make_supervisor();
    let budget = DelegationBudget {
        max_input_tokens: 10_000,
        max_output_tokens: 5_000,
        ..DelegationBudget::default()
    };
    let id = sup.spawn(AgentClass::Leaf, make_context(), budget, None).unwrap();
    sup.cancel(id).unwrap();
    assert!(matches!(
        sup.get_status(id),
        Some(ChildAgentStatus::Cancelled)
    ));
}

#[test]
fn complete_child() {
    let mut sup = make_supervisor();
    let budget = DelegationBudget {
        max_input_tokens: 10_000,
        max_output_tokens: 5_000,
        ..DelegationBudget::default()
    };
    let id = sup.spawn(AgentClass::Leaf, make_context(), budget, None).unwrap();

    let result = AgentResult {
        summary: "done".to_string(),
        artifacts: vec![],
        tokens_used: 100,
        wall_time: std::time::Duration::from_secs(5),
    };
    sup.complete_child(id, result).unwrap();
    assert!(matches!(
        sup.get_status(id),
        Some(ChildAgentStatus::Completed(_))
    ));
}

#[test]
fn cancel_already_cancelled_fails() {
    let mut sup = make_supervisor();
    let budget = DelegationBudget {
        max_input_tokens: 10_000,
        max_output_tokens: 5_000,
        ..DelegationBudget::default()
    };
    let id = sup.spawn(AgentClass::Leaf, make_context(), budget, None).unwrap();
    sup.cancel(id).unwrap();
    assert!(matches!(
        sup.cancel(id),
        Err(DelegationError::AgentNotActive(_))
    ));
}

#[test]
fn schedule_next_returns_highest_priority() {
    let mut sup = AgentSupervisor::new(
        AgentId::new(),
        AgentClass::Primary,
        DelegationBudget {
            max_input_tokens: 500_000,
            max_output_tokens: 250_000,
            max_external_writes: 100,
            max_wall_time: std::time::Duration::from_secs(3600),
            ..DelegationBudget::default()
        },
    );
    let small_budget = DelegationBudget {
        max_input_tokens: 10_000,
        max_output_tokens: 5_000,
        max_external_writes: 1,
        max_wall_time: std::time::Duration::from_secs(120),
        ..DelegationBudget::default()
    };

    let leaf_id = sup
        .spawn(AgentClass::Leaf, make_context(), small_budget, None)
        .unwrap();
    let cognition_id = sup
        .spawn(
            AgentClass::CognitionWorker,
            make_context(),
            DelegationBudget::cognition_worker(),
            None,
        )
        .unwrap();

    // Set both to WaitingForInference
    sup.children.iter_mut().for_each(|c| {
        c.status = ChildAgentStatus::WaitingForInference;
    });

    // Leaf (priority 2) should be scheduled before CognitionWorker (priority 3)
    let next = sup.schedule_next().unwrap();
    assert_eq!(next, leaf_id);
    assert_ne!(next, cognition_id);
}

#[test]
fn cognition_worker_has_zero_external_writes() {
    let mut sup = make_supervisor();
    let id = sup
        .spawn(
            AgentClass::CognitionWorker,
            make_context(),
            DelegationBudget::default(),
            None,
        )
        .unwrap();
    let child = sup.children.iter().find(|c| c.id == id).unwrap();
    assert_eq!(child.budget.max_external_writes, 0);
    assert_eq!(child.budget.max_children, 0);
}

#[test]
fn active_count_excludes_terminal() {
    let mut sup = AgentSupervisor::new(
        AgentId::new(),
        AgentClass::Primary,
        DelegationBudget {
            max_input_tokens: 500_000,
            max_output_tokens: 250_000,
            max_external_writes: 100,
            ..DelegationBudget::default()
        },
    );
    let budget = DelegationBudget {
        max_input_tokens: 10_000,
        max_output_tokens: 5_000,
        max_external_writes: 1,
        ..DelegationBudget::default()
    };
    let id1 = sup.spawn(AgentClass::Leaf, make_context(), budget.clone(), None).unwrap();
    let _id2 = sup.spawn(AgentClass::Leaf, make_context(), budget, None).unwrap();

    assert_eq!(sup.active_count(), 2);
    sup.cancel(id1).unwrap();
    assert_eq!(sup.active_count(), 1);
}
