//! Integration test: security invariants (P1/P3 acceptance criteria).

use chrono::{Duration, Utc};
use pi_types::capability::*;
use pi_types::*;
use waywiser_security::*;

fn test_intent(cap_name: &str) -> ActionIntent {
    ActionIntent::new(
        ActionOrigin::UserDirect,
        CapabilityName::new(cap_name),
        serde_json::json!({}),
        "test",
        SessionId::new(),
    )
}

fn make_spec(name: &str, risk: RiskLevel) -> CapabilitySpec {
    CapabilitySpec {
        name: CapabilityName::new(name),
        description: format!("Test capability: {}", name),
        input_schema: serde_json::json!({}),
        output_schema: serde_json::json!({}),
        risk,
        permissions: vec![],
        side_effect: risk >= RiskLevel::DeviceControl,
        replay_policy: ReplayPolicy::SafeReplay,
        execution_mode: ExecutionMode::InProcess,
        reversible: false,
        dry_run_support: false,
        sensitivity: Sensitivity::Internal,
        os_permission: None,
    }
}

#[test]
fn unknown_capability_always_denied() {
    let names = [
        "nonexistent.foo", "device.hack", "calendar.delete_all",
        "system.root", "bank.transfer", "a.b.c.d.e.f",
        "valid-looking.but.not.registered", "calendar.read.but.fake",
        "notification.send", "file.delete_recursive",
        "settings.modify_security", "app.install_unsigned",
        "automation.grant_self", "brain.override_confidence",
        "skill.self_promote", "lease.self_grant",
        "kernel.modify_policy", "soul.alter_governance",
        "some.random.cap", "another.unknown",
    ];

    let mut kernel = SecurityKernel::new();
    for name in &names {
        let intent = test_intent(name);
        let decision = kernel.authorize(&intent);
        assert!(
            matches!(decision, SecurityDecision::Denied(_)),
            "capability '{}' should be denied, got: {:?}", name, decision
        );
    }
    assert_eq!(kernel.audit_log.len(), names.len(),
        "every authorization must create an audit entry");
}

#[test]
fn risk_never_decreases_through_classifier_layers() {
    let classifier = RiskClassifier::with_defaults();

    let test_cases = [
        ("com.example.app", PrimitiveActionKind::InspectTree, "view"),
        ("com.example.app", PrimitiveActionKind::Click, "ok"),
        ("com.example.app", PrimitiveActionKind::TypeText, "hello"),
        ("com.example.app", PrimitiveActionKind::Scroll, "scroll"),
        ("com.example.app", PrimitiveActionKind::Click, "send"),
        ("com.example.app", PrimitiveActionKind::Click, "delete"),
        ("com.example.app", PrimitiveActionKind::Click, "pay now"),
        ("com.example.app", PrimitiveActionKind::Click, "save"),
        ("com.android.settings", PrimitiveActionKind::Click, "toggle"),
        ("com.example.app", PrimitiveActionKind::Paste, "paste text"),
    ];

    for (package, action, text) in &test_cases {
        let req = ClassificationRequest {
            package: package.to_string(),
            node_text: text.to_string(),
            action: *action,
            llm_hint: None,
        };
        let result = classifier.classify(&req);
        let mut prev_risk = RiskLevel::None;
        for ld in &result.layer_trace {
            assert!(ld.risk_at >= prev_risk,
                "risk decreased from {:?} to {:?} at {:?} for ({}, {:?}, {})",
                prev_risk, ld.risk_at, ld.layer, package, action, text);
            prev_risk = ld.risk_at;
        }
        if let Some(last) = result.layer_trace.last() {
            assert_eq!(result.final_risk, last.risk_at);
        }
    }
}

#[test]
fn llm_hint_never_lowers_risk() {
    let classifier = RiskClassifier::with_defaults();

    let req_no_hint = ClassificationRequest {
        package: "com.example.app".into(),
        node_text: "send message".into(),
        action: PrimitiveActionKind::Click,
        llm_hint: None,
    };
    let result_no_hint = classifier.classify(&req_no_hint);

    let req_with_hint = ClassificationRequest {
        package: "com.example.app".into(),
        node_text: "send message".into(),
        action: PrimitiveActionKind::Click,
        llm_hint: Some(LlmRiskHint {
            suggested_risk: RiskLevel::None,
            reasoning: Some("seems safe".into()),
        }),
    };
    let result_with_hint = classifier.classify(&req_with_hint);

    assert!(result_with_hint.final_risk >= result_no_hint.final_risk,
        "LLM hint must not lower risk: without={:?}, with={:?}",
        result_no_hint.final_risk, result_with_hint.final_risk);
    assert!(!result_with_hint.llm_hint_used);
}

