use waywiser_security::*;
use pi_types::RiskLevel;

fn classify_text(classifier: &RiskClassifier, text: &str, action: PrimitiveActionKind) -> ClassificationResult {
    classifier.classify(&ClassificationRequest {
        package: "com.example.app".to_string(),
        node_text: text.to_string(),
        action,
        llm_hint: None,
    })
}

#[test]
fn send_button_classified_as_communication() {
    let classifier = RiskClassifier::with_defaults();
    let result = classify_text(&classifier, "Send", PrimitiveActionKind::Click);
    assert!(result.final_risk >= RiskLevel::Communication);
}

#[test]
fn delete_button_classified_as_destructive() {
    let classifier = RiskClassifier::with_defaults();
    let result = classify_text(&classifier, "Delete message", PrimitiveActionKind::Click);
    assert!(result.final_risk >= RiskLevel::Destructive);
}

#[test]
fn pay_button_classified_as_financial() {
    let classifier = RiskClassifier::with_defaults();
    let result = classify_text(&classifier, "Pay now", PrimitiveActionKind::Click);
    assert!(result.final_risk >= RiskLevel::Financial);
}

#[test]
fn save_button_classified_as_cross_app_write() {
    let classifier = RiskClassifier::with_defaults();
    let result = classify_text(&classifier, "Save changes", PrimitiveActionKind::Click);
    assert!(result.final_risk >= RiskLevel::CrossAppWrite);
}

#[test]
fn banking_package_blocked() {
    let classifier = RiskClassifier::with_defaults();
    let result = classifier.classify(&ClassificationRequest {
        package: "com.example.bank".to_string(),
        node_text: "Transfer".to_string(),
        action: PrimitiveActionKind::Click,
        llm_hint: None,
    });
    assert!(result.blocked, "Banking app should be blocked");
}

#[test]
fn typing_text_has_cross_app_write_floor() {
    let classifier = RiskClassifier::with_defaults();
    let result = classify_text(&classifier, "Input field", PrimitiveActionKind::TypeText);
    assert!(result.final_risk >= RiskLevel::CrossAppWrite);
}

#[test]
fn scroll_has_read_personal_floor() {
    let classifier = RiskClassifier::with_defaults();
    let result = classify_text(&classifier, "", PrimitiveActionKind::Scroll);
    assert!(result.final_risk >= RiskLevel::ReadPersonal);
}

#[test]
fn risk_never_decreases_through_layers() {
    let classifier = RiskClassifier::with_defaults();

    // Run many classifications and verify risk monotonicity in each trace
    let packages = ["com.example.app", "com.android.settings", "com.unknown.app"];
    let texts = ["Send", "Delete", "Pay", "Save", "OK", "Cancel", "", "Open"];
    let actions = [
        PrimitiveActionKind::Click,
        PrimitiveActionKind::TypeText,
        PrimitiveActionKind::Scroll,
        PrimitiveActionKind::Toggle,
        PrimitiveActionKind::InspectTree,
    ];

    for package in &packages {
        for text in &texts {
            for action in &actions {
                let result = classifier.classify(&ClassificationRequest {
                    package: package.to_string(),
                    node_text: text.to_string(),
                    action: *action,
                    llm_hint: None,
                });

                // Verify risk never decreases across layers
                let mut prev_risk = RiskLevel::None;
                for layer in &result.layer_trace {
                    assert!(
                        layer.risk_at >= prev_risk,
                        "Risk decreased from {:?} to {:?} at layer {:?} for package={}, text={}, action={:?}",
                        prev_risk,
                        layer.risk_at,
                        layer.layer,
                        package,
                        text,
                        action,
                    );
                    prev_risk = layer.risk_at;
                }
            }
        }
    }
}

#[test]
fn llm_hint_never_used_for_final_risk() {
    let classifier = RiskClassifier::with_defaults();
    let result = classifier.classify(&ClassificationRequest {
        package: "com.example.app".to_string(),
        node_text: "Send".to_string(),
        action: PrimitiveActionKind::Click,
        llm_hint: Some(LlmRiskHint {
            suggested_risk: RiskLevel::ReadPersonal, // tries to lower
            reasoning: Some("harmless send".to_string()),
        }),
    });
    assert!(!result.llm_hint_used, "LLM hint should never be authoritative");
    assert!(result.final_risk >= RiskLevel::Communication, "LLM hint should not lower risk");
}

#[test]
fn unknown_action_gets_unclassified_write() {
    let classifier = RiskClassifier::empty(); // no rules at all
    let result = classify_text(&classifier, "", PrimitiveActionKind::Gesture);
    assert_eq!(result.final_risk, RiskLevel::UiUnclassifiedWrite);
}

#[test]
fn settings_package_has_device_control_floor() {
    let classifier = RiskClassifier::with_defaults();
    let result = classifier.classify(&ClassificationRequest {
        package: "com.android.settings".to_string(),
        node_text: "OK".to_string(),
        action: PrimitiveActionKind::Click,
        llm_hint: None,
    });
    assert!(result.final_risk >= RiskLevel::DeviceControl);
}
