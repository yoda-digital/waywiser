use waywiser_delegation::*;
use std::time::Duration;

#[test]
fn budget_can_cover_smaller() {
    let parent = DelegationBudget {
        max_input_tokens: 100_000,
        max_output_tokens: 50_000,
        max_wall_time: Duration::from_secs(300),
        max_external_writes: 10,
        ..DelegationBudget::default()
    };
    let child = DelegationBudget {
        max_input_tokens: 50_000,
        max_output_tokens: 25_000,
        max_wall_time: Duration::from_secs(120),
        max_external_writes: 5,
        ..DelegationBudget::default()
    };
    assert!(parent.can_cover(&child));
}

#[test]
fn budget_cannot_cover_larger() {
    let parent = DelegationBudget {
        max_input_tokens: 50_000,
        max_output_tokens: 25_000,
        max_wall_time: Duration::from_secs(120),
        max_external_writes: 5,
        ..DelegationBudget::default()
    };
    let child = DelegationBudget {
        max_input_tokens: 100_000,
        max_output_tokens: 50_000,
        max_wall_time: Duration::from_secs(300),
        max_external_writes: 10,
        ..DelegationBudget::default()
    };
    assert!(!parent.can_cover(&child));
}

#[test]
fn cap_at_parent_remaining() {
    let requested = DelegationBudget {
        max_input_tokens: 100_000,
        max_output_tokens: 50_000,
        max_wall_time: Duration::from_secs(600),
        max_external_writes: 20,
        ..DelegationBudget::default()
    };
    let parent_remaining = DelegationBudget {
        max_input_tokens: 30_000,
        max_output_tokens: 15_000,
        max_wall_time: Duration::from_secs(120),
        max_external_writes: 3,
        ..DelegationBudget::default()
    };

    let capped = requested.cap_at(&parent_remaining);
    assert_eq!(capped.max_input_tokens, 30_000);
    assert_eq!(capped.max_output_tokens, 15_000);
    assert_eq!(capped.max_wall_time, Duration::from_secs(120));
    assert_eq!(capped.max_external_writes, 3);
}

#[test]
fn cognition_worker_budget_always_zero_writes() {
    let budget = DelegationBudget::cognition_worker();
    assert_eq!(budget.max_external_writes, 0);
    assert_eq!(budget.max_children, 0);
    assert_eq!(budget.max_depth, 0);
}

#[test]
fn verification_budget_always_zero_writes() {
    let budget = DelegationBudget::verification();
    assert_eq!(budget.max_external_writes, 0);
    assert_eq!(budget.max_children, 0);
}

#[test]
fn remaining_budget_subtracts_usage() {
    let budget = DelegationBudget {
        max_input_tokens: 100_000,
        max_output_tokens: 50_000,
        max_external_writes: 10,
        ..DelegationBudget::default()
    };
    let usage = DelegationUsage {
        children_spawned: 1,
        input_tokens_used: 30_000,
        output_tokens_used: 10_000,
        external_writes_used: 3,
        ..DelegationUsage::default()
    };
    let remaining = budget.remaining(&usage);
    assert_eq!(remaining.max_input_tokens, 70_000);
    assert_eq!(remaining.max_output_tokens, 40_000);
    assert_eq!(remaining.max_external_writes, 7);
}

#[test]
fn usage_detects_violation() {
    let budget = DelegationBudget {
        max_input_tokens: 100,
        ..DelegationBudget::default()
    };
    let usage = DelegationUsage {
        input_tokens_used: 200,
        ..DelegationUsage::default()
    };
    let violation = usage.check_violation(&budget);
    assert!(violation.is_some());
    assert!(matches!(violation.unwrap(), BudgetViolation::InputTokens { used: 200, max: 100 }));
}
