# waywiser

> Your data never leaves your machine. Memories, preferences, boards, and
> scheduled jobs live in `~/.waywiser/` — a SQLite database you own, files you
> can edit by hand, and a whole home you can nuke in one `rm -rf`. No telemetry,
> no cloud sync. Your LLM runs on your hardware or behind your own API key.

A proactive personal AI agent built on [pi](https://github.com/earendil-works/pi-coding-agent).
Waywiser doesn't wait to be spoken to — it monitors your boards, goals, and
deadlines, alerts you when something needs attention, adapts to your
communication style, and learns from corrections in real time. Extends pi with
persistent memory, a proactive cognition engine, behavioral meta-skills, task
delegation, project boards, MCP integrations, scheduled jobs, notifications,
and a permission engine — all as in-process TypeScript extensions. Nothing
patches pi's core.

## Architecture

```
waywiser/
├── extensions/                      ← Core agent extensions
│   ├── permissions.ts               ← Permission engine (risk taxonomy, planning mode, budgets)
│   ├── soul.ts                      ← SOUL.md identity persistence (append-only)
│   ├── memory.ts                    ← Cross-session memory (FTS5, RecallProvider, deterministic gate)
│   ├── memrules.ts                  ← Memory rules (gate patterns, Jaccard, validation)
│   ├── mem-dream.ts                 ← Memory consolidation (dedup, merge, conflicts)
│   ├── proactive.ts                 ← Proactive cognition engine (OODA loop, signal gathering)
│   ├── meta-skills.ts               ← Behavioral engines (EQ, discretion, adaptability, multi-tasking)
│   ├── brain/                       ← Persistent memory with procedural preferences (core — always loaded)
│   │   ├── index.ts                 ← Brain lifecycle (session, learning boundary, vault sync)
│   │   ├── store.ts                 ← BrainStore (SQLite, migrations, CRUD)
│   │   ├── recall.ts                ← Reciprocal rank fusion (lexical + scope + usage + confidence + recency + semantic)
│   │   ├── embeddings.ts            ← Embedding API (CPU-isolated, LRU cache, batch /api/embed)
│   │   ├── learner.ts               ← Two-pass learning (deterministic + LLM reflection)
│   │   ├── procedures.ts            ← Procedural preferences with evidence tracking
│   │   ├── evolve.ts                ← Auto-evolution pipeline (procedures → candidates → skills)
│   │   ├── cognition.ts             ← Cognition pool (pi RPC children for reflection)
│   │   ├── consolidate.ts           ← Dedup, merge, contradiction detection
│   │   ├── vault.ts                 ← Obsidian-native markdown sync (wikilinks, Properties, MOCs)
│   │   ├── trace.ts                 ← Experience trace (observations, outcomes)
│   │   ├── prompts.ts               ← Brain context rendering
│   │   ├── config.ts                ← Brain config loader
│   │   ├── policy.ts                ← Project-key detection, scoping
│   │   ├── eval.ts                  ← Competitive skill evaluation
│   │   ├── provenance.ts            ← Memory provenance tracking
│   │   ├── recovery.ts              ← Crash recovery
│   │   ├── skills.ts                ← Skill discovery, promotion, rollback
│   │   └── types.ts                 ← Brain type definitions
│   ├── kanban/                      ← Project boards (4 modules)
│   │   ├── index.ts                 ← Extension wiring, /kanban command, kanban tool
│   │   ├── ops.ts                   ← 25+ board/card CRUD operations
│   │   ├── worker.ts                ← Subagent card workers (spawnCard, waitCard)
│   │   └── shared.ts               ← Types, constants, DB helpers, nextCardId (UUID)
│   ├── kanban-server.ts             ← Localhost HTTP dashboard (token-authenticated, no CORS)
│   ├── kanban-html.ts               ← Board HTML/CSS generation (live + static snapshot)
│   ├── delegate.ts                  ← Task delegation via RPC subprocesses (warm pool, depth-2)
│   ├── execute-code.ts              ← Programmatic tool calling (vm.createContext sandbox + optional gondolin)
│   ├── cronjob.ts                   ← Scheduled jobs (cron parser, quiet hours, auto-pause on failure)
│   ├── notify.ts                    ← Desktop/Telegram/webhook notifications (spawn, no shell)
│   ├── mcp.ts                       ← MCP server loader (JSON-RPC 2.0 stdio, lazy connect, reconnect)
│   ├── web.ts                       ← Web search + extract (SSRF-guarded, HTML entity decoding)
│   ├── commands.ts                  ← Slash commands, goals (with budgets), /trace export, /journey
│   ├── skills-manage.ts             ← Playbook catalog (tier badges, auto-onboard trigger)
│   ├── todo-compat.ts               ← /todo → kanban compatibility shim
│   ├── clarify.ts                   ← User interaction tool
│   ├── index.ts                     ← Extension loader (fault-isolated, prompt assembly handler)
│   └── utils/
│       ├── state.ts                 ← Shared DB (SQLite WAL), registry, config, RecallProvider interface
│       ├── rpc.ts                   ← Pi RPC client + warm pool (lane-versioned, TTL-evicted)
│       ├── llmcall.ts               ← One-shot LLM child (queue-based semaphore, no deadlock)
│       ├── prompt-budget.ts         ← Priority-based prompt injection manager (cache telemetry)
│       ├── trace.ts                 ← Structured trace events (TraceEvent, logTrace, logLegacy)
│       └── url-guard.ts             ← SSRF protection (RFC1918, link-local, loopback, IPv6)
│
├── plugins/
│   └── obsidian/                    ← Obsidian integration (optional add-on)
│       ├── src/                     ← Plugin source (dashboard, commands, graph, watcher)
│       ├── main.js                  ← Built plugin
│       ├── manifest.json
│       ├── styles.css
│       └── sql-wasm.wasm
│
├── skills/
│   ├── waywiser/SKILL.md            ← Core operating skill (always loaded)
│   ├── brain/SKILL.md               ← Brain operating skill (always loaded)
│   └── pa-*/SKILL.md               ← 19 PA playbooks (bootstrapped to ~/.waywiser/skills/)
│       ├── pa-time-manage/          ✅ verified
│       ├── pa-doc-writer/           ✅ verified
│       ├── pa-stakeholder-comm/     ✅ verified
│       ├── pa-research/             ✅ verified
│       ├── pa-lifestyle/            ✅ verified
│       ├── pa-onboard/              ✅ verified
│       ├── pa-project-coord/        ⚠️ experimental
│       ├── pa-event-manage/         ⚠️ experimental
│       ├── pa-finance/              ⚠️ experimental
│       ├── pa-travel/               ⚠️ experimental
│       ├── pa-procurement/          ⚠️ experimental
│       ├── pa-decision-support/     ⚠️ experimental
│       ├── pa-process-improve/      ⚠️ experimental
│       ├── pa-tech-ops/             ⚠️ experimental
│       ├── pa-records/              ⚠️ experimental
│       ├── pa-hr-support/           🔬 untested
│       ├── pa-compliance/           🔬 untested
│       ├── pa-governance/           🔬 untested
│       └── pa-protocol/             🔬 untested
│
├── bin/
│   └── waywiser                     ← Launcher (core extensions, plugin discovery for extras)
│
├── config/
│   ├── SOUL.md                      ← Default identity template
│   ├── mcp.example.json             ← MCP server config example
│   ├── notify.example.json          ← Notification channel config example
│   └── brain.example.json           ← Brain config example (recall, embeddings, vault, evolution)
│
├── test/
│   ├── waywiser.test.ts             ← Core unit tests (memory, gate, recall, goals, traces, meta-skills)
│   ├── smoke.test.ts                ← Extension registration smoke test
│   ├── permissions.test.ts          ← Permission engine tests (classifier, policy, budget, planning)
│   ├── prompt-budget.test.ts        ← Prompt budget manager tests (ordering, trimming, cache)
│   ├── brain/                       ← Brain unit tests (18 files, 332 tests)
│   ├── security/
│   │   ├── execute-code-sandbox.test.ts  ← vm.createContext sandbox escape prevention
│   │   ├── url-guard.test.ts             ← SSRF URL blocking
│   │   ├── kanban-auth.test.ts           ← Session token auth verification
│   │   └── notify-spawn.test.ts          ← Shell injection prevention
│   └── e2e/                              ← End-to-end evals (require WAYWISER_E2E_MODEL)
│       ├── helpers.ts                     ← Test home, model gate, paths
│       ├── memory-roundtrip.test.ts       ← Remember → recall preference
│       ├── kanban-lifecycle.test.ts       ← Card new → move → done
│       ├── delegation.test.ts             ← Spawn leaf → collect report
│       ├── cron-fire.test.ts              ← Schedule one-shot → verify fire
│       └── adversarial.test.ts            ← Injection, oversized write, escape
│
├── docs/
│   ├── specs/                       ← Design specs (01-07)
│   ├── audits/                      ← 4 audit reports + remediation plan
│   └── research/                    ← Proactive capabilities, Ollama contention, memory latency
│
├── package.json                     ← 1 production dep (typebox), Node ≥22.5
├── SPEC.md                          ← Original design spec
└── LICENSE                          ← MIT
```

## Install

Node >= 22.5, `pi` on PATH.

```bash
git clone git@github.com:yoda-digital/waywiser.git
cd waywiser
npm install
bin/waywiser
```

That's it. Brain (persistent memory with procedural preferences, RRF recall,
auto-evolution, and vault sync) is a core component — it loads automatically
on every launch. On first run, Waywiser walks you through setup: timezone,
working hours, daily/weekly reviews, notification channels.

