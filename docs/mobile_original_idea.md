# Waywiser v2 — Final Blueprint

**Document type:** Normative architecture blueprint  
**Status:** Final consolidated source of truth for engineering kickoff  
**Date:** 28 August 2026  
**Distribution:** Internal company use only  
**Target artifact:** Signed Android APK distributed from company GitLab  
**Primary runtime goal:** Fully Android-native personal intelligence runtime, no Termux, no Node.js runtime in the production APK  
**Primary reasoning model:** Company-hosted Qwen3.8-27B  
**Current serving baseline:** Company Ollama deployment, OpenAI-compatible HTTPS API, company authentication layer, current approved Qwen3.8-27B Unsloth GGUF artifact  
**Normative code baselines used during design:** Waywiser `feat/mobile`; Pi `main`

---

## 1. Purpose

This document replaces the original Waywiser v2 RFC and all subsequent amendments and review-chain deltas.

It is intentionally **not** a chronological record of the design discussion. It states only the architecture that is considered current after the full review process.

Historical reviews remain useful as design rationale, but engineering must not require mentally replaying four documents and three correction layers to determine what is true.

The system described here is:

> **Waywiser v2: an internally distributed Android-native personal intelligence runtime that perceives relevant phone and environmental context, reasons through a company-controlled authoritative model, performs explicitly authorized actions, learns from outcomes under deterministic governance, and remains auditable, recoverable, and useful even when parts of the system are unavailable.**

Waywiser v2 is not a chat wrapper.

Conversation is one interface to a persistent runtime.

---

# 2. Product boundary

## 2.1 Waywiser v2 is

A local-first personal intelligence system that can:

- maintain durable personal memory;
- maintain ephemeral working context about the present situation;
- accept text, voice, camera, file, share-sheet, notification, and structured Android input;
- reason using Native Pi semantics;
- decompose goals into autonomous work;
- supervise delegated agents;
- execute authorized phone and external-system capabilities;
- operate proactively under Android lifecycle constraints;
- learn from explicit user corrections and observed task outcomes;
- compile mature procedures into evaluated skills;
- explain what it knows, what it did, and why;
- recover from process death and ambiguous external side effects;
- use the Android phone itself as a first-class execution and observation environment.

## 2.2 Waywiser v2 is not

It is explicitly not:

- a Play Store product;
- a Termux application hidden behind an Android shell;
- an embedded-Node product;
- an always-listening or always-recording surveillance system;
- an unrestricted root-level Android controller;
- a system that lets an LLM grant itself permissions;
- a system that treats every sensed observation as permanent memory;
- a system that sends every device event to a 27B model;
- a generic provider marketplace;
- a multi-model agent-routing playground;
- a requirement to preserve accidental Node, CLI, TUI, subprocess, or filesystem implementation details from Pi or Waywiser v1.

---

# 3. Distribution invariant

Waywiser v2 is an **internal company APK**.

Supported primary distribution:

```text
Company GitLab
    ↓
signed release artifacts
    ↓
internal employees / company devices
```

Google Play publication is not a target.

This removes Google Play policy as an architectural requirement.

It does **not** remove Android platform security.

Waywiser remains subject to:

- Android sandboxing;
- runtime permissions;
- SELinux;
- background execution policy;
- foreground-service rules;
- camera and microphone privacy restrictions;
- notification-access grants;
- AccessibilityService grants;
- secure-window restrictions;
- OEM process management;
- Advanced Protection;
- installation policy;
- device-management policy.

The core distinction is:

```text
Google Play policy ≠ Android platform security
```

Internal distribution increases the practical capability ceiling, especially around Accessibility-backed automation, but it must not weaken Waywiser’s internal security model.

---

# 4. Final architectural invariants

The following invariants are normative.

## I1. Internal deployment

Waywiser is an internally distributed, company-signed Android application.

It does not optimize architecture around Google Play policy.

---

## I2. Protected machine-state authority is deterministic

LLMs may propose protected state transitions.

They do not authorize them.

Protected state transitions include, for example:

- sending communication;
- modifying calendar data;
- deleting data;
- installing or changing software state;
- cross-app UI actions;
- changing durable Waywiser state where policy requires authorization;
- performing financial or destructive actions;
- creating or extending approval authority.

A deterministic security kernel decides whether such transitions may execute.

This does **not** claim that LLM language has no influence over humans.

A model may still say something consequential to the user.

The security claim is specifically:

> **The LLM has no direct machine authority over protected state transitions.**

---

## I3. Provenance is deterministic

Models may infer meaning.

They may not assign their own epistemic authority.

For memories, procedures, learned rules, and external observations, deterministic code decides:

- source;
- confidence ceilings;
- retention class;
- scope;
- whether evidence is sufficient for durable promotion.

---

## I4. Observation is not memory

Environmental state is ephemeral by default.

The pipeline is:

```text
Observation
    ↓
Working Context
    ↓
Experience
    ↓
Learning Gate
    ↓
Possible Durable Memory / Procedure
```

Examples:

```text
"user is currently walking"
```

normally belongs to ephemeral working context.

```text
"user explicitly prefers morning flights"
```

may become durable personal memory after validation.

---

## I5. Expensive cognition is exceptional

The normal hierarchy is:

```text
deterministic processing
        ↓ unresolved
optional bounded edge inference
        ↓ unresolved / consequential
authoritative Qwen3.8 reasoning
```

Most device events should not reach the central 27B model.

---

## I6. One authoritative deliberative model

The only model allowed to participate as a Native Pi deliberative agent is:

```text
Qwen3.8-27B
```

The company-hosted Qwen instance is the sole authoritative reasoning model.

Auxiliary neural systems are allowed for bounded utility functions such as:

- embeddings;
- ASR;
- OCR;
- CV;
- classification;
- semantic routing;
- context compression;
- signal assessment.

They must not act as Pi agents.

They must not authorize actions.

They must not lower deterministic risk.

They must not create durable beliefs without the normal Brain validation path.

---

## I7. User activity outranks autonomous work

Interactive user work has priority over:

- delegated background work;
- Brain reflection;
- consolidation;
- skill compilation;
- skill evaluation;
- proactive background reasoning.

Background inference is cancellable, resumable, or retryable.

---

## I8. Side effects are durable and recoverable

The system must represent separately:

```text
proposal
authorization
execution start
external acknowledgement
verification
completion
```

