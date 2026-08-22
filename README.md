# waywiser

> Your data never leaves your machine. Memories, preferences, boards, and
> scheduled jobs live in `~/.waywiser/` — a SQLite database you own, files you
> can edit by hand, and a whole home you can nuke in one `rm -rf`. No telemetry,
> no cloud sync. Your LLM runs on your hardware or behind your own API key.

A proactive personal AI agent built on [pi](https://github.com/earendil-works/pi-coding-agent).
Waywiser doesn't wait to be spoken to — it monitors your boards, goals, and
deadlines, alerts you when something needs attention, adapts to your
communication style, and learns from corrections in real time. Extends pi
with persistent memory, task delegation, project boards, a proactive cognition
engine, meta-skill behavioral engines, MCP integrations, scheduled jobs,
notifications, and a permission engine — all as in-process TypeScript
extensions. Nothing patches pi's core.

## Architecture

```
waywiser/
├── extensions/
│   ├── permissions.ts           ← Permission engine (loaded first)
│   ├── soul.ts                  ← SOUL.md identity persistence
│   ├── memory.ts                ← Cross-session memory (FTS5 + RecallProvider)
│   ├── kanban/                  ← Project boards (decomposed into 4 modules)
│   │   ├── index.ts             ← Extension wiring, commands, tool
│   │   ├── ops.ts               ← Board/card CRUD operations
│   │   ├── worker.ts            ← Subagent card workers
│   │   └── shared.ts            ← Types, constants, DB helpers
│   ├── kanban-server.ts         ← Localhost HTTP dashboard (token-authenticated)
│   ├── kanban-html.ts           ← Board HTML/CSS generation
│   ├── delegate.ts              ← Task delegation via RPC subprocesses
│   ├── execute-code.ts          ← Programmatic tool calling (vm.createContext sandbox)
│   ├── cronjob.ts               ← Scheduled jobs with quiet hours
│   ├── notify.ts                ← Desktop/Telegram/webhook notifications
│   ├── mcp.ts                   ← MCP server loader (JSON-RPC 2.0 stdio)
│   ├── web.ts                   ← Web search + extract (SSRF-guarded)
│   ├── commands.ts              ← Slash commands, goals, structured traces
│   ├── skills-manage.ts         ← Playbook catalog with tier badges
│   ├── proactive.ts             ← Proactive cognition engine (OODA loop)
│   ├── meta-skills.ts           ← Behavioral engines (EQ, discretion, adaptability)
│   ├── todo-compat.ts           ← /todo → kanban shim
│   ├── clarify.ts               ← User interaction tool
│   └── utils/
│       ├── state.ts             ← Shared DB, registry, config
│       ├── rpc.ts               ← Pi RPC client + warm pool
│       ├── llmcall.ts           ← One-shot LLM child (queue-based)
│       ├── prompt-budget.ts     ← Priority-based prompt injection manager
│       ├── trace.ts             ← Structured trace events (TraceEvent)
│       └── url-guard.ts         ← SSRF protection (private IP blocking)
├── skills/
│   ├── waywiser/                ← Core operating skill (always loaded)
│   └── pa-*/                    ← 19 PA playbooks (bootstrapped to ~/.waywiser/skills/)
├── bin/waywiser                 ← Launcher (auto-discovers plugins, bootstraps playbooks)
├── config/                      ← Default configs
├── test/
│   ├── *.test.ts                ← Unit tests (166 tests)
│   └── e2e/                     ← End-to-end evals (model-gated, 6 tests)
│
└── plugins/                     ← Vendor plugins (auto-loaded by launcher)
    └── brain/                   ← Persistent memory with procedural preferences
        ├── extensions/          ← Pi extension (18 modules)
        ├── skills/              ← Brain skill
        ├── test/                ← 332 tests
        └── plugins/
            └── obsidian/        ← Obsidian integration (plugin-in-plugin)
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
- Proactive cognition engine — OODA loop ticks every 15 min, monitors boards/goals/deadlines, alerts without consuming GPU
- Emotional intelligence — detects frustration from message patterns, adapts communication style in real time
- Discretion — suppresses low-value alerts during deep focus, caps notifications, respects quiet hours
- Adaptability — catches corrections instantly ("no, use X"), creates memories and adjusts same-session
- Multi-tasking — spawns background subagents for queued work during idle periods

**Memory & learning:**
- Cross-session memory (FTS5 + Brain's reciprocal rank fusion recall)
- Deterministic memory extraction per turn (CPU, ~1ms — no GPU contention)
- LLM-powered reflective learning at conversation boundaries (nuanced signals)
- Procedural preferences ("when X, prefer Y over Z") with evidence tracking
- Auto-evolution: mature procedures → candidate skills → competitive evaluation
- Embedding on CPU (`num_gpu: 0`), LRU cache, batch API — zero GPU contention
- Memory export/import for data portability

**Tools & integrations:**
- Task delegation (3 concurrent subagents, depth-capped at 2)
- Kanban boards (authenticated web dashboard + TUI + markdown)
- MCP integrations (Gmail, Calendar, Notion, etc.)
- Scheduled jobs (cron + one-shot timers, auto-pause on repeated failures)
- Desktop/Telegram/webhook notifications
- 19 PA playbooks (time management, finance, travel, research, etc.)

**Safety & observability:**
- Permission engine (8-class risk taxonomy, planning mode, session budgets)
- Sandboxed code execution (vm.createContext + optional Gondolin micro-VM)
- SSRF protection, prompt cache telemetry, structured trace events
- Goal budgets, SOUL.md identity with consolidation
- Obsidian-compatible vault at `~/.waywiser/brain/`

### Optional: Obsidian Plugin

If you use [Obsidian](https://obsidian.md), the Brain vault at
`~/.waywiser/brain/` is already Obsidian-compatible (wikilinks, Properties,
callouts, mermaid diagrams). For a richer experience — dashboard sidebar,
command palette, graph coloring, confidence bars — install the Obsidian plugin:

```bash
git clone git@github.com:yoda-digital/waywiser.git
cd waywiser
npm install

# Build the Obsidian plugin
cd plugins/brain/plugins/obsidian
npm install
npm run build
cd ../../../..

# Install in your Obsidian vault
VAULT="/path/to/your/vault"
mkdir -p "$VAULT/.obsidian/plugins/waywiser-brain"
cp plugins/brain/plugins/obsidian/main.js \
   plugins/brain/plugins/obsidian/manifest.json \
   plugins/brain/plugins/obsidian/styles.css \
   plugins/brain/plugins/obsidian/sql-wasm.wasm \
   "$VAULT/.obsidian/plugins/waywiser-brain/"

# Point Brain's vault at your Obsidian vault
cat > ~/.waywiser/brain.json << 'EOF'
{
  "markdownRoot": "/path/to/your/vault/Brain/"
}
EOF

# Launch
bin/waywiser
```

Then enable "Waywiser Brain" in Obsidian Settings → Community Plugins.

**What the Obsidian plugin adds:**
- Brain Dashboard sidebar (stats, contradictions, evolution, memories, procedures, activity)
- 7 command palette entries (Brain: Refresh, Stats, Dashboard, Contradictions, Evolution, Activity, Go to Memory)
- Ribbon icon (🧠 quick-access)
- Status bar widget (`🧠 142m 3p 2s`, click to open dashboard)
- Confidence bars + status badges (rendered in reading mode)
- Graph view coloring via `#brain/` tag hierarchy

### Quick Reference

| Feature | Core | + Brain | + Obsidian |
|---------|:----:|:-------:|:----------:|
| Cross-session memory | ✅ | ✅ | ✅ |
| Memory export/import | ✅ | ✅ | ✅ |
| Delegation & subagents | ✅ | ✅ | ✅ |
| Kanban boards (authenticated) | ✅ | ✅ | ✅ |
| MCP integrations | ✅ | ✅ | ✅ |
| Cron jobs (auto-pause) | ✅ | ✅ | ✅ |
| Notifications | ✅ | ✅ | ✅ |
| SOUL identity + consolidation | ✅ | ✅ | ✅ |
| Permission engine | ✅ | ✅ | ✅ |
| Planning mode | ✅ | ✅ | ✅ |
| Session budgets | ✅ | ✅ | ✅ |
| Structured traces | ✅ | ✅ | ✅ |
| Goal budgets | ✅ | ✅ | ✅ |
| SSRF protection | ✅ | ✅ | ✅ |
| Prompt cache telemetry | ✅ | ✅ | ✅ |
| RRF recall (5+ signals) | — | ✅ | ✅ |
| Procedural preferences | — | ✅ | ✅ |
| Skill auto-evolution | — | ✅ | ✅ |
| Vault markdown sync | — | ✅ | ✅ |
| `/brain` commands | — | ✅ | ✅ |
| Dashboard sidebar | — | — | ✅ |
| Command palette (7 cmds) | — | — | ✅ |
| Real-time DB refresh | — | — | ✅ |
| Graph view coloring | — | — | ✅ |
| Confidence bars | — | — | ✅ |
| Proactive engine (OODA loop) | ✅ | ✅ | ✅ |
| Emotional intelligence | ✅ | ✅ | ✅ |
| Discretion filter | ✅ | ✅ | ✅ |
| Adaptability (correction detect) | ✅ | ✅ | ✅ |
| Multi-tasking (background delegation) | ✅ | ✅ | ✅ |
| PA playbooks (19 domains) | ✅ | ✅ | ✅ |

## Playbooks (Personal Assistant)

19 domain-specific playbooks that extend Waywiser into a full personal
assistant. Each playbook embeds a professional methodology (GTD, Minto Pyramid,
OODA Loop, DMAIC, etc.), few-shot examples calibrated for the target model, and
tool integration with Waywiser's native toolset.

Playbooks are installed to `~/.waywiser/skills/` on first run and discovered
via `skills_list`. They load on-demand via `skill_view` (progressive
disclosure — only descriptions live in context until activated).

Each playbook carries a quality tier based on empirical testing:

| Badge | Tier | Meaning |
|-------|------|---------|
| ✅ | **verified** | Tested with ≥60% accuracy. Few-shot examples tuned. |
| ⚠️ | **experimental** | Written with methodology but not yet empirically validated. |
| 🔬 | **untested** | Domain-expert playbook awaiting evaluation. |

### First-run setup

On launch, the PA system auto-detects whether onboarding has been completed. If
not, the first PA request triggers the `pa-onboard` setup wizard which:

1. Captures working hours, timezone, and quiet hours
2. Creates a daily planning review cron (default 08:00 Mon–Fri)
3. Creates a weekly review cron (default Friday 16:00)
4. Identifies the calendar source (Google Calendar MCP, file, or manual)
5. Records communication preferences and recurring commitments
6. Creates a `pa-overview` kanban board
7. Writes an onboarding marker to memory (won't repeat)

### Tier assignments

| Tier | Playbooks |
|------|-----------|
| ✅ **Verified** | `pa-time-manage` `pa-doc-writer` `pa-stakeholder-comm` `pa-research` `pa-lifestyle` `pa-onboard` |
| ⚠️ **Experimental** | `pa-project-coord` `pa-event-manage` `pa-finance` `pa-travel` `pa-procurement` `pa-decision-support` `pa-process-improve` `pa-tech-ops` `pa-records` |
| 🔬 **Untested** | `pa-hr-support` `pa-compliance` `pa-governance` `pa-protocol` |

### Each playbook contains

- **Role prompt** — domain-specific persona
- **Methodology** — professional framework (BoT reasoning template)
- **Few-shot examples** — 2 per playbook for model accuracy
- **Tool integration** — mapped to Waywiser tools (memory, kanban, delegate_task, etc.)
- **Memory-first protocol** — recall preferences before every task
- **Thinking level** — calibrated per domain complexity (low → max)
- **Guardrails** — domain-specific safety boundaries and escalation rules

Six cross-cutting meta-skills are implemented as runtime behavioral engines
(not just SOUL.md bullets):

| Meta-Skill | Engine | How it works |
|------------|--------|-------------|
| **Emotional Intelligence** | `meta-skills.ts` | Analyzes message patterns at `turn_end`; injects awareness into system prompt |
| **Discretion** | `meta-skills.ts` | Filters proactive notifications; caps at 3/hour; suppresses during deep focus |
| **Anticipatory Thinking** | `proactive.ts` | OODA loop scans calendar, boards, goals; prepares before deadlines hit |
| **Adaptability** | `meta-skills.ts` | Detects corrections instantly; creates memories and adjusts same-session |
| **Multi-tasking** | `meta-skills.ts` | Spawns background subagents for queued kanban work during idle |
| **Continuous Learning** | Brain `learner.ts` | Two-pass learning (deterministic + LLM reflection) at conversation boundaries |

## Security

Waywiser includes a layered security model:

- **Permission engine** — 8-class risk taxonomy (read_only, write_local,
  process_exec, communication, network, scheduling, mcp_read, mcp_write).
  Configurable policy per class: allow, block, ask_user, log_only.
  Manage via `/permissions`.
- **Planning mode** — `/plan` blocks all write/send/spawn tools while
  allowing reads. `/plan approve` re-enables writes.
- **Session budgets** — max 200 tool calls and 10 subagent spawns per
  session (configurable via env vars or config.json).
- **Sandbox** — `execute_code` uses `vm.createContext(Object.create(null))`
  with a 5-second timeout. Optional
  [gondolin](https://github.com/earendil-works/gondolin) micro-VM backend
  for full isolation (`npm install @earendil-works/gondolin`).
- **SSRF protection** — `web_extract` blocks private, link-local, and
  localhost URLs.
- **Kanban auth** — localhost dashboard requires a per-session Bearer token.
  No CORS headers (same-origin only).
- **Notification safety** — `spawn()` with argument arrays (no shell
  interpolation).

## Plugin System

Plugins live in `plugins/`. The launcher auto-discovers them:

```
plugins/
└── <plugin-name>/
    ├── extensions/<name>/index.ts   → loaded as Pi extension
    ├── skills/<name>/SKILL.md       → loaded as Pi skill
    ├── config/*.example.json        → copied to ~/.waywiser/ on first run
    └── plugins/                     → sub-plugins (plugin-in-plugin)
        └── <sub-plugin>/
```

To disable a plugin, rename or remove its directory from `plugins/`.

## Features (Core)

### Proactive Engine

Waywiser runs a continuous OODA loop (Observe-Orient-Decide-Act) between user
interactions. Every 15 minutes (30 during quiet hours), it:

1. **Senses** — SQL-only signal gathering (zero LLM cost): overdue cards,
   goals past deadline, cron failures, evolution candidates, user absence
2. **Orients** — priority scores each signal (P0 interrupt → P3 background),
   deduplicates, applies discretion filter
3. **Decides + Acts** — P0 alerts go via desktop/Telegram (no GPU); P1-P2
   triggers an agent turn via `sendUserMessage`; P3 runs silently

The engine pauses during active conversation and re-arms when the agent
settles. Configure via `/proactive` (on/off/tick/signals/status) or
`~/.waywiser/config.json`.

### Meta-Skills

Four behavioral engines run as runtime modules, not just prompt text:

- **Emotional Intelligence** — detects frustration (short replies, repeated
  corrections, caps) and injects communication-style guidance
- **Discretion** — caps proactive notifications at 3/hour, suppresses during
  deep conversations (>5 turns), never sends sensitive content externally
- **Adaptability** — catches corrections ("no, use X") in real time, creates
  memories immediately (doesn't wait for session boundary)
- **Multi-tasking** — spawns background subagents for kanban cards assigned
  to "subagent" during idle periods

Manage via `/meta-skills` (status/emotional/discretion/corrections).

### Memory

Cross-session memory with full-text search (SQLite FTS5). Waywiser remembers
your preferences, project context, and lessons across sessions.

- **Automatic writes:** deterministic pattern matching at `turn_end` extracts
  preferences, corrections, and decisions (~1ms CPU, no GPU). LLM-powered
  reflective learning runs at conversation boundaries for nuanced signals.
- **Selective recall:** BM25-ranked relevant memories injected per turn
- **RecallProvider:** when Brain is loaded, its RRF recall transparently
  replaces core FTS (no dynamic imports, no second DB connection)
- **Consolidation:** dedup, decay, merge — run `/memory consolidate`
- **Export/import:** `memory action=export` for JSON backup; `action=import`
  for restore/merge with deduplication
- **External content freezing:** web-sourced data frozen at low confidence
  until user promotes it
- **Full audit trail** in `memlog`; readable exports in `MEMORY.md`

### Kanban Board

Project boards backed by SQLite with three views:

- **Web dashboard** at `http://localhost:7749/` — drag-and-drop, real-time
  SSE, session-token authenticated
- **Markdown** at `~/.waywiser/boards/` — readable offline
- **TUI** — `/kanban` in terminal

### Delegation

Spawn isolated pi children for research, code tasks, or anything that would
flood your main context. Up to 3 concurrent subagents. Warm RPC pool with
proper `session_shutdown` cleanup.

### MCP Integrations

Connect any MCP server — Gmail, Calendar, Notion, filesystem. Config lives in
`~/.waywiser/mcp.json`. Servers spawn lazily and reconnect on failure. MCP tool
calls are classified by the permission engine (read vs write heuristic).

### Notifications

Desktop (`notify-send`), Telegram bot, or webhook. Quiet hours respected.
Rate-limited (10/hour default). Shell-injection-proof (`spawn()` with argument
arrays, no shell interpolation).

### Scheduled Jobs

Cron expressions or one-shot `@ISO` timestamps. Session-mode timers and
system-mode `.cron` files. Auto-pause after 5 consecutive delivery failures.

### Identity

`SOUL.md` persists across restarts. The agent appends preferences and lessons
but never rewrites what's there (prompt-cache stability). `soul action=consolidate`
reports counts and flags potential contradictions for manual review.

### Observability

- **Structured trace events:** every tool call logged as a typed `TraceEvent`
  (kind, tool, action, risk, latency, status)
- **Prompt cache telemetry:** SHA-256 prefix tracking, hit/miss stats
- **Goal budgets:** `/goal --max-steps 30 --deadline 2026-09-01 --done "condition"`
- **Trace export:** `/trace export` writes JSONL to `~/.waywiser/trace-export.jsonl`
- **Session summary:** tool call count, unique tools, errors — logged at shutdown

### Prompt Management

System-prompt injections are coordinated through a priority-based budget manager:

| Priority | Block | Cacheable? |
|----------|-------|------------|
| 0 | SOUL.md identity | ✅ Session-stable |
| 1 | Memory digest | ✅ Session-stable |
| 2 | Active goals | ❌ Per-mutation |
| 3 | Memory recall / Brain context | ❌ Per-turn |
| 4 | Playbook catalog | ✅ Session-stable |
| 5 | Kanban open cards | ❌ Per-mutation |
| 6 | Permission reminders | ❌ Per-turn |

Configurable budget via `~/.waywiser/config.json` → `promptBudget.maxChars`
(default 12,000).

## Configuration

All config lives in `~/.waywiser/`:

| File | Purpose |
|---|---|
| `waywiser.db` | SQLite database (memory, boards, cron, goals, brain) |
| `brain.json` | Brain plugin config (auto-created from example) |
| `SOUL.md` | Agent identity and preferences |
| `MEMORY.md` | Append-only memory log |
| `mcp.json` | MCP server configuration |
| `notify.json` | Notification channel setup |
| `mem.json` | Memory subsystem tuning |
| `permissions.json` | Permission policy (defaults/overrides/allowlist) |
| `config.json` | Global config (prompt budget, execute_code backend) |
| `brain/` | Brain vault (Obsidian-compatible markdown) |
| `skills/` | Evolved skills (active/candidates/retired) |

## Tests

```bash
# Core + security + proactive + meta-skills tests
npm test                                           # 196 tests (190 pass, 6 e2e skip)

# Brain plugin tests
npm run test:brain                                 # 332 tests

# Everything
npm run test:all                                   # 528 total

# End-to-end evals (requires a running model)
WAYWISER_E2E_MODEL=qwen3:latest npm run test:e2e   # 6 tests
```

## License

MIT

---

Built on pi. Adapted from NousResearch/hermes-agent (MIT). Legacy `~/.hermes`
homes are auto-migrated on first run.
