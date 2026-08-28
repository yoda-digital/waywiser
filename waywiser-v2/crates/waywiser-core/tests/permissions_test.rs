//! Tests for PermissionService — capability registry with risk-based authorization.

use chrono::Utc;
use pi_types::*;
use uuid::Uuid;
use waywiser_core::permissions::{PermissionDecision, PermissionService};

fn test_capability(name: &str, risk: RiskLevel) -> CapabilitySpec {
    CapabilitySpec {
        name: CapabilityName(name.to_string()),
        description: format!("Test capability: {}", name),
        input_schema: serde_json::json!({}),
        output_schema: serde_json::json!({}),
        risk,
        permissions: Vec::new(),
        side_effect: risk > RiskLevel::ReadPersonal,
        replay_policy: ReplayPolicy::VerifyBeforeRetry,
        execution_mode: ExecutionMode::InProcess,
        reversible: false,
        dry_run_support: false,
        sensitivity: Sensitivity::Internal,
        os_permission: None,
    }
}

fn test_intent(capability: &str) -> ActionIntent {
    ActionIntent {
        id: Uuid::now_v7(),
        origin: ActionOrigin::UserDirect,
        capability: CapabilityName(capability.to_string()),
        arguments: serde_json::json!({}),
        reason: "test".to_string(),
        session_id: SessionId(Uuid::now_v7()),
        goal_id: None,
        work_item_id: None,
        evidence: Vec::new(),
        idempotency_key: Uuid::now_v7().to_string(),
        requested_at: Utc::now(),
    }
}

#[test]
fn test_unknown_capability_denied() {
    let service = PermissionService::new();
    let intent = test_intent("unknown.capability");

    match service.evaluate(&intent) {
        PermissionDecision::Denied { reason } => {
            assert!(reason.contains("Unknown capability"));
            assert!(reason.contains("I9"));
        }
        other => panic!("Expected Denied, got {:?}", other),
    }
}

#[test]
fn test_read_personal_allowed() {
    let mut service = PermissionService::new();
    service.register_capability(test_capability("device.battery", RiskLevel::ReadPersonal));

    let intent = test_intent("device.battery");
    match service.evaluate(&intent) {
        PermissionDecision::Allowed => {} // expected
        other => panic!("Expected Allowed, got {:?}", other),
    }
}

#[test]
fn test_none_risk_allowed() {
    let mut service = PermissionService::new();
    service.register_capability(test_capability("system.time", RiskLevel::None));

    let intent = test_intent("system.time");
    match service.evaluate(&intent) {
        PermissionDecision::Allowed => {}
        other => panic!("Expected Allowed, got {:?}", other),
    }
}

#[test]
fn test_device_control_requires_approval() {
    let mut service = PermissionService::new();
    service.register_capability(test_capability("device.wifi.toggle", RiskLevel::DeviceControl));

    let intent = test_intent("device.wifi.toggle");
    match service.evaluate(&intent) {
        PermissionDecision::RequiresApproval { risk, .. } => {
            assert_eq!(risk, RiskLevel::DeviceControl);
        }
        other => panic!("Expected RequiresApproval, got {:?}", other),
    }
}

#[test]
fn test_communication_requires_approval() {
    let mut service = PermissionService::new();
    service.register_capability(test_capability("communication.send", RiskLevel::Communication));

    let intent = test_intent("communication.send");
    match service.evaluate(&intent) {
        PermissionDecision::RequiresApproval { risk, reason } => {
            assert_eq!(risk, RiskLevel::Communication);
            assert!(reason.contains("biometric"));
        }
        other => panic!("Expected RequiresApproval, got {:?}", other),
    }
}

#[test]
fn test_financial_requires_approval() {
    let mut service = PermissionService::new();
    service.register_capability(test_capability("payment.transfer", RiskLevel::Financial));

    let intent = test_intent("payment.transfer");
    match service.evaluate(&intent) {
        PermissionDecision::RequiresApproval { risk, .. } => {
            assert_eq!(risk, RiskLevel::Financial);
        }
        other => panic!("Expected RequiresApproval, got {:?}", other),
    }
}

#[test]
fn test_destructive_requires_approval() {
    let mut service = PermissionService::new();
    service.register_capability(test_capability("data.delete", RiskLevel::Destructive));

    let intent = test_intent("data.delete");
    match service.evaluate(&intent) {
        PermissionDecision::RequiresApproval { risk, .. } => {
            assert_eq!(risk, RiskLevel::Destructive);
        }
        other => panic!("Expected RequiresApproval, got {:?}", other),
    }
}

#[test]
fn test_capability_count() {
    let mut service = PermissionService::new();
    assert_eq!(service.capability_count(), 0);

    service.register_capability(test_capability("a", RiskLevel::None));
    service.register_capability(test_capability("b", RiskLevel::None));
    assert_eq!(service.capability_count(), 2);
}

#[test]
fn test_get_capability() {
    let mut service = PermissionService::new();
    service.register_capability(test_capability("device.battery", RiskLevel::ReadPersonal));

    let cap = service.get_capability(&CapabilityName("device.battery".to_string()));
    assert!(cap.is_some());
    assert_eq!(cap.unwrap().risk, RiskLevel::ReadPersonal);

    let cap = service.get_capability(&CapabilityName("nonexistent".to_string()));
    assert!(cap.is_none());
}