A process crash must not collapse an ambiguous external side effect into “retry”.

Where external completion is unknown, state becomes:

```text
UNKNOWN_SIDE_EFFECT
```

and verification is required before replay.

---

## I9. Uncertainty cannot lower safety

Unknown capability behavior fails closed.

Unknown Accessibility side effects require explicit approval or blocking.

Uncertain high-consequence attention decisions fail toward visibility or escalation, not suppression.

More uncertainty must never reduce deterministic risk.

---

## I10. Self-improvement cannot self-authorize

Brain learning and skill evolution may improve behavior.

They may not:

- modify the security kernel;
- grant new capabilities;
- lower action risk;
- overwrite provenance rules;
- bypass evaluation;
- alter SOUL governance through a learned skill;
- promote themselves mid-session.

Learned behavior remains subordinate to deterministic policy.

---

# 5. Final high-level architecture

```text
┌───────────────────────────────────────────────────────────────┐
│                        ANDROID PHONE                          │
│                                                               │
│  Voice · Screen · Camera · Notifications · Sensors · Files   │
│  Calendar · Location · Apps · AppFunctions · Accessibility   │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│               ANDROID CONTEXT / CAPABILITY LAYER              │
│                                                               │
│  Context adapters · lifecycle · permissions · scheduling     │
│  native intents · AppFunctions · Accessibility automation    │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                    NATIVE WAYWISER CORE                       │
│                                                               │
│  Context Graph · Attention Governor · Brain · Memory         │
│  Work · Goals · Skills · Evolution · Security Kernel         │
│  ActionIntent · ActionReceipt · Agent Supervisor             │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                       NATIVE PI CORE                          │
│                                                               │
│  Agent loop · sessions · lanes · streaming · tools           │
│  steering · follow-up · abort · compaction · recovery        │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│              COMPANY INFERENCE GATEWAY                        │
│                                                               │
│  authenticated · versioned · observable · scheduled          │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                  AUTHORITATIVE REASONER                       │
│                                                               │
│  Qwen3.8-27B                                                  │
│  current baseline: Ollama + approved Unsloth GGUF            │
└───────────────────────────────────────────────────────────────┘
```

Optional utility inference sits beside, not above, this path:

```text
Phone utility model / BGE-M3 / ASR / OCR / CV
        ↓
structured observations / hints
        ↓
Native Waywiser
```

---

# 6. Kotlin and Rust boundary

## 6.1 Kotlin owns Android

Kotlin/Jetpack Compose owns:

- Activities;
- Compose UI;
- Android lifecycle;
- runtime permissions;
- RoleManager;
- VoiceInteractionService;
- VoiceInteractionSession;
- NotificationListenerService;
- notification actions;
- RemoteInput;
- CameraX;
- WorkManager;
- AlarmManager where justified;
- biometric prompts;
- Android Keystore;
- intents;
- deep links;
- AppFunctions;
- AccessibilityService;
- ContentResolver;
- share targets;
- widgets and shortcuts;
- Android-specific context adapters;
- process/service integration.

The operating system should not be routed through Rust merely for ideological purity.

---

## 6.2 Rust owns the intelligence runtime

Rust owns:

- Native Pi agent semantics;
- session state machine;
- model transport abstraction;
- Waywiser Brain;
- memory;
- procedures;
- skill evolution;
- goals;
- autonomous work graph;
- delegation;
- capability registry;
- action intents;
- deterministic security decisions;
- proactive decision logic;
- context reduction;
- durable domain storage;
- protocol;
- recovery logic;
- MCP transport abstractions where retained.

---

## 6.3 Process topology is not frozen

Three candidate topologies remain valid:

### A. Single app process

```text
main process
  ├── Kotlin UI/platform
  └── Rust runtime
```

### B. Main + voice

```text
main + Rust
:voice
```

### C. Main + voice + agent

```text
main
:voice
:agent + Rust
```

Final topology is chosen only after measuring:

- RAM;
- cold start;
- warm wake;
- streaming latency;
- Binder overhead;
- crash isolation;
- OEM lifecycle behavior;
- low-memory behavior;
- battery impact.

The original three-process design is therefore a hypothesis, not an invariant.

---

# 7. Native Pi scope

Waywiser v2 does **not** port the entire Pi ecosystem line-for-line.

It ports the semantic kernel needed by Waywiser.

## 7.1 Must port faithfully

- agent lifecycle;
- AgentMessage semantics;
- streaming;
- tool/capability request loop;
- sequential and parallel execution semantics;
- steering;
- follow-up;
- abort;
- context transformation;
- model/thinking configuration;
- sessions;
- branching;
- lanes;
- compaction;
- operation records;
- queue semantics;
- recovery semantics;
- usage accounting;
- replay semantics.

Pi’s current session model already treats conversations as durable operation graphs rather than plain transcripts. The native port should preserve that principle.

---

## 7.2 Do not port wholesale

The following are not v2 kernel requirements:

- TUI internals;
- terminal rendering;
- Node subprocess orchestration;
- every provider implementation;
- every shell utility;
- every Node-specific filesystem behavior;
- every legacy extension loading mechanism.

---

## 7.3 Provider scope reduction

The production Native Pi implementation needs one authoritative model transport:

```text
CompanyInferenceBackend
```

It does not need a marketplace of provider adapters.

Testing may use:

```text
MockInferenceBackend
```

but production has one company inference path.

---

# 8. Pi semantic conformance

The TypeScript implementation is the behavioral reference.

Native completion is determined through differential semantic conformance.

```text
same fixture
    ├── Pi TypeScript
    └── Pi Native Rust
            ↓
normalized event/state diff
```

Compare:

- event ordering;
- tool-call lifecycle;
- queue behavior;
- steering;
- follow-up;
- abort;
- session mutations;
- lane movements;
- operation results;
- compaction behavior;
- replay decisions;
- recovery state.

Do not compare model prose as a deterministic oracle.

---

# 9. Waywiser Native domains

Native Waywiser is a service graph, not an extension chain.

```text
WaywiserKernel
├── IdentityService
├── MemoryService
├── BrainService
├── SkillService
├── GoalService
├── WorkService
├── ProactiveService
├── AttentionService
├── PermissionService
├── CapabilityService
├── AutomationService
├── IntegrationService
└── AgentSupervisor
```

Existing Waywiser concepts are ported semantically.

