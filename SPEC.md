# Waywiser on Pi — Design Spec

## What this is, and where it came from

**Waywiser** is our personal AI agent on the Pi harness (this repo). It was
originally built by studying the **hermes** project (NousResearch/hermes-agent,
MIT) — a personal AI agent harness that runs the same core across CLI, TUI,
desktop, and a messaging gateway, learns across sessions (memory + skills),
delegates to subagents, runs scheduled jobs, and drives terminal + browser,
extending through plugins and skills rather than a growing core. This spec's
feature list is that study's output, re-branded as Waywiser (see README provenance
+ `research/hermes-agent-research.md`).

Its two founding principles (from AGENTS.md):
- **Per-conversation prompt caching is sacred** — nothing mutates past context or
  swaps toolsets mid-conversation (the one exception: context compression).
- **The core is a narrow waist; capability lives at the edges** — most new capability
  should be a CLI command + skill, a service-gated tool, or a plugin — not core surface.

## What Pi Already Gives Us (no reimplementation needed)

| hermes feature | Pi equivalent | Status |
|---|---|---|
| Agent loop, tool calling | `@earendil-works/pi-agent-core` | ✓ built-in |
| Multi-provider LLM | `@earendil-works/pi-ai` (OpenAI, Anthropic, Google, Bedrock, Vertex) | ✓ built-in |
| Sessions (JSONL, fork, resume) | `SessionManager`, `--continue`, `--resume`, `--fork` | ✓ built-in |
| Compaction | `@earendil-works/pi-agent-core` compaction module | ✓ built-in |
| Skills (SKILL.md) | agentskills.io compatible, `~/.pi/agent/skills/`, `.pi/skills/` | ✓ built-in |
| Extensions (in-process TS) | `pi.registerTool/Command/Shortcut/Flag`, 33 events | ✓ built-in |
| System prompt injection | `before_agent_start` event, `event.systemPrompt` | ✓ built-in |
| Subagent (basic) | `examples/extensions/subagent/` — spawns `pi` subprocesses | ✓ exists, needs Waywiser semantics |
| RPC mode | `pi --mode rpc` — JSONL over stdin/stdout | ✓ built-in |
| SDK | `createAgentSession()` from `@earendil-works/pi-coding-agent` | ✓ built-in |
| TUI | `@earendil-works/pi-tui` | ✓ built-in |
| Web tools | **none** | ✗ must build |
| SOUL.md identity | **none** | ✗ must build |
| MEMORY.md cross-session | **none** | ✗ must build |
| `execute_code` (Programmatic Tool Calling) | **none** | ✗ must build |
| `delegate_task` (full semantics) | basic subagent only | ✗ must build |
| `cronjob` | **none** | ✗ must build |
| Kanban board | **none** | ✗ must build |
| `clarify` | **none** | ✗ must build |
| Gateway (Telegram, etc.) | **none** | ✗ future scope |
| Browser CDP | **none** | ✗ future scope |

## Architecture

**Waywiser on Pi is a pi-package** (npm-installable, `pi install .`) that layers
Waywiser' identity features, tools, and slash-commands onto the existing Pi core.

```
waywiser-on-pi/
├── package.json           # pi-package manifest
├── bin/
│   └── waywiser             # CLI wrapper: shims `pi` with Waywiser config + extensions
├── extensions/            # All TS extensions (the main event)
│   ├── index.ts           # Entry: loads all sub-extensions
│   ├── soul.ts            # SOUL.md persona injection (before_agent_start)
│   ├── memory.ts          # MEMORY.md + SQLite FTS5 index + `memory` tool
│   ├── delegate.ts        # `delegate_task` tool (Waywiser semantics: spawn/steer/stop/list)
│   ├── execute-code.ts    # `execute_code` tool (Programmatic Tool Calling)
│   ├── web.ts             # `web_search`, `web_extract` tools
│   ├── todo.ts            # `todo` tool (task tracking, persistent)
│   ├── skills-manage.ts   # `skills_list`, `skill_view`, `skill_manage` tools
│   ├── cronjob.ts         # `cronjob` tool (scheduling)
│   ├── clarify.ts         # `clarify` tool (user interaction)
│   ├── kanban.ts          # Kanban board: `/kanban` commands + state
│   ├── commands.ts        # Slash: /steer /goal /subgoal /compress /fork /worktree /handoff /context /refine /journey
│   └── utils/
│       ├── state.ts       # Shared state helpers, DB path, waywiser home
│       └── delegate.ts    # Subagent process management (spawn, steer, stop)
├── skills/
│   └── waywiser/
│       └── SKILL.md       # Waywiser operating skill (model-visible)
├── prompts/
│   └── waywiser.md          # Waywiser system prompt template
├── config/
│   ├── SOUL.md            # Default persona template
│   ├── MEMORY.md          # Default memory template
│   ├── USER.md            # Default user profile template
│   └── settings.json      # Default pi settings for Waywiser mode
└── test/
    ├── smoke.test.ts      # Extension loads, tools registered
    ├── delegate.test.ts   # Subagent spawn/steer/stop
    ├── memory.test.ts     # Memory CRUD + FTS5 search
    └── web.test.ts        # Web search/extract (mocked)
```

