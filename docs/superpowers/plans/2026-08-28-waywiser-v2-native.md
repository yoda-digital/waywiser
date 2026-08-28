# Waywiser v2 Native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Waywiser v2 native runtime — a Rust workspace with 15 crates implementing all 4 delivery phases (P0-P3), plus an Android/Kotlin project structure, producing a compilable and unit-tested codebase.

**Architecture:** Rust workspace at `waywiser-v2/` with crates following the dependency graph: `pi-types` (shared) → `pi-core` + `pi-inference` + `pi-session` → `waywiser-core` → domain crates (security, work, delegation, proactive, context, attention, notifications, automation, workflows) → `waywiser-ffi`. Android project at `waywiser-v2/android/` with Kotlin code for all platform components. Each crate has full type definitions, trait implementations, and unit tests.

**Tech Stack:** Rust 1.98, tokio (async), rusqlite (SQLite), reqwest (HTTP), serde/serde_json (serialization), uuid (UUIDv7), chrono (time), thiserror (errors), uniffi (FFI), regex. Kotlin/Jetpack Compose for Android (code written, compiled separately with Android SDK).

**Spec:** `docs/specs/waywiser-v2-specs.html` (4,700 lines, 39 components, 59 acceptance criteria)

## Global Constraints

- Rust edition 2024, MSRV 1.98.0
- All IDs are UUIDv7 (globally unique, sortable by creation time)
- All timestamps are `DateTime<Utc>` via chrono
- All serializable types derive `Serialize, Deserialize` via serde
- Error types use `thiserror::Error`
- Async runtime is tokio (multi-thread)
- No `unwrap()` in library code — `Result` or `expect()` with message only in tests
- Every FFI entry point wraps in `std::panic::catch_unwind`
- `panic = "unwind"` in all Cargo.toml profiles
- Thinking/reasoning effort defaults to Medium, never XHigh for interactive
- Security invariant: risk can only stay same or increase through any classification pipeline

## Parallelization Strategy

Tasks 1-2 are sequential (workspace setup + shared types). Tasks 3-5 are parallel (independent pi-* crates). Tasks 6-12 can be parallelized in groups after their dependencies complete. Task 13 (Android) and Task 14 (integration) are sequential at the end.

```
Task 1: Workspace scaffold
    ↓
Task 2: pi-types (shared types)
    ↓
┌───────────┬─────────────┬──────────────┐
Task 3      Task 4        Task 5
pi-core     pi-inference   pi-session
└───────────┴─────────────┴──────────────┘
    ↓
Task 6: waywiser-core
    ↓
┌────────────┬──────────────┬──────────────┬────────────────┐
Task 7       Task 8         Task 9         Task 10
ww-security  ww-work        ww-context     ww-notifications
└────────────┴──────────────┴──────────────┴────────────────┘
    ↓
Task 11: waywiser-delegation + waywiser-proactive
    ↓
Task 12: waywiser-automation + waywiser-workflows + waywiser-ffi
    ↓
Task 13: Android/Kotlin project
    ↓
Task 14: Integration tests + cargo build verification
```

---

### Task 1: Workspace Scaffold

**Files:**
- Create: `waywiser-v2/Cargo.toml` (workspace root)
- Create: `waywiser-v2/rust-toolchain.toml`
- Create: `waywiser-v2/.cargo/config.toml`
- Create: All `crates/*/Cargo.toml` stub files (15 crates)
- Create: All `crates/*/src/lib.rs` stub files

**Interfaces:**
- Consumes: nothing
- Produces: Compilable empty workspace that `cargo check` passes

- [ ] **Step 1: Create workspace root Cargo.toml**

```toml
# waywiser-v2/Cargo.toml
[workspace]
resolver = "2"
members = [
    "crates/pi-types",
    "crates/pi-core",
    "crates/pi-inference",
    "crates/pi-session",
    "crates/waywiser-core",
    "crates/waywiser-security",
    "crates/waywiser-work",
    "crates/waywiser-delegation",
    "crates/waywiser-proactive",
    "crates/waywiser-context",
    "crates/waywiser-attention",
    "crates/waywiser-notifications",
    "crates/waywiser-automation",
    "crates/waywiser-workflows",
    "crates/waywiser-ffi",
]

[workspace.package]
version = "0.1.0"
edition = "2024"
license = "Proprietary"
rust-version = "1.98"

[workspace.dependencies]
uuid = { version = "1", features = ["v7", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tokio = { version = "1", features = ["full"] }
async-trait = "0.1"
tracing = "0.1"
regex = "1"
rusqlite = { version = "0.32", features = ["bundled"] }
reqwest = { version = "0.12", features = ["json", "stream"] }
tokio-util = "0.7"

[profile.release]
panic = "unwind"

[profile.dev]
panic = "unwind"
```

