use chrono::{Duration, Utc};
use uuid::Uuid;

use pi_types::*;
use waywiser_security::*;

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
        evidence: vec![],
        idempotency_key: Uuid::now_v7().to_string(),
        requested_at: Utc::now(),
    }
}

fn test_capability(name: &str, risk: RiskLevel) -> CapabilitySpec {
    CapabilitySpec {
        name: CapabilityName(name.to_string()),
        description: format!("Test capability: {}", name),
        input_schema: serde_json::json!({}),
        output_schema: serde_json::json!({}),
        risk,
        permissions: vec![],
        side_effect: true,
        replay_policy: ReplayPolicy::VerifyBeforeRetry,
        execution_mode: ExecutionMode::InProcess,
        reversible: false,
        dry_run_support: false,
        sensitivity: Sensitivity::Internal,
        os_permission: None,
    }
}

#[test]
fn unknown_capability_denied() {
    let mut kernel = SecurityKernel::new();
    let intent = test_intent("nonexistent.capability");
    let decision = kernel.authorize(&intent);
    match decision {
        SecurityDecision::Denied(DenialReason::UnknownCapability(name)) => {
            assert_eq!(name.0, "nonexistent.capability");
        }
        other => panic!("Expected Denied(UnknownCapability), got {:?}", other),
    }
}

#[test]
fn known_read_capability_allowed() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(test_capability("device.battery", RiskLevel::ReadPersonal));
    let intent = test_intent("device.battery");
    let decision = kernel.authorize(&intent);
    match decision {
        SecurityDecision::Allowed(AuthorizationSource::DefaultPolicy) => {}
        other => panic!("Expected Allowed(DefaultPolicy), got {:?}", other),
    }
}

#[test]
fn communication_risk_requires_biometric() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(test_capability("communication.send", RiskLevel::Communication));
    let intent = test_intent("communication.send");
    let decision = kernel.authorize(&intent);
    match decision {
        SecurityDecision::RequiresApproval(ApprovalKind::BiometricConfirm) => {}
        other => panic!("Expected RequiresApproval(BiometricConfirm), got {:?}", other),
    }
}

#[test]
fn device_control_requires_user_confirm() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(test_capability("device.open_app", RiskLevel::DeviceControl));
    let intent = test_intent("device.open_app");
    let decision = kernel.authorize(&intent);
    match decision {
        SecurityDecision::RequiresApproval(ApprovalKind::UserConfirm) => {}
        other => panic!("Expected RequiresApproval(UserConfirm), got {:?}", other),
    }
}

#[test]
fn lease_authorizes_within_budget() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(test_capability("calendar.update", RiskLevel::CrossAppWrite));

    let lease = ApprovalLease::new(
        CapabilityName("calendar.update".to_string()),
        LeaseScope::unrestricted(),
        LeaseConstraints::none(),
        Utc::now() + Duration::hours(1),
        Some(5),
        GrantSource::UserExplicit,
    );
    kernel.grant_lease(lease);

    let intent = test_intent("calendar.update");
    let decision = kernel.authorize(&intent);
    match decision {
        SecurityDecision::Allowed(AuthorizationSource::Lease(_)) => {}
        other => panic!("Expected Allowed(Lease), got {:?}", other),
    }
}

#[test]
fn expired_lease_denied() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(test_capability("calendar.update", RiskLevel::CrossAppWrite));

    let lease = ApprovalLease::new(
        CapabilityName("calendar.update".to_string()),
        LeaseScope::unrestricted(),
        LeaseConstraints::none(),
        Utc::now() - Duration::hours(1), // already expired
        Some(5),
        GrantSource::UserExplicit,
    );
    kernel.grant_lease(lease);

    let intent = test_intent("calendar.update");
    let decision = kernel.authorize(&intent);
    // Should fall through to RequiresApproval since lease is expired
    match decision {
        SecurityDecision::RequiresApproval(_) => {}
        other => panic!("Expected RequiresApproval (lease expired), got {:?}", other),
    }
}

#[test]
fn every_decision_creates_audit_entry() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(test_capability("device.battery", RiskLevel::ReadPersonal));

    assert_eq!(kernel.audit_log.len(), 0);

    let intent = test_intent("device.battery");
    let _ = kernel.authorize(&intent);
    assert_eq!(kernel.audit_log.len(), 1);

    let intent2 = test_intent("nonexistent");
    let _ = kernel.authorize(&intent2);
    assert_eq!(kernel.audit_log.len(), 2);
}

#[test]
fn revoked_lease_not_used() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(test_capability("calendar.update", RiskLevel::CrossAppWrite));

    let lease = ApprovalLease::new(
        CapabilityName("calendar.update".to_string()),
        LeaseScope::unrestricted(),
        LeaseConstraints::none(),
        Utc::now() + Duration::hours(1),
        Some(5),
        GrantSource::UserExplicit,
    );
    let lease_id = kernel.grant_lease(lease);
    kernel.revoke_lease(lease_id);

    let intent = test_intent("calendar.update");
    let decision = kernel.authorize(&intent);
    match decision {
        SecurityDecision::RequiresApproval(_) => {} // falls through to approval
        other => panic!("Expected RequiresApproval (lease revoked), got {:?}", other),
    }
}
