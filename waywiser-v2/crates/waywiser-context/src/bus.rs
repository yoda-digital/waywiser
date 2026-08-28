//! Observation Bus — dispatches observations to deterministic reducers.
//!
//! Reducers are pure functions: no LLM calls, no network, no side effects.
//! They take an observation and update the context graph.

use pi_types::{Observation, ObservationKind};

use crate::graph::ContextGraph;

/// Deterministic reducer: pure function from observation to graph mutation.
///
/// # Contract
/// - `reduce` must be deterministic and fast (no async, no I/O).
/// - Same observation applied twice must produce the same graph state (idempotent).
/// - No LLM calls. No network. No side effects beyond the graph.
pub trait DeterministicReducer: Send + Sync {
    /// Which observation kinds this reducer handles.
    fn handles(&self) -> &[ObservationKind];

    /// Apply the observation to the graph. Must be deterministic and fast.
    fn reduce(&self, obs: &Observation, graph: &mut ContextGraph);
}

/// Receives observations from the Android layer via FFI and dispatches
/// to all registered reducers.
pub struct ObservationBus {
    reducers: Vec<Box<dyn DeterministicReducer>>,
}

impl ObservationBus {
    /// Create a new empty observation bus.
    pub fn new() -> Self {
        Self {
            reducers: Vec::new(),
        }
    }

    /// Register a reducer. It will be called for observations matching
    /// any of its `handles()` kinds.
    pub fn register(&mut self, reducer: Box<dyn DeterministicReducer>) {
        self.reducers.push(reducer);
    }

    /// Dispatch an observation to all registered reducers that handle its kind.
    pub fn publish(&self, obs: &Observation, graph: &mut ContextGraph) {
        for reducer in &self.reducers {
            let handled_kinds = reducer.handles();
            if handled_kinds.iter().any(|k| observation_kind_matches(k, &obs.kind)) {
                reducer.reduce(obs, graph);
            }
        }
    }

    /// Number of registered reducers.
    pub fn reducer_count(&self) -> usize {
        self.reducers.len()
    }
}

impl Default for ObservationBus {
    fn default() -> Self {
        Self::new()
    }
}

/// Check if two ObservationKind values match.
/// Custom variants match only if the string is identical.
fn observation_kind_matches(pattern: &ObservationKind, actual: &ObservationKind) -> bool {
    use std::mem::discriminant;
    match (pattern, actual) {
        (ObservationKind::Custom(a), ObservationKind::Custom(b)) => a == b,
        _ => discriminant(pattern) == discriminant(actual),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use pi_types::{ObservationSource, RetentionClass, Sensitivity};
    use crate::graph::ContextNode;
    use crate::domains::{ContextDomain, DeviceContext, NetworkState, ThermalState, ScreenState};

    /// A test reducer that updates device.battery from DeviceState observations.
    struct BatteryReducer;

    impl DeterministicReducer for BatteryReducer {
        fn handles(&self) -> &[ObservationKind] {
            &[ObservationKind::DeviceState]
        }

        fn reduce(&self, obs: &Observation, graph: &mut ContextGraph) {
            if obs.subject == "battery" {
                if let Some(pct) = obs.value.as_u64() {
                    let device = DeviceContext {
                        battery_pct: pct as u8,
                        charging: false,
                        network: NetworkState::Wifi,
                        thermal: ThermalState::Nominal,
                        screen: ScreenState::On,
                    };
                    graph.update("device.battery", ContextNode {
                        domain: ContextDomain::Device(device),
                        updated_at: obs.observed_at,
                        expires_at: Some(obs.observed_at + chrono::Duration::minutes(10)),
                        source: obs.source.clone(),
                    });
                }
            }
        }
    }

    fn make_obs(kind: ObservationKind, subject: &str, value: serde_json::Value) -> Observation {
        Observation {
            id: uuid::Uuid::now_v7(),
            kind,
            subject: subject.to_string(),
            value,
            source: ObservationSource::Android,
            source_id: None,
            confidence: 1.0,
            observed_at: Utc::now(),
            expires_at: None,
            sensitivity: Sensitivity::Internal,
            retention: RetentionClass::Ephemeral,
            consent_scope: None,
        }
    }

    #[test]
    fn test_bus_dispatches_to_matching_reducer() {
        let mut bus = ObservationBus::new();
        bus.register(Box::new(BatteryReducer));
        assert_eq!(bus.reducer_count(), 1);

        let mut graph = ContextGraph::new();
        let obs = make_obs(ObservationKind::DeviceState, "battery", serde_json::json!(85));
        bus.publish(&obs, &mut graph);

        assert!(graph.has_node("device.battery"));
    }

    #[test]
    fn test_bus_ignores_non_matching_observations() {
        let mut bus = ObservationBus::new();
        bus.register(Box::new(BatteryReducer));

        let mut graph = ContextGraph::new();
        let obs = make_obs(ObservationKind::Notification, "msg", serde_json::json!("hello"));
        bus.publish(&obs, &mut graph);

        assert!(graph.is_empty());
    }

    #[test]
    fn test_reducer_idempotent() {
        let mut bus = ObservationBus::new();
        bus.register(Box::new(BatteryReducer));

        let mut graph = ContextGraph::new();
        let obs = make_obs(ObservationKind::DeviceState, "battery", serde_json::json!(42));

        bus.publish(&obs, &mut graph);
        let snapshot1 = graph.snapshot();

        bus.publish(&obs, &mut graph);
        let snapshot2 = graph.snapshot();

        assert_eq!(snapshot1.len(), snapshot2.len());
        assert_eq!(snapshot1.len(), 1);
    }
}