- [ ] **Step 2: Create rust-toolchain.toml and cargo config**

```toml
# waywiser-v2/rust-toolchain.toml
[toolchain]
channel = "stable"
```

```toml
# waywiser-v2/.cargo/config.toml
[build]
# Android cross-compilation targets added later
```

- [ ] **Step 3: Create all 15 crate Cargo.toml files**

Each crate gets a Cargo.toml with appropriate workspace dependencies. Create directories and stub `src/lib.rs` for each:

```
crates/pi-types/Cargo.toml        → depends on: uuid, chrono, serde, serde_json, thiserror
crates/pi-core/Cargo.toml         → depends on: pi-types, tokio, async-trait, tracing
crates/pi-inference/Cargo.toml    → depends on: pi-types, tokio, async-trait, reqwest, tracing
crates/pi-session/Cargo.toml      → depends on: pi-types, tokio, async-trait, rusqlite, tracing
crates/waywiser-core/Cargo.toml   → depends on: pi-types, pi-core, tokio, async-trait, tracing
crates/waywiser-security/Cargo.toml → depends on: pi-types, waywiser-core, regex, tracing
crates/waywiser-work/Cargo.toml   → depends on: pi-types, tokio, tracing
crates/waywiser-delegation/Cargo.toml → depends on: pi-types, pi-core, waywiser-work, tokio, tracing
crates/waywiser-proactive/Cargo.toml → depends on: pi-types, waywiser-work, tokio, tracing
crates/waywiser-context/Cargo.toml → depends on: pi-types, tokio, tracing
crates/waywiser-attention/Cargo.toml → depends on: pi-types, waywiser-context, tracing
crates/waywiser-notifications/Cargo.toml → depends on: pi-types, waywiser-attention, tracing
crates/waywiser-automation/Cargo.toml → depends on: pi-types, waywiser-security, tracing
crates/waywiser-workflows/Cargo.toml → depends on: pi-types, waywiser-security, waywiser-automation, tokio, tracing
crates/waywiser-ffi/Cargo.toml    → depends on: all crates above, tokio
```

Each `src/lib.rs` contains: `//! Crate documentation placeholder`

- [ ] **Step 4: Verify workspace compiles**

Run: `cd waywiser-v2 && cargo check 2>&1`
Expected: All 15 crates check successfully.

---

### Task 2: pi-types — Shared Foundation Types

**Files:**
- Create: `crates/pi-types/src/lib.rs` (module declarations)
- Create: `crates/pi-types/src/ids.rs` (UUIDv7 ID types)
- Create: `crates/pi-types/src/observation.rs` (Observation, RetentionClass, Sensitivity)
- Create: `crates/pi-types/src/action.rs` (ActionIntent, ActionReceipt, ActionStatus)
- Create: `crates/pi-types/src/capability.rs` (CapabilitySpec, RiskLevel, ReplayPolicy)
- Create: `crates/pi-types/src/memory.rs` (MemoryRecord, Experience, Procedure, SkillVersion)
- Create: `crates/pi-types/src/message.rs` (AgentMessage, UserMessage, ToolCall, etc.)
- Create: `crates/pi-types/src/session.rs` (SessionState, Lane, LaneQueue, Entry, Branch)
- Create: `crates/pi-types/src/attention.rs` (AttentionDecision)
- Create: `crates/pi-types/src/error.rs` (WaywiserError)
- Test: `crates/pi-types/tests/serialization.rs`

**Interfaces:**
- Consumes: nothing
- Produces: All shared types used by every other crate. Every type from the "Shared Foundations" section of the spec, plus AgentMessage and SessionState types.