## Feature Design

### 1. SOUL.md — Living Identity

**hermes:** SOUL.md at `~/.hermes/SOUL.md` is the persona file, first slot in system prompt.

**Waywiser on Pi:**
- Extension `soul.ts` reads `~/.waywiser/SOUL.md` (or `WAYWISER_HOME/SOUL.md`).
- On `before_agent_start`, injects SOUL content into `event.systemPrompt` as a stable
  prefix (before the rest), maintaining prompt-cache stability.
- The `soul` tool allows the agent to **read, update, and append to SOUL.md** —
  creating a self-improving identity. Updates are append-only (cache-safe).
- `WAYWISER_HOME` env var overrides the default `~/.waywiser/`.

### 2. MEMORY.md + FTS5 — Cross-Session Memory

**hermes:** MEMORY.md at `~/.hermes/MEMORY.md`, learned across sessions.

**Waywiser on Pi:**
- SQLite database at `~/.waywiser/waywiser.db` with:
  - `memories` table: id, type (fact|preference|decision|lesson), content, confidence,
    created_at, last_accessed, access_count, tags, source_session
  - `memories_fts`: FTS5 virtual table for full-text search
  - `journal` table: per-session event log (what happened, what was learned)
- `memory` tool with actions:
  - `remember(type, content, confidence, tags)` — store a memory
  - `recall(query, limit)` — FTS5 search, returns top matches with scores
  - `forget(id)` — delete a memory
  - `list(type?, limit?)` — list memories
  - `consolidate()` — (deferred) merge similar memories
- MEMORY.md stays as the human-readable mirror (appended to, never rewritten mid-session).
- On `session_start`, extension loads top-recent memories into a system-prompt append
  (stable, cache-friendly).

### 3. `delegate_task` — Full Waywiser Subagent Semantics

**hermes:** `delegate_task` with `goal, context, tasks[{goal,context,role,output_schema}],
role∈{leaf,orchestrator}, action∈{spawn,list,steer,stop}`. Leaves can't delegate.
Concurrent limit `delegation.max_concurrent_children` (default 3). Always backgrounded.

**Waywiser on Pi:**
- `delegate_task` tool (extension `delegate.ts`):
  - `action: "spawn"` — Launch subagent(s). Each gets its own `pi -p` subprocess with:
    - Isolated context window (no parent conversation)
    - Focused system prompt built from `goal` + `context`
    - Tool allowlist (leaves get `delegate_task` excluded)
    - Optional `output_schema` for structured output (one correction retry on schema violation)
    - `role: "leaf"` (default) or `role: "orchestrator"` (can delegate further)
  - `action: "list"` — Show live and recently-finished children with status
  - `action: "steer"` — Queue a steering message to a running child (delivered after
    current tool batch, before next LLM call). Uses `pi --mode rpc` subprocess.
  - `action: "stop"` — Abort a running child
- `delegation.max_concurrent_children` from settings (default 3, configurable)
- Subagents run as background `pi --mode rpc` processes. The extension tracks them
  in an in-memory registry + persists state via `appendEntry` for crash recovery.
- On `agent_end`, the extension checks for finished children and surfaces their results
  to the parent via `sendUserMessage`.

### 4. `execute_code` — Programmatic Tool Calling

**hermes:** Run code (Python-RPC) that can call back into the agent's tools.

**Waywiser on Pi:**
- `execute_code` tool (extension `execute-code.ts`):
  - Accepts a TypeScript/JavaScript code string
  - Runs it in a sandboxed `node:vm` context (NOT a subprocess — fast, in-process)
  - The code gets a `tools` object with async functions for each registered tool
  - Code can call `tools.read(path)`, `tools.bash(cmd)`, `tools.write(path, content)`, etc.
  - Returns the code's return value + any `console.log` output
  - Timeout (default 30s, configurable)
  - This is the most powerful feature: the agent can write a single code snippet that
    orchestrates N tool calls in a loop, without N separate LLM turns