Current process-global TypeScript registries are not.

---

# 10. Identity and user contract

Human-readable identity files remain useful:

```text
SOUL.md
USER.md
```

They remain:

- inspectable;
- exportable;
- versionable;
- editable;
- independent from SQL schema.

The runtime parses and budgets them before injection into agent context.

A learned skill may not modify SOUL governance.

---

# 11. Observation model

```rust
Observation {
    id,
    kind,
    subject,
    value,

    source,
    source_id,

    confidence,

    observed_at,
    expires_at,

    sensitivity,
    retention,

    consent_scope
}
```

Example retention classes:

```text
EPHEMERAL
SESSION
EXPERIENCE
DURABLE_CANDIDATE
```

Raw environmental observations default to ephemeral.

---

# 12. Context Graph

Android should not become 70 independent tools the model calls repeatedly.

Device state enters an observation bus.

```text
Android callbacks
      ↓
Observation Bus
      ↓
deterministic reducers
      ↓
Context Graph
```

Example:

```text
User
├── activity = walking
├── audio_route = headphones
├── place_context = commute
├── next_event = +18m
└── attention_state = medium

Device
├── battery = 37%
├── charging = false
├── network = cellular
├── thermal = nominal
└── screen = off
```

The Context Graph is primarily working memory.

It is not a permanent history of the user’s physical life.

---

# 13. Context projection

The model never receives the complete graph by default.

```text
Context Graph
    ↓
relevance/minimization
    ↓
Context Projection
    ↓
Native Pi
```

For:

```text
"Should I leave now?"
```

the projection may include:

- current approximate place;
- next event;
- route/travel estimate;
- relevant transport context.

It should not include unrelated notification streams or device sensor trivia.

---

# 14. Attention Governor

The Attention Governor decides whether information should affect the user’s attention.

It is deterministic policy informed by observations and optional model hints.

It owns decisions such as:

```text
DROP
BATCH
SILENT
NOTIFY
HEADS_UP
VOICE
URGENT
```

## 14.1 High-consequence floors

Known high-consequence facts must come from deterministic sources where practical:

- user-designated important contacts;
- known family contacts;
- Android alarm channels;
- repeated incoming calls;
- explicit high-priority app channels;
- deadlines;
- security/system alerts;
- user-configured emergency patterns.

A neural classifier cannot erase these floors.

Example:

```text
known important contact
    ↓
minimum attention = NOTIFY
```

Even if an edge model believes the message is low urgency.

---

## 14.2 Suppression asymmetry

Suppression must be harder than escalation.

A neural hint may justify:

```text
BATCH → NOTIFY
```

more easily than:

```text
NOTIFY → DROP
```

Uncertain high-consequence cases fail toward visibility/escalation.

---

## 14.3 Optional simple ceilings

For V2 Product, deterministic source-specific ceilings may exist.

Example:

```text
routine CI bot
maximum attention = NOTIFY
```

The generalized floor/ceiling framework is not required before implementation proves the need for it.

---

# 15. Capability model

A capability is a system primitive, not merely an LLM tool.

It may be invoked by:

- the primary agent;
- deterministic automation;
- UI;
- proactive logic;
- a user action;
- a delegated agent.

Example namespaces:

```text
device.*
voice.*
vision.*
screen.*
notification.*
apps.*
communication.*
personal.*
files.*
web.*
waywiser.*
remote.*
```

---

# 16. CapabilitySpec

Every protected capability declares:

```rust
CapabilitySpec {
    name,
    description,

    input_schema,
    output_schema,

    risk,

    permissions,

    side_effect,

    replay_policy,

    execution_mode,

    reversible,

    dry_run_support,

    sensitivity
}
```

Unknown capabilities do not execute.

---

# 17. ActionIntent

Protected side effects enter the system as a durable typed proposal.

```rust
ActionIntent {
    id,

    origin,

    capability,
    arguments,

    reason,

    session_id,
    goal_id,
    work_item_id,

    evidence,

    idempotency_key,

    requested_at
}
```

This separates planning from authorization.

---

# 18. Security kernel

Flow:

```text
ActionIntent
    ↓
Capability exists?
    ↓
Risk classification
    ↓
Waywiser policy
    ↓
OS permission
    ↓
Approval lease?
    ↓
User / biometric approval if required
    ↓
Execute
    ↓
ActionReceipt
```

The security kernel has:

- no LLM dependency;
- no model-generated policy;
- no ability to silently reinterpret unknown behavior as safe.

It is security-critical trusted computing base.

“Fail closed” applies to designed error and unknown states.

It does **not** imply arbitrary kernel bugs are harmless.

Therefore this subsystem receives disproportionate testing.

---

# 19. ActionReceipt

Every meaningful side effect produces a durable receipt.

```rust
ActionReceipt {
    intent_id,
    capability,

    started_at,
    completed_at,

    status,

    external_reference,

    reversible,
    undo_token,

    verification,

    result_summary
}
```

User-facing Activity Ledger can show:

```text
18:42  Rescheduled dentist appointment

Why:
Conflict with flight.

Authority:
Calendar lease valid until 20:00.

Verification:
External calendar confirmed.

[Undo]
[Don't do this automatically]
```

---

# 20. Replay and ambiguous side effects

Every side-effecting capability declares one of:

```text
SAFE_REPLAY
NEVER_REPLAY
VERIFY_BEFORE_RETRY
```

If the process dies after external dispatch but before confirmation:

```text
UNKNOWN_SIDE_EFFECT
```

The system must verify external state if possible.

It must not simply retry.

---

# 21. Approval leases

Scoped autonomy is represented explicitly.

Example:

```yaml
capability: calendar.update

scope:
  account: work

constraints:
  forbid:
    - delete

valid_until: 18:00
max_executions: 5
```

Approval leases are:

- scoped;
- expiring;
- auditable;
- revocable;
- budgeted.

No learned skill may grant itself a lease.

---

# 22. Accessibility-backed Device Automation

Internal distribution permits Waywiser to use AccessibilityService as a long-tail device automation mechanism where Android allows it.

It is not the preferred integration path.

Priority order:

```text
1. Native Waywiser capability
2. Official application API
3. AppFunction
4. Android Intent
5. Verified deep link
6. Notification action
7. Accessibility semantic automation
8. Visual coordinate automation
```

---