Implementation: Copy the exact Rust struct/enum definitions from the spec's Shared Foundations section (P0 spec in `docs/specs/p0-foundation.html`). Every type with `Serialize, Deserialize` derives. Tests verify round-trip JSON serialization for every major type.

- [ ] Steps: Create each source file with the exact types from the spec. Write serialization round-trip tests. Run `cargo test -p pi-types`. Commit.

---

### Task 3: pi-core — Agent Runtime

**Files:**
- Create: `crates/pi-core/src/lib.rs`
- Create: `crates/pi-core/src/agent_loop.rs` (AgentLoop trait, FinalizeOutcome)
- Create: `crates/pi-core/src/reducer.rs` (SessionReducer, ReducerState, ReducerAction, state machine)
- Create: `crates/pi-core/src/compaction.rs` (CompactionEngine trait, CompactionBudget, CompactionPlan)
- Create: `crates/pi-core/src/records.rs` (OperationRecord enum — 13 variants)
- Create: `crates/pi-core/src/tool.rs` (ToolExecutionMode, ToolDefinition)
- Test: `crates/pi-core/tests/reducer_test.rs` (state machine transitions)
- Test: `crates/pi-core/tests/records_test.rs`

**Interfaces:**
- Consumes: `pi-types` (SessionState, AgentMessage, all shared types)
- Produces: `AgentLoop` trait, `SessionReducer` (with `apply(action) -> Result<ReducerState>`), `CompactionEngine` trait, `OperationRecord` enum, `ToolExecutionMode`

Implementation: The reducer is the hardest component — implement the full state transition table from the P0 spec. 10 states, all transitions. Recovery attempts up to 3 with escalating repair. Property test: no invalid state reachable.

- [ ] Steps: Implement AgentLoop trait. Implement SessionReducer with the full state transition table. Implement CompactionEngine trait. Implement all 13 OperationRecord variants. Write reducer state machine tests (every valid transition + invalid transition rejection). Run `cargo test -p pi-core`. Commit.

---

### Task 4: pi-inference — Ollama Transport

**Files:**
- Create: `crates/pi-inference/src/lib.rs`
- Create: `crates/pi-inference/src/backend.rs` (InferenceBackend trait)
- Create: `crates/pi-inference/src/ollama.rs` (OllamaBackend — OpenAI-compatible HTTP)
- Create: `crates/pi-inference/src/streaming.rs` (SSE parser, StreamEvent)
- Create: `crates/pi-inference/src/thinking.rs` (ThinkingConfig, ReasoningEffort — default Medium)
- Create: `crates/pi-inference/src/manifest.rs` (ModelManifest, model identity verification)
- Create: `crates/pi-inference/src/mock.rs` (MockInferenceBackend for testing)
- Test: `crates/pi-inference/tests/thinking_test.rs`
- Test: `crates/pi-inference/tests/streaming_test.rs`
- Test: `crates/pi-inference/tests/manifest_test.rs`

**Interfaces:**
- Consumes: `pi-types` (AgentMessage, ToolCall, TokenUsage)
- Produces: `InferenceBackend` trait (`complete`, `complete_streaming`, `verify_manifest`), `OllamaBackend`, `MockInferenceBackend`, `ThinkingConfig` (defaults to `ReasoningEffort::Medium`), `StreamEvent` enum, `ModelManifest`

Implementation: Full InferenceBackend trait. OllamaBackend with reqwest HTTP client hitting `/v1/chat/completions`. SSE streaming parser. ThinkingConfig MUST default to Medium (research finding). ModelManifest verification. MockInferenceBackend that returns canned responses for testing.

- [ ] Steps: Define InferenceBackend trait. Implement ThinkingConfig with Medium default. Implement SSE parser for StreamEvent. Implement MockInferenceBackend. Implement OllamaBackend (compiles but network-dependent). Write tests against MockInferenceBackend. Run `cargo test -p pi-inference`. Commit.

---

### Task 5: pi-session — SQLite Session Storage

**Files:**
- Create: `crates/pi-session/src/lib.rs`
- Create: `crates/pi-session/src/backend.rs` (SessionBackend trait)
- Create: `crates/pi-session/src/sqlite.rs` (SqliteSessionBackend)
- Create: `crates/pi-session/src/migrations.rs` (schema migrations)
- Test: `crates/pi-session/tests/sqlite_test.rs`
- Test: `crates/pi-session/tests/conformance_test.rs`