### 5. `web_search` + `web_extract` — Web Tools

**hermes:** `web_search(query)`, `web_extract(urls=[...])`.

**Waywiser on Pi:**
- `web_search` tool:
  - Uses the `vsearch` CLI (already available in this environment) if present
  - Falls back to a simple DuckDuckGo HTML scrape via `fetch`
  - Returns structured results: title, url, snippet
- `web_extract` tool:
  - Fetches URL content via `fetch`
  - Strips HTML to text (regex-based, no external deps)
  - Truncates to configurable max length (default 20k chars)
  - Returns clean text content

### 6. `todo` — Task Tracking

**hermes:** `todo` tool for in-session task tracking.

**Waywiser on Pi:**
- `todo` tool with actions: `list`, `add(text, priority?)`, `toggle(id)`, `complete(id)`,
  `remove(id)`, `clear`, `in_progress(id)`
- State persisted in extension state object (survives session restart within same session file)
- Also writes a `TODO.md` to cwd for human visibility
- `/todo` slash command shows the board

### 7. `skills_list`, `skill_view`, `skill_manage`

**hermes:** Skill management tools.

**Waywiser on Pi:**
- `skills_list` — List all loaded skills with descriptions
- `skill_view(name)` — Return the full SKILL.md content for a skill
- `skill_manage(name, action, params)` — Create/update/delete skills in `~/.waywiser/skills/`
  - `create(name, description, content)`
  - `update(name, new_content)`
  - `delete(name)`
  - `enable(name)` / `disable(name)`

### 8. `cronjob` — Scheduling

**hermes:** `cronjob` tool for scheduled agent tasks.

**Waywiser on Pi:**
- `cronjob` tool:
  - `schedule(cron_expression, prompt, name?)` — Register a recurring task
  - `list()` — Show scheduled jobs
  - `remove(id)` — Cancel a job
  - `run_now(id)` — Execute immediately
- Jobs stored in `~/.waywiser/cronjobs.json`
- Extension uses `setTimeout` for in-session execution; for cross-session scheduling,
  writes a cron entry (documented, requires user to configure system cron)
- `/cron` slash command for management

### 9. `clarify` — User Interaction

**hermes:** `clarify` tool for asking the user questions mid-task.

**Waywiser on Pi:**
- `clarify` tool:
  - `ask(question, options?)` — Display a question to the user via `ctx.ui.input()`
    or `ctx.ui.select()` (if options provided)
  - Returns the user's response as a tool result
- Only works in interactive TUI mode; in `-p` mode, returns a message explaining
  that clarify is unavailable.

### 10. Kanban Board

**hermes:** `hermes kanban` — multi-agent task board with ~30 subcommands.
Status lifecycle: todo→ready→review→done + blocked/scheduled.

**Waywiser on Pi:**
- `/kanban` slash command with subcommands:
  - `/kanban new <title>` — Create a task (status: todo)
  - `/kanban list [status]` — List tasks by status
  - `/kanban show <id>` — Task detail
  - `/kanban move <id> <status>` — Change status (todo→ready→review→done)
  - `/kanban assign <id> <agent>` — Assign to an agent
  - `/kanban block <id> <reason>` — Mark blocked
  - `/kanban done <id>` — Mark done
  - `/kanban stats` — Summary counts by status
- State persisted in `~/.waywiser/kanban.json`
- `/kanban assign` + `delegate_task` integration: assigning a task to "subagent"
  spawns a delegate_task for it automatically
- Rendered as a TUI widget via `ctx.ui.setWidget("kanban", [...])`

### 11. Slash Commands

| Command | Description |
|---|---|
| `/steer <msg>` | Queue a steering message to the current agent |
| `/goal <text>` | Set the session goal (stored, shown in header) |
| `/subgoal <text> [parent]` | Add a subgoal under a parent goal |
| `/goals` | Show goal tree |
| `/compress` | Trigger manual compaction |
| `/fork` | Fork current session |
| `/worktree <path>` | Switch to a git worktree |
| `/handoff` | Summarize current state for handoff to another session/agent |
| `/context [all]` | Show current system prompt / context files loaded |
| `/refine <text>` | Refine the last assistant message |
| `/journey` | Show session journey log |
| `/kanban <subcmd>` | Kanban board management |
| `/todo` | Show todo board |
| `/memory [query]` | Search memory |
| `/soul` | Show current SOUL.md |
| `/dream` | Show DreamTask status |
| `/waywiser status` | Show Waywiser extension status |