# 23. Accessibility deterministic risk classifier

The model does not determine the final risk class of a UI action.

Risk classification proceeds in this order:

```text
1. sensitive-package policy
2. reviewed app automation profile
3. deterministic semantic rules
4. primitive action-type floor
5. unknown fallback
```

Risk may only stay the same or increase as uncertainty is introduced.

---

## 23.1 Sensitive-package policy

Example:

```yaml
com.example.bank:
  automation: block
  floor: financial

com.password.manager:
  automation: block

com.android.settings:
  floor: device_control
```

Default protected categories:

- banking;
- password managers;
- authenticators;
- credential UI;
- package installers;
- sensitive security settings.

---

## 23.2 Reviewed Automation Profiles

High-value internal applications can receive human-reviewed mappings.

Example:

```yaml
package: com.company.mail

nodes:
  send_button:
    resourceId: "com.company.mail:id/send"
    effect: communication.send
    risk: communication
```

Profiles are versioned and reviewed.

---

## 23.3 Deterministic semantic rules

Examples:

```text
send|reply|publish|post
    → communication floor

pay|purchase|buy|checkout|transfer
    → financial floor

delete|remove|erase
    → destructive floor

install|uninstall|permission
    → device_control floor

save|submit|apply|confirm
    → cross_app_write floor
```

LLM interpretation may be logged as a non-authoritative hint.

It cannot lower this result.

---

## 23.4 Primitive action floors

Examples:

```text
inspect tree   → read_personal
scroll         → read_personal
open app       → device_control
click          → device_control
toggle         → device_control
type text      → cross_app_write
paste          → cross_app_write
gesture        → device_control
```

---

## 23.5 Unknown fallback

Unknown UI write:

```text
risk = ui_unclassified_write
```

Default:

```text
ASK_USER
```

or block, depending policy.

No permanent wildcard approval for all unknown UI writes.

---

# 24. Accessibility TOCTOU protection

The UI may change between planning and action.

Immediately before a side effect:

```text
re-resolve target
      ↓
fingerprint still matches?
      ├── yes → execute
      └── no  → abort + replan
```

Node fingerprint may use:

- package;
- window;
- resource ID;
- role/class;
- normalized text;
- contentDescription;
- ancestor signature;
- state;
- approximate region.

---

# 25. Post-action verification

Significant UI actions require observation afterward.

```text
Action
  ↓
new Accessibility snapshot
  ↓
expected transition?
```

Possible verification:

```text
VERIFIED
LIKELY
UNEXPECTED
UNKNOWN
```

`UNEXPECTED` halts further side effects.

---

# 26. Accessibility tree quality

The runtime may classify UI-tree quality as:

```text
GOOD
PARTIAL
POOR
UNUSABLE
```

Strategy:

```text
GOOD
→ semantic Accessibility automation

PARTIAL
→ semantic tree + optional visual verification

POOR
→ visual reasoning + stronger approval

UNUSABLE
→ refuse autonomous operation or require user-assisted mode
```

---

# 27. Secure windows

Secure-window restrictions are treated explicitly.

If Android denies screenshots because of secure content:

```text
visual automation = unavailable
```

Semantic Accessibility information may or may not remain available depending on the target application.

Protected-package policy still applies.

The runtime must never fabricate visual context.

---

# 28. Brain architecture

The existing Waywiser Brain design is retained semantically.

Core concepts:

```text
Provenance
Observation
Experience
Memory
Procedure
Skill Version
Evolution Run
Recall
```

---

# 29. Brain learning pipeline

```text
Experience
   ↓
Pass 1 deterministic extraction
   ↓
durable signal?
   ↓
deferred Pass 2 reflection
   ↓
candidate memory/procedure
   ↓
deterministic validation
   ↓
persist
```

The reflective model proposes meaning.

Deterministic validation decides provenance and confidence ceilings.

---

# 30. Delayed reflection is intentional

Brain reflection is not latency-critical.

With a single central inference slot, the preferred behavior is:

```text
immediate:
Experience persisted
Pass 1 deterministic

later:
reflection
consolidation
skill compilation
evaluation
```

This may happen seconds, minutes, or hours later.

Evidence is durable first.

Inference is opportunistic second.

---

# 31. Procedure model

A procedure represents a repeated operational pattern such as:

```text
WHEN X
AVOID Y
PREFER Z
```

Procedure maturity must be evidence-driven.

One clever LLM answer does not become a procedure.

---

# 32. Skill evolution

Retain the current conceptual pipeline:

```text
mature procedure
    ↓
skill compiler
    ↓
deterministic validation
    ↓
candidate
    ↓
evaluation against baseline
    ↓
pass / fail
    ↓
promotion at safe boundary
```

A running session must never have its active skill set silently mutate mid-turn.

---

# 33. Skill format

Skills remain declarative and human-readable.

```text
skill/
├── SKILL.md
├── manifest.yaml
├── evals/
└── resources/
```

`SKILL.md` contains operational natural-language guidance.

The manifest contains deterministic authority requirements.

A skill cannot obtain a capability simply by naming it in prose.

---

# 34. PA Profiles

A profile is a configuration composition, not a separate model.

Examples:

```text
General
Founder
Manager
Developer
Journalist
Researcher
Family
Travel
```

A profile selects:

- skills;
- capability defaults;
- proactive behavior;
- memory defaults;
- delegation budgets;
- notification style.

Brain continues personalizing behavior afterward.

---

# 35. Goals and work graph

Kanban remains useful UI.

It is not the deepest autonomous-work ontology.

Native durable model:

```rust
WorkItem {
    id,
    goal_id,

    title,
    description,

    status,
    priority,

    dependencies,

    assignee,

    agent_session_id,

    attempts,

    due_at,

    evidence,

    result,

    approval_state
}
```

Suggested lifecycle:

```text
proposed
    ↓
ready
    ↓
running
    ↓
review
    ├── done
    └── blocked
```

Kanban becomes a projection of this graph.

---

# 36. Native delegation

Current Waywiser subprocess delegation becomes Native AgentSupervisor.

```text
AgentSupervisor
├── primary
├── learner
├── skill-compiler
├── planner
├── research-1
├── research-2
└── work-item-41
```

Default child classes:

### Primary

Full user-facing context.

### Leaf

Focused context, cannot delegate.

### Orchestrator

May create children within depth/budget limits.

### Cognition worker