**Interfaces:**
- Consumes: `pi-types` (SessionState, Lane, Entry, OperationRecord, MutationMeta)
- Produces: `SessionBackend` trait (create/load/save/delete session, append_entry, update_lane_queue, append_record, load_records, remove_entries, record_mutation), `SqliteSessionBackend`

Implementation: Full SessionBackend trait with all CRUD operations from the spec. SQLite via rusqlite with WAL mode. Session state serialized as JSON blobs. Records stored row-per-record. All writes in single transaction. Conformance tests verify backend contract.

- [ ] Steps: Define SessionBackend trait. Create SQL schema with migrations. Implement SqliteSessionBackend. Write conformance tests (create, load, save, delete, append, compact). Run `cargo test -p pi-session`. Commit.

---

### Task 6: waywiser-core — Kernel + Domain Services

**Files:**
- Create: `crates/waywiser-core/src/lib.rs`
- Create: `crates/waywiser-core/src/kernel.rs` (WaywiserKernel)
- Create: `crates/waywiser-core/src/identity.rs` (IdentityService — SOUL.md/USER.md parsing)
- Create: `crates/waywiser-core/src/memory.rs` (MemoryStore trait, SqliteMemoryStore with FTS5)
- Create: `crates/waywiser-core/src/brain.rs` (BrainService — Pass 1 deterministic + Pass 2 reflective)
- Create: `crates/waywiser-core/src/permissions.rs` (PermissionService basic)
- Create: `crates/waywiser-core/src/skills.rs` (SkillService — loading, activation, evolution)
- Test: `crates/waywiser-core/tests/memory_test.rs`
- Test: `crates/waywiser-core/tests/brain_test.rs`
- Test: `crates/waywiser-core/tests/identity_test.rs`
- Test: `crates/waywiser-core/tests/skills_test.rs`

**Interfaces:**
- Consumes: `pi-types`, `pi-core` (AgentLoop, CompactionEngine)
- Produces: `WaywiserKernel`, `IdentityService`, `MemoryStore` trait + `SqliteMemoryStore`, `BrainService` (pass1_extract, pass2_reflect, validate_candidate, consolidate), `PermissionService`, `SkillService` (load, compile, validate, evaluate, promote)

Implementation: Full kernel with all 5 services. MemoryStore with SQLite FTS5 for lexical recall + placeholder for vector search (P2). BrainService with both Pass 1 (deterministic) and Pass 2 (model-driven, deferred). Confidence ceiling enforcement. SkillService with full evolution pipeline (compiler, validator, evaluator, promoter). Skills never mutate mid-session.

- [ ] Steps: Create WaywiserKernel. Implement IdentityService with Markdown parsing. Implement SqliteMemoryStore with FTS5. Implement BrainService Pass 1 + Pass 2 + consolidation + confidence ceilings. Implement PermissionService. Implement SkillService with evolution pipeline. Write tests. Run `cargo test -p waywiser-core`. Commit.

---

### Task 7: waywiser-security — Full Security Kernel

**Files:**
- Create: `crates/waywiser-security/src/lib.rs`
- Create: `crates/waywiser-security/src/kernel.rs` (SecurityKernel — full authorization flow)
- Create: `crates/waywiser-security/src/risk.rs` (RiskClassifier — 5-layer pipeline)
- Create: `crates/waywiser-security/src/leases.rs` (ApprovalLease — full model with audit)
- Create: `crates/waywiser-security/src/pipeline.rs` (ActionPipeline — 9-stage lifecycle)
- Create: `crates/waywiser-security/src/audit.rs` (AuditEntry, AuditLog)
- Create: `crates/waywiser-security/src/toctou.rs` (NodeFingerprint, FingerprintMatch, verify_before_action)
- Create: `crates/waywiser-security/src/verification.rs` (PostActionVerification, ExpectedTransition)
- Test: `crates/waywiser-security/tests/kernel_test.rs`
- Test: `crates/waywiser-security/tests/risk_classifier_test.rs`
- Test: `crates/waywiser-security/tests/lease_test.rs`
- Test: `crates/waywiser-security/tests/pipeline_test.rs`
- Test: `crates/waywiser-security/tests/toctou_test.rs`