#[test]
fn lease_authorizes_within_budget() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(make_spec("calendar.update", RiskLevel::CrossAppWrite));

    let lease = ApprovalLease::new(
        CapabilityName::new("calendar.update"),
        LeaseScope::unrestricted(),
        LeaseConstraints::none(),
        Utc::now() + Duration::hours(1),
        Some(3),
        GrantSource::UserExplicit,
    );
    kernel.grant_lease(lease);

    for i in 0..3 {
        let decision = kernel.authorize(&test_intent("calendar.update"));
        assert!(matches!(decision, SecurityDecision::Allowed(AuthorizationSource::Lease(_))),
            "execution {} should be authorized by lease, got: {:?}", i + 1, decision);
    }

    let decision = kernel.authorize(&test_intent("calendar.update"));
    assert!(matches!(decision, SecurityDecision::RequiresApproval(_)),
        "4th execution should require approval, got: {:?}", decision);
}

#[test]
fn expired_lease_denied() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(make_spec("calendar.update", RiskLevel::CrossAppWrite));

    let lease = ApprovalLease::new(
        CapabilityName::new("calendar.update"),
        LeaseScope::unrestricted(),
        LeaseConstraints::none(),
        Utc::now() - Duration::hours(1),
        Some(10),
        GrantSource::UserExplicit,
    );
    kernel.grant_lease(lease);

    let decision = kernel.authorize(&test_intent("calendar.update"));
    assert!(matches!(decision, SecurityDecision::RequiresApproval(_)),
        "expired lease should not authorize, got: {:?}", decision);
}

#[test]
fn revoked_lease_denied() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(make_spec("calendar.update", RiskLevel::CrossAppWrite));

    let lease = ApprovalLease::new(
        CapabilityName::new("calendar.update"),
        LeaseScope::unrestricted(),
        LeaseConstraints::none(),
        Utc::now() + Duration::hours(1),
        Some(10),
        GrantSource::UserExplicit,
    );
    let lease_id = kernel.grant_lease(lease);

    assert!(matches!(kernel.authorize(&test_intent("calendar.update")),
        SecurityDecision::Allowed(_)));
    assert!(kernel.revoke_lease(lease_id));

    let decision = kernel.authorize(&test_intent("calendar.update"));
    assert!(matches!(decision, SecurityDecision::RequiresApproval(_)),
        "revoked lease should not authorize, got: {:?}", decision);
}

#[test]
fn every_authorization_creates_audit_entry() {
    let mut kernel = SecurityKernel::new();
    kernel.register_capability(make_spec("device.battery", RiskLevel::ReadPersonal));
    kernel.register_capability(make_spec("calendar.update", RiskLevel::CrossAppWrite));

    kernel.authorize(&test_intent("device.battery"));
    kernel.authorize(&test_intent("nonexistent"));
    kernel.authorize(&test_intent("calendar.update"));
    kernel.authorize(&test_intent("also.nonexistent"));
    kernel.authorize(&test_intent("device.battery"));

    assert_eq!(kernel.audit_log.len(), 5);
}

#[test]
fn toctou_exact_match_passes() {
    use waywiser_security::toctou::Rect;

    let fp = NodeFingerprint {
        package: "com.test.app".into(),
        window_id: 1,
        resource_id: Some("com.test.app:id/button".into()),
        class_name: "android.widget.Button".into(),
        role: None,
        normalized_text: Some("Send".into()),
        content_description: None,
        ancestor_signature: vec!["LinearLayout".into()],
        state: None,
        approximate_bounds: Rect { left: 0, top: 0, right: 100, bottom: 50 },
    };
    let fp2 = fp.clone();
    assert!(matches!(fp.compare(&fp2), FingerprintMatch::Exact));
}

#[test]
fn toctou_text_change_detected() {
    use waywiser_security::toctou::Rect;

    let fp1 = NodeFingerprint {
        package: "com.test.app".into(),
        window_id: 1,
        resource_id: Some("com.test.app:id/button".into()),
        class_name: "android.widget.Button".into(),
        role: None,
        normalized_text: Some("Send".into()),
        content_description: None,
        ancestor_signature: vec!["LinearLayout".into()],
        state: None,
        approximate_bounds: Rect { left: 0, top: 0, right: 100, bottom: 50 },
    };

    let mut fp2 = fp1.clone();
    fp2.normalized_text = Some("Cancel".into());

    assert!(matches!(fp1.compare(&fp2), FingerprintMatch::Partial { .. }),
        "text change should be detected");
}