**What you get out of the box:**

**Proactive intelligence:**
- Proactive cognition engine — OODA loop ticks every 15 min, monitors
  boards/goals/deadlines, alerts without consuming GPU
- Emotional intelligence — detects frustration from message patterns,
  adapts communication style in real time
- Discretion — suppresses low-value alerts during deep focus, caps
  notifications, respects quiet hours
- Adaptability — catches corrections instantly ("no, use X"), creates
  memories and adjusts same-session
- Multi-tasking — spawns background subagents for queued work during
  idle periods

**Memory & learning:**
- Cross-session memory (FTS5 + Brain's reciprocal rank fusion recall)
- Deterministic memory extraction per turn (CPU, ~1ms — no GPU contention)
- LLM-powered reflective learning at conversation boundaries
- Procedural preferences ("when X, prefer Y over Z") with evidence tracking
- Auto-evolution: mature procedures → candidate skills → competitive eval
- Embedding on CPU (`num_gpu: 0`), LRU cache, batch API — zero GPU
  contention with generation
- Memory export/import for data portability
- SOUL.md identity with consolidation

**Tools & integrations:**
- Task delegation (3 concurrent subagents, depth-capped at 2)
- Kanban boards (authenticated web dashboard + TUI + markdown)
- MCP integrations (Gmail, Calendar, Notion, etc.)
- Scheduled jobs (cron + one-shot timers, auto-pause on repeated failures)
- Desktop/Telegram/webhook notifications
- 19 PA playbooks covering time management, writing, communication,
  research, finance, travel, procurement, governance, and more

**Safety & observability:**
- Permission engine (8 risk classes, configurable policy, /permissions)
- Planning mode (/plan blocks writes, /plan approve re-enables)
- Session budgets (200 tool calls, 10 subagent spawns)
- Sandboxed code execution (vm.createContext + optional Gondolin micro-VM)
- SSRF protection on web tools
- Structured trace events (/trace export)
- Goal budgets (/goal --max-steps --deadline --done)
- Prompt cache telemetry (/waywiser status)

### Optional: Obsidian Plugin

The Brain vault at `~/.waywiser/brain/` is already Obsidian-compatible
(wikilinks, Properties, callouts, mermaid). For a richer experience —
dashboard sidebar, command palette, graph coloring, confidence bars:

```bash
cd plugins/obsidian
npm install && npm run build
cp main.js manifest.json styles.css sql-wasm.wasm \
   /path/to/vault/.obsidian/plugins/waywiser-brain/
```

Enable in Obsidian → Settings → Community Plugins.

## Proactive Engine

Waywiser runs a continuous OODA loop (Observe-Orient-Decide-Act) between
user interactions. Every 15 minutes (30 during quiet hours), it:

1. **Senses** — SQL-only signal gathering (zero LLM cost): overdue kanban
   cards, goals past deadline, goals near budget, cron failures, evolution
   candidates, user absence
2. **Orients** — priority scores each signal (P0 interrupt → P3
   background), deduplicates (1-hour window), applies discretion filter
3. **Decides + Acts** — P0 alerts via desktop/Telegram (no GPU); P1-P2
   triggers agent turn via `sendUserMessage` followUp; P3 runs silently

The engine pauses during active conversation and re-arms when the agent
settles. `/proactive` controls it (on/off/tick/signals/status). Config
via `~/.waywiser/config.json`:

```json
{
  "proactive": {
    "enabled": true,
    "tickActiveMs": 900000,
    "tickQuietMs": 1800000
  }
}
```

## Meta-Skills

Six cross-cutting meta-skills implemented as runtime behavioral engines:

| Meta-Skill | Engine | How it works |
|------------|--------|-------------|
| **Emotional Intelligence** | `meta-skills.ts` | Analyzes message patterns at turn_end (short replies, corrections, caps); injects communication guidance into system prompt |
| **Discretion** | `meta-skills.ts` | Filters proactive notifications; max 3/hour; suppresses during deep conversations (>5 turns); never sends sensitive content externally |
| **Anticipatory Thinking** | `proactive.ts` | OODA loop scans calendar, boards, goals every 15 min; prepares before deadlines hit |
| **Adaptability** | `meta-skills.ts` | Detects corrections instantly; creates memories and injects one-turn adjustment notes ("no, use X" → immediate memory + style shift) |
| **Multi-tasking** | `meta-skills.ts` | Spawns background subagents for kanban cards assigned to "subagent" during idle periods |
| **Continuous Learning** | Brain `learner.ts` | Two-pass learning at conversation boundaries: deterministic extraction (CPU, ~1ms) + LLM reflection (nuanced signals) |

Manage via `/meta-skills` (status/emotional/discretion/corrections).

## Playbooks (Personal Assistant)

19 domain-specific playbooks. Each embeds a professional methodology (GTD,
Minto Pyramid, OODA Loop, DMAIC, etc.), few-shot examples, and tool
integration. They load on-demand via `skill_view` (progressive disclosure).

| Badge | Tier | Meaning |
|-------|------|---------|
| ✅ | **verified** | Tested with ≥60% accuracy. Few-shot examples tuned. |
| ⚠️ | **experimental** | Methodology-based but not yet empirically validated. |
| 🔬 | **untested** | Domain-expert playbook awaiting evaluation. |

| Tier | Playbooks |
|------|-----------|
| ✅ Verified (6) | `pa-time-manage` `pa-doc-writer` `pa-stakeholder-comm` `pa-research` `pa-lifestyle` `pa-onboard` |
| ⚠️ Experimental (9) | `pa-project-coord` `pa-event-manage` `pa-finance` `pa-travel` `pa-procurement` `pa-decision-support` `pa-process-improve` `pa-tech-ops` `pa-records` |
| 🔬 Untested (4) | `pa-hr-support` `pa-compliance` `pa-governance` `pa-protocol` |

On first run, the `pa-onboard` setup wizard triggers automatically — captures
working hours, timezone, quiet hours, creates daily/weekly review crons,
initializes the PA kanban board.

## Security

- **Permission engine** — 8 risk classes (read_only, write_local,
  process_exec, communication, network, scheduling, mcp_read, mcp_write).
  Policy per class: allow, block, ask_user, log_only. `/permissions`
- **Planning mode** — `/plan` blocks writes; `/plan approve` re-enables
- **Session budgets** — 200 tool calls, 10 spawns (configurable)
- **Sandbox** — `vm.createContext(Object.create(null))` + 5s timeout;
  optional [gondolin](https://github.com/earendil-works/gondolin) micro-VM
- **SSRF guard** — blocks RFC1918, link-local, loopback, IPv6 ULA in
  web_extract
- **Kanban auth** — per-session Bearer token, no CORS
- **Notifications** — `spawn()` with argument arrays (no shell)

## Configuration

All config lives in `~/.waywiser/`:

| File | Purpose |
|---|---|
| `waywiser.db` | SQLite database (memory, boards, cron, goals, brain) |
| `brain.json` | Brain config (recall, embeddings, vault, evolution) |
| `config.json` | Global config (prompt budget, execute_code backend, proactive engine) |
| `permissions.json` | Permission policy (risk class defaults, per-tool overrides, allowlist) |
| `SOUL.md` | Agent identity and preferences (append-only) |
| `MEMORY.md` | Append-only memory log (human-readable mirror) |
| `USER.md` | User profile |
| `mcp.json` | MCP server configuration |
| `notify.json` | Notification channel setup (desktop, Telegram, webhook) |
| `mem.json` | Memory subsystem tuning (auto, recall mode, gate timeout) |
| `quiet.json` | Quiet hours window (HH:MM-HH:MM) |
| `brain/` | Brain vault (Obsidian-compatible markdown) |
| `boards/` | Kanban board markdown exports |
| `skills/` | PA playbooks + evolved skills (active/candidates/retired) |

## Tests

```bash
# Everything — core + security + proactive + meta-skills + Brain (85 suites)
# test/brain/ is discovered by this recursive glob, Brain is no longer separate
npm test                                            # 528 tests (522 pass, 6 e2e skip)

# Brain only (76 suites, subset of the above)
npm run test:brain                                  # 332 tests

# End-to-end evals (requires a running LLM)
WAYWISER_E2E_MODEL=qwen3:latest npm run test:e2e    # 6 tests
```

## License

MIT

---

Built on [pi](https://github.com/earendil-works/pi-coding-agent). MIT.