**Interfaces:**
- Consumes: `pi-types` (ActionIntent, ActionReceipt, CapabilitySpec, RiskLevel), `waywiser-core`
- Produces: `SecurityKernel` (`authorize(intent) -> SecurityDecision`), `RiskClassifier` (`classify(req) -> ClassificationResult`, 5-layer, risk only increases), `ApprovalLease` (full model: scope, constraints, expiry, budget, audit trail, `evaluate`, `revoke`), `ActionPipeline` (`process(intent) -> ActionReceipt`, 9-stage, crash recovery with replay policies), `NodeFingerprint`, `verify_before_action`, `verify_after_action`

Implementation: This is the most critical crate. Implement the exact authorization flow from P1 spec. Implement the 5-layer risk classifier from P3 spec with regex-based semantic rules. Implement full lease model. Implement 9-stage action pipeline with crash recovery. TOCTOU protection with fingerprint matching. Property tests: unknown capability -> denied, risk monotonic, expired lease -> denied, no LLM in auth path.

- [ ] Steps: Implement SecurityKernel authorize flow. Implement 5-layer RiskClassifier with semantic rules table + primitive floors table. Implement ApprovalLease with evaluate/revoke/record_use. Implement ActionPipeline 9-stage lifecycle. Implement TOCTOU NodeFingerprint + verify_before_action. Implement PostActionVerification. Write property tests for all security invariants. Run `cargo test -p waywiser-security`. Commit.

---

### Task 8: waywiser-work — Work Graph + Goals

**Files:**
- Create: `crates/waywiser-work/src/lib.rs`
- Create: `crates/waywiser-work/src/goal.rs` (Goal, GoalStatus)
- Create: `crates/waywiser-work/src/work_item.rs` (WorkItem, WorkStatus, ApprovalState)
- Create: `crates/waywiser-work/src/graph.rs` (DependencyGraph, topological sort)
- Create: `crates/waywiser-work/src/kanban.rs` (KanbanProjection, KanbanColumn)
- Create: `crates/waywiser-work/src/service.rs` (WorkGraphService trait + impl)
- Test: `crates/waywiser-work/tests/graph_test.rs`
- Test: `crates/waywiser-work/tests/kanban_test.rs`

**Interfaces:**
- Consumes: `pi-types` (GoalId, WorkItemId, SessionId, EvidenceRef)
- Produces: `Goal`, `WorkItem`, `WorkStatus` (Proposed→Ready→Running→Review→Done|Blocked), `DependencyGraph` (topological sort, cycle detection), `KanbanProjection` (from_work_items), `WorkGraphService` trait

Implementation: Full work graph from P1 spec. WorkItem with lifecycle. DependencyGraph with topological sort and cycle detection. KanbanProjection as a view over WorkItems. WorkGraphService with create, transition, assign, ready_items, kanban.

- [ ] Steps: Implement Goal + WorkItem + WorkStatus. Implement DependencyGraph with topo sort + cycle detection. Implement KanbanProjection. Implement WorkGraphService. Write tests for lifecycle transitions, dependency resolution, kanban projection. Run `cargo test -p waywiser-work`. Commit.

---

### Task 9: waywiser-context — Context Graph + Attention Governor

**Files:**
- Create: `crates/waywiser-context/src/lib.rs`
- Create: `crates/waywiser-context/src/graph.rs` (ContextGraph, ContextNode, ContextDomain)
- Create: `crates/waywiser-context/src/domains.rs` (UserContext, DeviceContext, EnvironmentContext)
- Create: `crates/waywiser-context/src/bus.rs` (ObservationBus, DeterministicReducer trait)
- Create: `crates/waywiser-context/src/decay.rs` (temporal decay per domain)
- Create: `crates/waywiser-context/src/projection.rs` (ProjectionEngine, ContextProjection, TaskType)
- Create: `crates/waywiser-context/src/snapshot.rs` (ContextGraphSnapshot)
- Create: `crates/waywiser-attention/src/lib.rs`
- Create: `crates/waywiser-attention/src/governor.rs` (AttentionGovernor, AttentionPolicy)
- Create: `crates/waywiser-attention/src/rules.rs` (AttentionRule, AttentionSource, floors/ceilings)
- Create: `crates/waywiser-attention/src/hint.rs` (EdgeHint, suppression asymmetry)
- Test: `crates/waywiser-context/tests/graph_test.rs`
- Test: `crates/waywiser-context/tests/projection_test.rs`
- Test: `crates/waywiser-attention/tests/governor_test.rs`
- Test: `crates/waywiser-attention/tests/suppression_test.rs`

