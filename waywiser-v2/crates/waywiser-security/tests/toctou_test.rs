use pi_types::RiskLevel;
use waywiser_security::toctou::*;

fn base_fingerprint() -> NodeFingerprint {
    NodeFingerprint {
        package: "com.example.app".to_string(),
        window_id: 1,
        resource_id: Some("com.example.app:id/send_button".to_string()),
        class_name: "android.widget.Button".to_string(),
        role: Some("button".to_string()),
        normalized_text: Some("Send".to_string()),
        content_description: Some("Send message".to_string()),
        ancestor_signature: vec![
            "android.widget.LinearLayout".to_string(),
            "android.widget.FrameLayout".to_string(),
        ],
        state: Some("enabled".to_string()),
        approximate_bounds: Rect {
            left: 100,
            top: 200,
            right: 300,
            bottom: 250,
        },
    }
}

#[test]
fn exact_match_passes() {
    let fp1 = base_fingerprint();
    let fp2 = base_fingerprint();
    let comparison = fp1.compare(&fp2);
    assert!(matches!(comparison, FingerprintMatch::Exact));
    assert!(acceptable_match(RiskLevel::Financial, &comparison));
}

#[test]
fn different_package_is_no_match() {
    let fp1 = base_fingerprint();
    let mut fp2 = base_fingerprint();
    fp2.package = "com.other.app".to_string();
    let comparison = fp1.compare(&fp2);
    assert!(matches!(comparison, FingerprintMatch::NoMatch));
    assert!(!acceptable_match(RiskLevel::ReadPersonal, &comparison));
}

#[test]
fn different_class_is_no_match() {
    let fp1 = base_fingerprint();
    let mut fp2 = base_fingerprint();
    fp2.class_name = "android.widget.TextView".to_string();
    let comparison = fp1.compare(&fp2);
    assert!(matches!(comparison, FingerprintMatch::NoMatch));
}

#[test]
fn text_change_is_partial() {
    let fp1 = base_fingerprint();
    let mut fp2 = base_fingerprint();
    fp2.normalized_text = Some("Send All".to_string());
    let comparison = fp1.compare(&fp2);
    assert!(matches!(comparison, FingerprintMatch::Partial { .. }));
}

#[test]
fn high_risk_rejects_partial() {
    let fp1 = base_fingerprint();
    let mut fp2 = base_fingerprint();
    fp2.normalized_text = Some("Send All".to_string());
    let comparison = fp1.compare(&fp2);

    // High risk (Financial, Communication, Destructive) requires Exact
    assert!(!acceptable_match(RiskLevel::Financial, &comparison));
    assert!(!acceptable_match(RiskLevel::Communication, &comparison));
    assert!(!acceptable_match(RiskLevel::Destructive, &comparison));
}

#[test]
fn low_risk_accepts_cosmetic_partial() {
    let fp1 = base_fingerprint();
    let mut fp2 = base_fingerprint();
    // Small position change is cosmetic
    fp2.approximate_bounds = Rect {
        left: 102,
        top: 203,
        right: 302,
        bottom: 253,
    };
    let comparison = fp1.compare(&fp2);
    assert!(matches!(comparison, FingerprintMatch::Partial { .. }));
    // Low risk should accept cosmetic changes
    assert!(acceptable_match(RiskLevel::ReadPersonal, &comparison));
    assert!(acceptable_match(RiskLevel::DeviceControl, &comparison));
}

#[test]
fn low_risk_rejects_non_cosmetic_partial() {
    let fp1 = base_fingerprint();
    let mut fp2 = base_fingerprint();
    // State change is not cosmetic
    fp2.state = Some("disabled".to_string());
    let comparison = fp1.compare(&fp2);
    assert!(matches!(comparison, FingerprintMatch::Partial { .. }));
    assert!(!acceptable_match(RiskLevel::DeviceControl, &comparison));
}