Internal Brain work, no external side effects.

### Verification agent

Can inspect evidence, cannot mutate external state.

---

# 37. Delegation budgets

Per parent/goal:

```text
max_children
max_depth
max_input_tokens
max_output_tokens
max_wall_time
max_external_writes
```

Multi-agent parallelism is a logical capability.

It does not imply simultaneous GPU inference.

---

# 38. Authoritative inference backend

The company reasoning endpoint is:

```text
Company Inference Gateway
    ↓
Ollama baseline
    ↓
Qwen3.8-27B
```

Current production model artifact:

```text
Qwen3.8-27B
approved Unsloth GGUF
```

---

# 39. Model identity vs serving infrastructure

The architectural invariant is:

```text
Qwen3.8-27B
```

The current deployment format is:

```text
Unsloth GGUF + Ollama
```

Future serving-engine or serialization changes are permitted only through an explicit infrastructure decision and conformance validation.

The product must not couple itself to a file extension.

Candidate future serving engines may include:

- Ollama;
- llama.cpp server;
- vLLM-compatible deployment.

No migration occurs simply because a benchmark claims higher throughput.

Correctness comes first.

---

# 40. Model alias

The app requests a stable alias such as:

```text
waywiser-primary
```

The inference gateway maps it to the exact validated deployment.

The app should not hard-code a raw GGUF filename.

---

# 41. Inference manifest

The gateway should expose a Waywiser-specific manifest.

Example:

```json
{
  "protocol": 1,

  "backend": "ollama",

  "model": {
    "alias": "waywiser-primary",
    "family": "Qwen3.8-27B",
    "artifact": "approved-unsloth-gguf",
    "sha256": "...",

    "capabilities": {
      "text": true,
      "vision": true,
      "tools": true,
      "thinking": true
    },

    "operationalContext": 65536
  }
}
```

The app verifies expected model identity.

A silent server-side swap to a different model is a health failure.

---

# 42. Operational context vs maximum context

Maximum model context does not equal normal runtime context.

The gateway exposes an operational budget.

Native Pi continues using:

- compaction;
- selective memory;
- contextual projection;
- bounded tool history.

Long context is capacity, not permission to dump history indiscriminately.

---

# 43. Single-slot Ollama Foundation constraint

For the current Qwen3.8/Ollama combination, Foundation must treat the backend as:

```text
authoritative inference capacity = 1 active generation slot
```

Therefore:

```text
P0 interactive
P1 explicit foreground work
P2 delegated work
P3 Brain reflection
P4 evolution/evals
```

P2–P4 use slack capacity.

This is an explicit Foundation limitation.

---

# 44. Background inference is preemptible

If an interactive request arrives while Brain reflection is generating:

```text
cancel background generation
    ↓
serve foreground request
    ↓
resume/retry background job later
```

Background work should use bounded inference chunks where possible.

---

# 45. Serving-engine benchmark gate

Before V2 Product is declared suitable for wider internal use, benchmark the real Waywiser workload against:

```text
current Ollama
candidate llama.cpp server
candidate vLLM deployment
```

using exact validated Qwen3.8 artifacts/configurations.

Benchmark workloads:

| Workload | Typical prompt | Typical output |
|---|---:|---:|
| Simple voice/chat | 1–2K | 100–200 |
| Normal PA | 4–8K | 300–800 |
| Tool turn | 8–16K | 100–500 |
| Brain reflection | 8–20K | 500–1500 |
| Research | 16–32K | 500–2000 |
| Long-context | 64K | bounded |

At concurrency:

```text
1
2
4
8
```

Measure:

- queue wait;
- TTFT;
- prompt throughput;
- generation throughput;
- p50/p95/p99 latency;
- VRAM;
- RAM;
- correctness;
- tool-call quality;
- JSON quality;
- vision quality;
- cancellation behavior;
- soak stability.

Serving-engine migration is a benchmark result, not a philosophical preference.

---

# 46. Authentication

The app never embeds a master inference key.

Architecture:

```text
device enrollment
    ↓
device/user-scoped token
    ↓
Android Keystore
    ↓
Authorization
    ↓
Company Inference Gateway
```

Tokens support:

- revocation;
- rotation;
- attribution;
- expiry where practical.

For small internal deployments, enrollment may initially be manual.

MDM or a self-service portal can be added when user count justifies it.

---

# 47. Utility inference

Auxiliary neural inference is permitted under I6.

Examples:

- BGE-M3 embeddings;
- Android ASR;
- OCR/CV;
- optional edge micro-model.

These systems produce evidence or structured hints.

They do not become Pi agents.

---

# 48. Existing BGE-M3 semantic recall

Current Waywiser already uses BGE-M3 as a separate embedding model.

The native port must not accidentally remove this existing capability unless a replacement is intentionally chosen.

Baseline behavior:

- embedding generation is fail-soft;
- semantic score is optional;
- lexical/scope/usage/confidence/recency signals still function when embeddings are unavailable.

---

# 49. Embedding contracts

```rust
EmbeddingProvider {
    embed(text)
    embed_batch(texts)
}
```

and:

```rust
VectorIndex {
    upsert(...)
    remove(...)
    search(...)
}
```

remain separate abstractions.

Every vector records:

- embedding model ID;
- model/version signature;
- dimension;
- source revision;
- creation time.

Incompatible embedding spaces are never mixed.

---

# 50. Vector migration

When embedding models change:

```text
old index continues serving
        ↓
new index builds independently
        ↓
validate completeness/quality
        ↓
atomic switch
        ↓
retire old index
```

No mixed-vector search.

---

# 51. Optional edge semantic accelerator

The edge model is **not a Foundation dependency**.

It is a parallel experimental track.

Its normative properties only are:

```text
optional
bounded
structured-output oriented
non-agentic
non-authoritative
cannot execute capabilities
cannot lower deterministic risk
cannot create durable beliefs directly
cannot independently suppress high-consequence signals
```

The exact API is intentionally unspecified until benchmark results exist.

---

# 52. Candidate edge runtimes/models

Initial experiment candidates:

### Candidate A

```text
Qwen3-0.6B-class
LiteRT-LM
INT4
```

### Candidate B

```text
FunctionGemma 270M-class
LiteRT-LM
```

### Candidate C

```text
Qwen3-0.6B-class GGUF
llama.cpp Android
```