**Interfaces:**
- Consumes: `pi-types` (Observation, ObservationKind, AttentionDecision)
- Produces: `ContextGraph` (nodes by domain), `ObservationBus` (publish to reducers), `DeterministicReducer` trait, `ContextGraphSnapshot`, `ProjectionEngine` (project context for query within token budget), `AttentionGovernor` (evaluate with floors/ceilings/suppression asymmetry), `AttentionPolicy`, `EdgeHint`

Implementation: Full context graph from P2 spec. Observation bus dispatches to deterministic reducers. Temporal decay per domain (UserActivity 5min, DeviceBattery 10min, etc.). Projection engine scores nodes by relevance, greedily fills token budget. Attention governor with hardcoded high-consequence floors (family → Notify, repeated calls → Urgent). Suppression asymmetry: escalation at low confidence, suppression only at high + no floor violation.

- [ ] Steps: Implement ContextGraph + domain types. Implement ObservationBus + DeterministicReducer. Implement temporal decay. Implement ProjectionEngine with token budgeting. Implement AttentionGovernor with full floor/ceiling/suppression logic. Write tests: reducer idempotency, decay expiry, projection budget enforcement, floor enforcement, suppression asymmetry. Run `cargo test -p waywiser-context -p waywiser-attention`. Commit.

---

### Task 10: waywiser-notifications — Notification Intelligence

**Files:**
- Create: `crates/waywiser-notifications/src/lib.rs`
- Create: `crates/waywiser-notifications/src/normalized.rs` (NormalizedNotification, PersonRef)
- Create: `crates/waywiser-notifications/src/classifier.rs` (NotificationClassifier trait + DeterministicClassifier)
- Create: `crates/waywiser-notifications/src/policy.rs` (NotificationPolicy, app floors/ceilings)
- Create: `crates/waywiser-notifications/src/rules.rs` (ClassificationRule — important contacts, repeated calls, etc.)
- Test: `crates/waywiser-notifications/tests/classifier_test.rs`

**Interfaces:**
- Consumes: `pi-types` (AttentionDecision), `waywiser-attention` (AttentionGovernor)
- Produces: `NormalizedNotification`, `NotificationClassifier` trait + `DeterministicClassifier`, `NotificationPolicy` (important/family contacts, app ceilings/floors), `ClassificationRule` enum

Implementation: Full notification classification from P1 spec. Deterministic only — no LLM. Rules: important contacts → min Notify, repeated calls → HeadsUp, family → Notify, security alerts, alarm channels. Configurable per-app ceilings and floors.

- [ ] Steps: Implement NormalizedNotification. Implement ClassificationRule enum. Implement DeterministicClassifier. Implement NotificationPolicy. Write tests: important contact rule, repeated call detection, app ceiling enforcement. Run `cargo test -p waywiser-notifications`. Commit.

---

### Task 11: waywiser-delegation + waywiser-proactive

**Files:**
- Create: `crates/waywiser-delegation/src/lib.rs`
- Create: `crates/waywiser-delegation/src/supervisor.rs` (AgentSupervisor)
- Create: `crates/waywiser-delegation/src/agent.rs` (AgentClass, ChildAgent, ChildAgentStatus)
- Create: `crates/waywiser-delegation/src/budget.rs` (DelegationBudget, enforcement)
- Create: `crates/waywiser-delegation/src/coordinator.rs` (AgentCoordinator, work locking, depth check)
- Create: `crates/waywiser-delegation/src/context.rs` (FocusedContext)
- Create: `crates/waywiser-proactive/src/lib.rs`
- Create: `crates/waywiser-proactive/src/service.rs` (ProactiveService — OODA loop)
- Create: `crates/waywiser-proactive/src/signals.rs` (ProactiveSignal, SignalSource)
- Create: `crates/waywiser-proactive/src/queue.rs` (ReasoningQueueManager, ReasoningJob, coalescing)
- Create: `crates/waywiser-proactive/src/relevance.rs` (RelevanceRule, semantic relevance checks)
- Test: `crates/waywiser-delegation/tests/supervisor_test.rs`
- Test: `crates/waywiser-delegation/tests/budget_test.rs`
- Test: `crates/waywiser-proactive/tests/queue_test.rs`