### 12. SOUL.md Template (default)

```markdown
# SOUL

I am Waywiser, a personal AI agent running on the Pi harness.

## Identity
- Name: Waywiser
- Role: Personal AI agent
- Philosophy: Practical, thorough, never gives up on the right solution.

## Working Principles
- Prompt-cache stable: I never rewrite my own identity mid-conversation.
- Evidence over confidence: I verify before I assert.
- Small verified steps: I prefer incremental progress over heroic leaps.
- The core is narrow: I extend through skills and tools, not by bloating identity.

## Preferences
(To be learned and appended by the agent over time.)

## Lessons Learned
(To be appended by the agent after significant events.)
```

### 13. bin/waywiser CLI Wrapper

A thin shell script that:
1. Sets `WAYWISER_HOME` (default `~/.waywiser/`)
2. Creates the home directory if missing (with default SOUL.md, MEMORY.md, USER.md)
3. Launches `pi` with:
   - `--extension` pointing to this package's extensions
   - `--skill` pointing to the waywiser skill
   - Default config from `config/settings.json`
4. Passes through all other arguments

```bash
#!/usr/bin/env bash
export WAYWISER_HOME="${WAYWISER_HOME:-$HOME/.waywiser}"
mkdir -p "$WAYWISER_HOME"
# Create default files if missing
WAYWISER_PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
pi --extension "$WAYWISER_PKG_DIR/extensions/index.ts" \
   --skill "$WAYWISER_PKG_DIR/skills/waywiser/SKILL.md" \
   "$@"
```

## Verification Plan

1. **Unit tests** (vitest):
   - State/DB helpers: create DB, insert memory, FTS5 search
   - Delegate: spawn a mock subprocess, verify routing
   - Todo: CRUD operations
   - Memory: remember/recall/forget
2. **Smoke test**: `pi -e ./extensions/index.ts -p "What tools do you have?"` → verify all tools listed
3. **End-to-end**: `bin/waywiser -p "Remember that I prefer TypeScript. Recall my preferences."` → verify memory roundtrip
4. **Delegate e2e**: `bin/waywiser -p "Use delegate_task to have a subagent list files in /tmp"` → verify subagent ran and reported back
5. **CLI**: `bin/waywiser --help` → shows pi help with waywiser extensions loaded

## What We Are NOT Building (and why)

- **Gateway (Telegram/Discord/etc.)**: Requires auth tokens, webhook management,
  per-platform adapters. Out of scope for v1. Pi's RPC mode can be wrapped by any
  gateway in the future.
- **Browser CDP**: Requires Chrome DevTools Protocol client, WebSocket management.
  Out of scope. Can be added as a separate extension when needed.
- **7 sandbox backends**: Pi's design philosophy is explicit: "a partial in-process
  sandbox would be easy to misunderstand as a security boundary." We follow suit.
- **Electron desktop app**: Pi has a TUI + web-ui. Desktop is not a differentiator.
- **Chinese/Spanish/Urdu READMEs**: Not relevant to functionality.
- **MCP server**: Pi explicitly rejected MCP as its extension mechanism. We follow suit.
- **Prompt-cache-breaking features**: Anything that would invalidate the prompt cache
  mid-conversation (tool set swaps, system prompt rewrites) is excluded by design.

## Success Criteria

- [ ] `pi install .` (or `pi -e ./extensions/index.ts`) loads all extensions without error
- [ ] All 12+ tools registered and callable by the LLM
- [ ] All 16+ slash commands work in interactive TUI
- [ ] `bin/waywiser -p "..."` runs end-to-end with SOUL + memory injection
- [ ] `delegate_task` spawns a real subagent that completes and reports back
- [ ] `memory` tool stores and retrieves across sessions (SQLite persistence)
- [ ] `execute_code` runs a code snippet that calls 2+ tools
- [ ] `web_search` returns real results (vsearch or DuckDuckGo)
- [ ] `todo` persists across session restarts
- [ ] Kanban board shows tasks in TUI widget
- [ ] Tests pass: `npx vitest run`
- [ ] No prompt-cache-breaking modifications to existing Pi behavior
