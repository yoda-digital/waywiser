# waywiser

> Your data never leaves your machine. Every memory, preference, and conversation
> artifact lives in `~/.waywiser/` — a SQLite database you can read with any tool,
> files you can edit by hand, a DB you can delete in one command. No telemetry, no
> cloud sync, no training data. Your LLM runs on your hardware or behind your own
> API key. MCP servers run locally. Notifications go through your own Telegram bot.
> This is the one thing ChatGPT, Claude, and Gemini cannot offer you.

A personal AI agent on [pi](https://github.com/nicholasgasior/pi-coding-agent).
15 tools, 17 commands, and 1 operating skill loaded as in-process TypeScript
extensions. No core changes to pi.

Tested daily on Qwen3.8-27B via remote Ollama (128K window, thinking mode) with
pi 0.84.2. This README reports what was actually run and observed, not what the
code claims.

---

## What you get

Your `pi` session, plus:

| Feature | What it does |
|---|---|
| `soul` + SOUL.md | Persistent identity across restarts. Append-only preferences and lessons. |
| `memory` | Cross-session memory in SQLite with FTS5 search. Gated auto-writes at turn end, BM25 selective recall per turn, consolidation, and a memlog audit trail. Three write paths: explicit `remember`, automatic gate, and user-triggered consolidate. |
| `delegate_task` | Spawn isolated `pi --mode rpc` children. Leaf and orchestrator roles, steer/stop, up to 3 concurrent. |
| `execute_code` | Batch multiple tool calls in one turn via a script the child executes. |
| `web_search` / `web_extract` | Web research. Uses `vsearch` CLI if available, falls back to DuckDuckGo scraping. |
| MCP loader + `/mcp` | Connect any MCP server (Gmail, Calendar, Notion, etc). Tools appear as `server__toolname`. Lazy spawn, auto-reconnect, 30s timeout. Config: `~/.waywiser/mcp.json`. |
| `notify` + `/notify` | Send notifications via desktop, Telegram, or webhook. Quiet hours, rate limiting, urgency override. `/notify test` and `/notify setup` for configuration. |
| `kanban` + `/kanban` | Project board backed by SQLite. Multiple boards, card types (task/idea/bug), priorities, due dates, OVERDUE detection. Live web dashboard at `localhost:7749` with drag-and-drop, inline editing, and real-time updates via SSE. Markdown export to `~/.waywiser/boards/`. Subagent spawning: `assign subagent` runs a detached worker that files its report on the card. |
| `todo` | In-session task board with TODO.md. Yields if another extension owns `todo`. |
| `skills_*` | Create, view, and manage SKILL.md files. |
| `cronjob` + `/cron` | Scheduled jobs. Session-mode timers and system-mode `.cron` files. Quiet hours with midnight wrapping. |
| `clarify` | Ask the user a question mid-task. Degrades cleanly in non-interactive mode. |
| `/memory` | Bare words trigger recall. Verbs: remember, forget, list, promote, supersede, conflicts, stats, set, consolidate. |

Everything is additive and prompt-cache stable. State is injected once per
session — SOUL first, memory digest second, board summary last. Nothing rewrites
past context mid-conversation.

## Why it exists

Two problems with a plain CLI LLM:

1. **Amnesia.** Every session starts from zero. If you use an assistant daily,
   it needs to remember your preferences, projects, and lessons learned.
2. **One context window.** Research that floods 100K tokens shouldn't burn your
   main window. Delegation spends a child's context and returns a summary.

The rest (cron, kanban, skills, notifications) keeps a long-lived agent useful
between conversations. If you only care about 1 and 2, ignore the rest.

## How it works

`bin/waywiser` bootstraps `~/.waywiser/`, runs a one-time migration from legacy
`~/.hermes` if it exists, then launches pi with the extension pack.

**Memory** uses `node:sqlite` with FTS5 for search. Three write paths: explicit
`memory remember` at user-confidence 0.9, a turn-end gate that spawns a leaf
child to extract durable facts (agent-confidence 0.6, 8s budget, timeout drops
silently), and user-triggered `consolidate`. Read paths only see rows above
confidence 0.5 that haven't been superseded. External rows start at 0.3 and stay
invisible until promoted.

**Delegation** spawns children over pi's JSONL RPC protocol, probes readiness,
and isolates failures. A dead child returns a report saying so — it doesn't
crash you.

**Kanban** stores boards and cards in SQLite (same DB as memory and cron). On
every mutation, it regenerates Markdown files in `~/.waywiser/boards/` and
updates the live web dashboard. The HTTP server runs on `localhost:7749` and
exposes a REST API with SSE for real-time updates. The browser dashboard
supports drag-and-drop, inline editing, board switching, and card CRUD. When
waywiser isn't running, a static HTML snapshot and the Markdown files are still
readable.

**Failure isolation**: each extension loads in its own try/catch. A broken
module never takes down the rest.

## What works

Verified 2026-08 on pi 0.84.2, Qwen3.8-27B via remote Ollama:

- First run is frictionless. One command, home bootstrapped, answered same turn.
- Memory roundtrips across sessions. Stored a preference in session A, a fresh
  session B recalled it with correct ID and source attribution.
- Delegation works end-to-end. A leaf child ran bash in a real repo, returned a
  constrained answer, and the parent independently re-verified it.
- Tool calling is reliable at 21 registered tools. 6/6 round-trips with valid
  JSON and correct tool selection at 1-2.5s latency.
- 54 unit and smoke tests pass.

## What doesn't work

Observed in the same runs:

1. **Fresh-session blips.** One in six sessions, the model claimed it didn't have
   a `memory` tool. It did. Ask it to list its tools if that happens.
2. **Identity drift.** The model introduced itself as "Waywiser (Hermes Agent)"
   despite SOUL.md saying otherwise. Training-data residue. The identity anchor
   suppresses it but can't un-teach it.
3. **execute_code ordering** is the child model's call. Qwen3.8 is conservative
   about batching in practice, but order-sensitive work should be verified.
4. **Session-mode cron** only fires while pi is running. System-mode `.cron`
   files are the real scheduling path.
5. **todo collision.** If you load another `todo` extension (e.g. pi-superpowers),
   waywiser's yields. By design, but you'll see a stderr line.
6. **One-shot mode** (`-p`) can't use `clarify` or interactive delegation. The
   TUI is where waywiser is comfortable.
7. **The memory gate costs a round-trip per turn.** 8s budget, tunable up to 20s.
   `memory set auto=false` removes the cost entirely.

## Fixed in audits

**2026-08-21** (3-agent parallel review, 15 fixes):
- `parseCron` put parsed sets at wrong array indices — all cron jobs failed. Fixed.
- `/memory` command passed `db_` instead of `db_()` — all slash commands crashed. Fixed.
- MCP restart counter never reset — server died permanently after 3 intermittent failures. Fixed.
- `readJSON` silently swallowed JSON parse errors. Now logs malformed configs to stderr.
- Nine more error-handling and silent-failure fixes across execute-code, cronjob, notify, and memory.

**2026-08-20** (original audit):
- `memory recall` AND-joined query terms (should OR-join). Natural queries returned 0 rows. Fixed.
- Selective memory pipeline verified end-to-end with real 27B model.
- `execute_code` child-skip detection hardened.
- Identity drift mitigated at prompt level.

## Install

Requires Node >= 22.5 and `pi` on PATH.

```bash
npm install -g waywiser          # or: pi install waywiser
waywiser                         # interactive TUI
waywiser -p "task"               # one-shot
```

From a checkout:

```bash
cd waywiser && npm install && bash bin/waywiser
```

## Tests

```bash
npm test    # node --test test/*.test.ts
```

54 tests covering memory (gate, recall, consolidation, FTS5), kanban ops, cron
quiet hours, HTML stripping, and a smoke test that asserts all tools and commands
register.

## Out of scope

Gateway (Telegram/Discord message loop), browser CDP, sandbox backends, desktop
app. Pi doesn't include sandboxing by design — "a partial in-process sandbox
would be easy to misunderstand as a security boundary."

---

Started as "hermes-on-pi", an independent adaptation of NousResearch/hermes-agent
(MIT). Now Waywiser, standing on its own. Legacy `~/.hermes` homes are still
auto-migrated on first run.