**Interfaces:**
- Consumes: `pi-types`, `pi-core`, `waywiser-work` (WorkItem, GoalId)
- Produces: `AgentSupervisor` (spawn, cancel, schedule_next), `AgentClass` (Primary, Leaf, Orchestrator, CognitionWorker, Verification), `DelegationBudget` (max_children, max_depth=2, token limits), `AgentCoordinator` (work locking, depth enforcement, budget cascading), `ProactiveService` (observe, orient, decide, act — OODA), `ReasoningQueueManager` (enqueue with coalescing, next_ready with relevance check, semantic expiry)

Implementation: Full delegation from P1+P3 specs. AgentSupervisor with priority queue (P0>P1>P2>P3). Depth capped at 2. Budget cascading: child ≤ remaining parent. AgentCoordinator with work item locking. Proactive OODA loop from P1 spec. Reasoning queue with durable persistence, semantic relevance checks, job coalescing.

- [ ] Steps: Implement AgentClass + ChildAgent. Implement DelegationBudget enforcement. Implement AgentSupervisor with priority scheduling. Implement AgentCoordinator with locking + depth + budget cascading. Implement ProactiveService OODA. Implement ReasoningQueueManager with coalescing + relevance. Write tests: depth limit, budget enforcement, OODA cycle, queue coalescing, relevance expiry. Run `cargo test -p waywiser-delegation -p waywiser-proactive`. Commit.

---

### Task 12: waywiser-automation + waywiser-workflows + waywiser-ffi

**Files:**
- Create: `crates/waywiser-automation/src/lib.rs`
- Create: `crates/waywiser-automation/src/a11y.rs` (A11yNode, TreeQuality, SecureWindowState, TreeSnapshot)
- Create: `crates/waywiser-automation/src/profiles.rs` (AutomationProfile, NodeProfile, ProfileRegistry)
- Create: `crates/waywiser-workflows/src/lib.rs`
- Create: `crates/waywiser-workflows/src/workflow.rs` (Workflow, WorkflowStep, WorkflowStatus)
- Create: `crates/waywiser-workflows/src/executor.rs` (execute with verification, halt on Unexpected)
- Create: `crates/waywiser-workflows/src/rollback.rs` (compensating actions for reversible steps)
- Create: `crates/waywiser-ffi/src/lib.rs`
- Create: `crates/waywiser-ffi/src/runtime.rs` (WaywiserRuntime — UniFFI object)
- Create: `crates/waywiser-ffi/src/events.rs` (RuntimeEvent enum, RuntimeConfig)
- Test: `crates/waywiser-automation/tests/profile_test.rs`
- Test: `crates/waywiser-automation/tests/a11y_test.rs`
- Test: `crates/waywiser-workflows/tests/workflow_test.rs`
- Test: `crates/waywiser-workflows/tests/rollback_test.rs`

**Interfaces:**
- Consumes: all previous crates
- Produces: `A11yNode`, `TreeQuality` (Good/Partial/Poor/Unusable), `assess_tree_quality(root)`, `AutomationProfile` + `ProfileRegistry` (load from YAML, match node), `Workflow` (execute step-by-step with verification, halt on Unexpected, rollback reversible), `WaywiserRuntime` (FFI object: new, send_message, poll_event, cancel, steer, list_sessions, shutdown), `RuntimeEvent` enum, `RuntimeConfig`

Implementation: A11yNode from P3 spec with tree quality assessment. ProfileRegistry loading YAML profiles. Workflow executor with step-by-step verification + rollback. WaywiserRuntime as the UniFFI interface object — this is the main entry point Kotlin calls. poll_event pattern with bounded tokio channel. Note: UniFFI codegen requires `uniffi` crate which needs setup — create the interface definitions but mark UniFFI attributes as cfg-gated for now.