The winner is determined by measured task quality, latency, memory, battery, and thermal behavior.

Model-family symmetry with the server has no architectural value by itself.

---

# 53. Edge device target

The existing Samsung Galaxy S21+ class device with approximately 8 GB RAM is the initial low/mid-capability benchmark target.

CPU execution is the required baseline.

GPU/NPU acceleration is an optimization only after successful initialization and soak testing on the exact device.

No assumption is made that an older Exynos/Mali stack will support every accelerated backend reliably.

---

# 54. Edge model residency

States:

```text
COLD
WARM
HOT
```

Policy examples:

```text
foreground conversation
→ HOT if useful

active camera/voice session
→ HOT if useful

screen-off idle
→ unload after grace period

thermal pressure
→ unload

memory pressure
→ unload immediately
```

Cold-load time becomes an observed runtime property.

The Attention Governor must not wait several seconds to cold-load a model for a signal that can be handled deterministically.

---

# 55. Edge experiment is parallel, not gating

Core 90-day architecture proof does not depend on the edge model.

If the experiment fails:

```text
deterministic local processing
        ↓
remote Qwen escalation
```

still ships.

If it succeeds, it improves:

- latency;
- offline behavior;
- central GPU load;
- proactive semantic filtering.

---

# 56. Edge benchmark

Initial spike benchmark may use approximately 250 carefully selected cases across:

- notification classification;
- intent routing;
- semantic TTL;
- context relevance;
- UI semantic hints.

Measure:

- structured-output validity;
- accuracy against deterministic/human labels;
- cold load;
- warm latency;
- memory;
- thermal behavior;
- battery impact;
- CPU vs GPU where applicable;
- soak stability.

A larger multilingual benchmark becomes V2 Intelligence work if the experiment proves worthwhile.

Important languages:

- Romanian;
- Russian;
- English;
- mixed-language text.

---

# 57. Voice architecture

Voice pipeline:

```text
invocation / push-to-talk / supported hotword
    ↓
VAD
    ↓
STT
    ↓
Native Pi
    ↓
streamed answer
    ↓
TTS
```

Barge-in:

```text
Waywiser speaking
    ↓
user speaks
    ↓
stop TTS
    ↓
STT
    ↓
Pi steering
```

Speech recognition is perception, not deliberative reasoning.

TTS is presentation.

Neither violates I6.

---

# 58. Assistant role

Waywiser should optionally support Android Assistant role / VoiceInteractionService.

The product must still work if:

- another assistant owns the role;
- OEM behavior differs;
- the user refuses;
- the platform capability is unavailable.

Baseline invocation remains available through:

- app;
- widget;
- notification;
- shortcut;
- share;
- explicit microphone control.

---

# 59. Screen context

Where Assistant APIs allow:

```text
AssistStructure
AssistContent
optional screenshot
```

become structured observations.

Waywiser must explicitly represent:

```text
AVAILABLE
PARTIAL
SECURE_BLOCKED
UNAVAILABLE
```

No invented context.

---

# 60. Camera architecture

```text
CameraX
    ↓
cheap frame/change selection
    ↓
local OCR / barcode / CV
    ↓
VisualScene
    ↓
selective Qwen vision
```

Do not send every frame to the server.

---

# 61. Visual working memory

```rust
VisualScene {
    objects,
    visible_text,
    active_object,
    relationships,
    last_change,
    confidence
}
```

Supports interactions such as:

```text
"What's this?"
"And what does the label on the back say?"
```

Raw frames remain ephemeral unless the user explicitly captures/persists them.

---

# 62. Notification intelligence

With explicit Android permission:

```text
NotificationListenerService
    ↓
normalizer
    ↓
deterministic classification
    ↓
optional edge hint
    ↓
Attention Governor
```

Raw notification streams are not blindly fed to the authoritative model.

---

# 63. Native AppFunctions, intents, deep links

Cross-app action resolver preference:

```text
Native capability
    ↓
AppFunction
    ↓
Intent
    ↓
Verified deep link
    ↓
Notification action
    ↓
Accessibility
```

AppFunctions are treated as a replaceable adapter, not a core dependency.

---

# 64. Background reliability

Android lifecycle behavior and OEM behavior are first-class runtime concerns.

Define:

```text
BackgroundReliabilityManager
```

Responsibilities:

- detect actual background delays/failures;
- identify whether background operation is healthy;
- expose degradation;
- measure missed/delayed scheduled work;
- provide device-specific internal guidance where justified.

States:

```text
HEALTHY
LIMITED
SEVERELY_RESTRICTED
UNAVAILABLE
```

The application must never claim proactive functionality is healthy when the device repeatedly prevents it.

---

# 65. Scheduling

Use platform-native scheduling.

### Active foreground work

Coroutine/native runtime.

### Reliable deferred work

WorkManager.

### Exact user-facing alarm

AlarmManager only where semantically required.

### User-visible long operation

Foreground service where Android allows and product behavior justifies it.

### Environmental event

Native callback/listener where available.

Waywiser does not simulate an immortal Linux daemon.

---

# 66. Deferred reasoning queue

Signals requiring authoritative reasoning may be durably deferred.

```rust
ReasoningJob {
    id,
    cause,
    created_at,
    relevance_rule,
    priority,
    context_refs
}
```

Before execution:

```text
still relevant?
    ├── yes → reason
    └── no  → expire
```

Relevance is semantic, not just “older than N minutes”.

---

# 67. Offline/degraded behavior

When authoritative inference is unavailable, Waywiser still supports:

- capture;
- local memory persistence;
- lexical recall;
- cached calendar/context;
- deterministic automations;
- local scheduled notifications;
- context collection;
- permission enforcement;
- work state;
- local OCR/barcode;
- Activity Ledger;
- future reasoning queue.

Unavailable:

- open-ended deliberative conversation;
- reflective Brain Pass 2;
- skill compilation/evaluation;
- complex research;
- semantic VLM reasoning;
- new LLM-generated plans.

The UI must state the degraded condition plainly.

---

# 68. Storage

Recommended durable domains:

## `pi_sessions.db`

- sessions;
- entries;
- lanes;
- operations;
- queues;
- usage;
- compaction metadata.

## `waywiser.db`

- memories;
- experiences;
- procedures;
- procedure evidence;
- skills;
- skill versions;
- evolution runs;
- goals;
- work items;
- work dependencies;
- automations;
- approval leases;
- action intents;
- action receipts;
- integration state;
- durable observations where justified.