- [ ] Steps: Implement A11yNode + TreeQuality + assess_tree_quality. Implement ProfileRegistry with YAML loading. Implement Workflow + WorkflowStep + executor with halt-on-Unexpected. Implement rollback for reversible steps. Implement WaywiserRuntime with RuntimeEvent and RuntimeConfig. Write tests: tree quality assessment, profile matching, workflow execution + rollback, FFI runtime event flow. Run `cargo test -p waywiser-automation -p waywiser-workflows -p waywiser-ffi`. Commit.

---

### Task 13: Android/Kotlin Project Structure

**Files:**
- Create: `waywiser-v2/android/settings.gradle.kts`
- Create: `waywiser-v2/android/build.gradle.kts`
- Create: `waywiser-v2/android/app/build.gradle.kts`
- Create: `waywiser-v2/android/app/src/main/AndroidManifest.xml`
- Create: `waywiser-v2/android/app/src/main/kotlin/com/waywiser/` (package structure)
- Create: All Kotlin source files for all Android components (voice, notifications, calendar, capture, background, trust center, ledger, updater, offline, edge, camera, accessibility)

**Interfaces:**
- Consumes: Rust FFI types via UniFFI-generated bindings
- Produces: Complete Android project source code (not compilable without Android SDK, but structurally correct)

Implementation: Write all Kotlin code from the P0-P3 specs. This includes: WaywiserApplication, ConversationViewModel, WaywiserRepository, VoiceManager (full state machine), WaywiserNotificationListener, CalendarProvider adapter, CaptureManager + ShareActivity, InferenceService (specialUse FGS), BrainReflectionWorker, ConnectivityMonitor, UpdateManager (manifest verification), TrustCenterScreen + ApprovalActivity, LedgerScreen, EdgeResidencyPolicy, FrameSelector, WaywiserAccessibilityService. All Compose UI screens.

- [ ] Steps: Create project structure with Gradle files. Write AndroidManifest.xml with all service/activity declarations. Write each Kotlin source file matching the spec. Organize by feature package. Commit.

---

### Task 14: Integration Tests + Final Verification

**Files:**
- Create: `waywiser-v2/tests/integration/full_vertical.rs`
- Create: `waywiser-v2/tests/integration/security_invariants.rs`
- Create: `waywiser-v2/tests/integration/workflow_lifecycle.rs`
- Create: `waywiser-v2/fixtures/conformance/` (JSON test fixtures)

**Interfaces:**
- Consumes: all crates
- Produces: Passing integration test suite, clean `cargo build`, clean `cargo test`

Implementation: Integration tests that exercise the full vertical slice (P0 acceptance criterion 1-4): user message → agent loop → mock inference → tool call → security kernel → tool result → response. Security invariant tests: unknown capability denied, risk monotonic, lease lifecycle. Workflow lifecycle test: multi-step workflow with verification and rollback.

- [ ] Steps: Write integration tests. Create conformance JSON fixtures. Run `cargo build --workspace` — must compile cleanly. Run `cargo test --workspace` — all tests pass. Run `cargo clippy --workspace` — no warnings. Commit.

---

## Summary

| Task | Crates | LOC est. | Can parallelize with |
|------|--------|----------|---------------------|
| 1. Scaffold | workspace | 200 | — |
| 2. pi-types | 1 | 1,500 | — |
| 3. pi-core | 1 | 2,500 | 4, 5 |
| 4. pi-inference | 1 | 1,500 | 3, 5 |
| 5. pi-session | 1 | 1,200 | 3, 4 |
| 6. waywiser-core | 1 | 2,500 | — |
| 7. waywiser-security | 1 | 3,000 | 8, 9, 10 |
| 8. waywiser-work | 1 | 1,200 | 7, 9, 10 |
| 9. waywiser-context + attention | 2 | 2,500 | 7, 8, 10 |
| 10. waywiser-notifications | 1 | 800 | 7, 8, 9 |
| 11. delegation + proactive | 2 | 2,000 | — |
| 12. automation + workflows + ffi | 3 | 2,500 | — |
| 13. Android/Kotlin | — | 5,000 | 3-12 |
| 14. Integration | — | 1,000 | — |
| **Total** | **15** | **~27,400** | |