---

# 69. Stable identity and future sync

Externally meaningful durable entities use globally unique sortable IDs.

Recommended:

```text
UUIDv7
```

Mutation metadata includes at least:

- mutation ID;
- device ID;
- local sequence;
- wall-clock timestamp.

This does not implement synchronization.

It avoids designing a schema hostile to future sync.

---

# 70. Files

Application-controlled files may include:

```text
files/
└── waywiser/
    ├── SOUL.md
    ├── USER.md
    ├── skills/
    │   ├── active/
    │   ├── candidates/
    │   └── retired/
    ├── vault/
    ├── exports/
    ├── workspace/
    └── diagnostics/
```

No fake Unix `$HOME` dependency is required.

---

# 71. Secrets

Secrets are stored through Android Keystore-backed protection.

Never store:

```text
master API key
```

inside the APK.

High-sensitivity stored data may receive additional field/blob encryption.

---

# 72. Internal APK updates

Because Google Play is absent, update security is Waywiser’s responsibility.

```text
GitLab Release
    ↓
signed release manifest
    ↓
download APK
    ↓
verify manifest signature
    ↓
verify APK hash/signature
    ↓
installer / MDM / internal update path
```

Never trust HTTPS alone.

---

# 73. Update manifest

Example:

```json
{
  "version": "2.4.1",
  "versionCode": 20401,
  "sha256": "...",
  "channel": "stable",
  "minSupportedVersion": "2.2.0",
  "signature": "..."
}
```

Channels:

```text
dev
canary
beta
stable
```

---

# 74. Rollback and safe mode

APK downgrade may not always be silently possible.

Support:

### Runtime rollback

- feature flags;
- skill versions;
- automation profiles;
- server model deployment;
- dynamic configuration.

### APK recovery

Depending on company installer/MDM capability:

- managed rollback;
- dedicated updater;
- forward rollback build using a higher versionCode;
- manual recovery APK.

### Safe mode

Repeated startup failures should allow a minimal path that can disable:

- agent runtime;
- Accessibility;
- camera;
- voice;
- MCP;
- experimental features;
- background jobs.

Safe mode should support diagnostics and update/recovery.

---

# 75. Testing strategy

## Rust unit and conformance

- Pi semantics;
- Brain;
- permissions;
- replay;
- recovery;
- work graph.

## Property-based security tests

Critical invariants:

```text
uncertainty cannot lower risk
unknown capability cannot execute
unknown UI write cannot auto-authorize
expired lease cannot authorize
planning cannot bypass permission
```

## Fuzzing

- capability schemas;
- malformed ActionIntent;
- Accessibility trees;
- session recovery records;
- external response parsing.

## Mutation testing

Especially security classifiers.

---

# 76. Android tests

## JVM/Robolectric

- context adapters;
- ViewModels;
- policy logic;
- intent construction.

## Compose

- navigation;
- state restoration;
- accessibility semantics;
- font scaling;
- configuration changes.

## Instrumentation

- JNI/FFI;
- Binder;
- SQLite;
- Keystore;
- WorkManager;
- notifications;
- services;
- CameraX;
- permission revocation.

## Macrobenchmark

- cold start;
- warm start;
- agent wake;
- memory;
- scrolling;
- background recovery.

---

# 77. Fault injection

Mandatory scenarios:

```text
kill process during model stream
kill after side-effect dispatch
kill before receipt persistence
network loss
gateway timeout
wrong model manifest
database busy
database full
OS permission revoked
Accessibility target changes before click
AppFunction disappears
remote execution node disconnects
device enters Doze
device overheats
low-memory kill
activity recreation
```

---

# 78. FFI architecture proof

The Kotlin↔Rust spike succeeds only if it demonstrates:

- streaming events;
- cancellation;
- Activity destruction during stream;
- Activity recreation;
- process recreation;
- structured error propagation;
- Rust panic containment;
- large-payload handling;
- concurrent event delivery;
- backpressure;
- memory stability;
- no JNI reference leakage in soak tests.

Do not port the entire Brain before this bridge is trusted.

---

# 79. Delivery tiers

## V2 Foundation

Goal:

> Prove Native Pi + Native Waywiser.

Includes:

- minimal Pi agent loop;
- sessions;
- Ollama/Qwen backend;
- tool execution;
- steering/abort;
- memory;
- basic Brain deterministic Pass 1;
- permissions;
- skills loading;
- minimal Compose host;
- Kotlin↔Rust bridge.

---

## V2 Product

Goal:

> Useful internal Android PA replacing Termux.

Adds:

- voice;
- notifications;
- calendar;
- capture;
- WorkManager;
- goals/work;
- delegation;
- proactive basics;
- Activity Ledger;
- Trust/permission UI;
- signed internal updater;
- degraded/offline behavior.

---

## V2 Intelligence

Adds:

- richer Context Graph;
- stronger Attention Governor;
- optional edge semantic accelerator;
- camera VisualScene;
- Assistant integration;
- richer Brain reflection;
- semantic memory improvements;
- AppFunctions.

---

## V2 Agency

Adds:

- reviewed Accessibility automation;
- UI semantic profiles;
- advanced cross-app workflows;
- richer autonomous work;
- optional remote execution nodes;
- broader internal workflow automation.

---

# 80. 90-day core architecture proof

The first 90 days should prove the expensive architectural assumptions.

## Rust track

- Pi lifecycle;
- one Ollama/Qwen backend;
- SQLite session storage;
- one tool/capability;
- steering;
- abort;
- basic Brain Experience representation;
- deterministic Pass 1;
- deterministic provenance;
- lexical recall.

## Android track

- Compose host;
- Kotlin↔Rust bridge;
- streaming;
- cancellation;
- Activity recreation;
- Keystore-scoped inference token;
- one real Android capability.

## Vertical integration target

```text
User asks
    ↓
Kotlin
    ↓
Rust Native Pi
    ↓
company Qwen endpoint
    ↓
model proposes tool
    ↓
security kernel
    ↓
Android capability
    ↓
tool result
    ↓
Qwen
    ↓
streamed answer
```

If this vertical slice is unreliable, broader porting stops.

---

# 81. Parallel 90-day experiments

These are useful but do not gate Foundation.

### Edge experiment

- Qwen3-0.6B/LiteRT;
- FunctionGemma/LiteRT;
- llama.cpp/GGUF baseline.

### Serving benchmark preparation

- collect realistic traces;
- instrument Ollama latency;
- validate cancellation;
- characterize single-slot behavior.

### Assistant-role spike

- ROLE_ASSISTANT;
- VoiceInteractionService;
- screen-assist context.

Failure of any of these does not invalidate the core Native Pi/Android architecture.

---

# 82. Staffing envelope

Planning ranges, not commitments.

For approximately four highly capable senior engineers:

```text
Native Foundation:
~6–10 months

First useful internal Android product:
~10–16 months total

Strong Context/Voice/Vision product:
~18–30 months

Most of the long-term vision:
~30–48+ months
```

With more focused parallel staffing, earlier Product delivery is possible.

The primary schedule risks are:

- Pi semantic port;
- FFI reliability;
- Brain migration;
- Android lifecycle/OEM behavior;
- inference serving capacity.

Not Compose screen layout.

---

# 83. Explicit non-goals for Foundation/Product

Not required before V2 Product:

- public Play Store distribution;
- iOS;
- desktop-native Rust app;
- full cross-device sync;
- arbitrary app automation;
- permanent local micro-model;
- fine-tuned Waywiser Edge;
- multi-GPU serving cluster;
- autonomous purchasing;
- financial execution;
- root integration;
- unrestricted shell;
- downloaded arbitrary native plugins.

---

# 84. Fine-tuned Waywiser Edge

A purpose-built edge model is a V2 Intelligence+ possibility.

It must not be trained before useful real data exists.

Possible future tasks:

- signal assessment;
- intent routing;
- semantic TTL;
- context relevance;
- UI semantic hints;
- skill routing.

Required first:

```text
real usage
human corrections
edge predictions
Qwen predictions
Attention decisions
user outcomes
```

Synthetic optimism is not a training dataset.

---

# 85. Architectural review split

Before broad engineering proceeds, this blueprint should spawn six smaller normative RFCs.

## RFC-001 — Native Runtime Architecture

Owns:

- Kotlin/Rust split;
- process topology;
- storage;
- FFI;
- runtime lifecycle;
- migration.

## RFC-002 — Pi Semantic Compatibility

Owns:

- lifecycle;
- messages;
- sessions;
- lanes;
- tools;
- queues;
- compaction;
- recovery;
- conformance.

## RFC-003 — Capability Security & Device Agency

Owns:

- ActionIntent;
- CapabilitySpec;
- permission kernel;
- leases;
- receipts;
- replay;
- Accessibility risk classification.

## RFC-004 — Brain, Memory & Evolution

Owns:

- provenance;
- observation;
- experience;
- memory;
- procedures;
- skills;
- evolution;
- embeddings.

## RFC-005 — Inference Infrastructure

Owns:

- Qwen3.8 deployment;
- gateway;
- authentication;
- manifest;
- Ollama baseline;
- serving benchmark;
- model conformance.

## RFC-006 — Android Context & Edge Intelligence

Owns:

- Context Graph;
- Attention Governor;
- background reliability;
- voice;
- camera;
- notifications;
- optional edge experiment.

Product UX belongs in a separate PRD.

---

# 86. Product Requirements Document boundary

A separate PRD should own:

- NOW screen;
- ASK;
- TODAY;
- BRAIN inspector;
- Trust Center;
- onboarding;
- progressive permission UX;
- background reliability UX;
- update UX;
- diagnostics presentation.

Architecture defines states and contracts.

Product design decides how humans experience them.

---

# 87. Implementation principles

When in doubt:

### Preserve semantics, not implementation accidents

Do not port:

```text
spawn("pi")
```

Port:

```text
isolated child agent
```

Do not port:

```text
Termux battery command
```

Port:

```text
battery observation
```

Do not port:

```text
node:vm execute_code
```

Port:

```text
validated execution plan
```

---

### Prefer typed capabilities over URI/UI trivia

Pi should reason about:

```text
navigation.navigate(...)
calendar.update(...)
communication.send(...)
```

not raw Android intent flags or screen coordinates.

---

### Keep authority below models

Every model is untrusted relative to protected state transitions.

---

### Keep expensive inference above deterministic preprocessing

Most phone events are boring.

The architecture should let them remain boring.

---

### Make recovery normal

Android will kill processes.

Networks will disappear.

Inference will timeout.

External systems will answer ambiguously.

Those are normal operating conditions.

---

### Make learning inspectable

The user should be able to answer:

```text
What does Waywiser believe?
Why?
Where did it come from?
How confident is it?
What changed?
Can I correct/delete it?
```

---

# 88. Final architecture statement

Waywiser v2 is not:

```text
Waywiser desktop + Android UI
```

and not:

```text
Pi + Termux + more mobile commands
```

It is:

```text
Android perception and action
        ↓
deterministic local context
        ↓
optional bounded utility inference
        ↓
Native Waywiser
        ↓
Native Pi
        ↓
company-hosted Qwen3.8-27B
        ↓
proposed intent
        ↓
deterministic authority kernel
        ↓
verified action
        ↓
experience
        ↓
learning
```

The important product property is not model diversity.

The model is infrastructure.

The product is the runtime around it:

- what Waywiser knows;
- what it observes;
- what it remembers;
- what it can safely do;
- what it refuses to do;
- how it recovers;
- how it decides whether to interrupt;
- how it supervises work;
- how it learns;
- how it exposes all of this to the user.

The core security boundary is:

> **Qwen3.8 may propose interpretation and actions. It never authorizes protected machine-state transitions.**

The core epistemic boundary is:

> **Observation does not become belief merely because a model saw it.**

The core product boundary is:

> **Waywiser is a persistent personal intelligence runtime whose conversation UI is only one way of interacting with it.**

---

# 89. Engineering kickoff order

Architecture work and implementation now proceed in parallel.

```text
TRACK A
Consolidate RFC-001 and RFC-002

TRACK B
Build Kotlin ↔ Rust vertical spike

TRACK C
Extract Pi semantic fixtures

TRACK D
Prepare Ollama/Qwen model conformance fixtures

OPTIONAL TRACK E
Edge-model experiment
```

Do not wait for every RFC to become literary perfection before writing code.

The next phase should be empirical.

The architecture is now mature enough to be attacked by implementation.
