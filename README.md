# waywiser

> Your data never leaves your machine. Memories, preferences, boards, and
> scheduled jobs live in `~/.waywiser/` — a SQLite database you own, files you
> can edit by hand, and a whole home you can nuke in one `rm -rf`. No telemetry,
> no cloud sync. Your LLM runs on your hardware or behind your own API key.

A personal AI agent built on [pi](https://github.com/earendil-works/pi-coding-agent).
Extends pi with persistent memory, task delegation, project boards, MCP
integrations, scheduled jobs, and notifications — all as in-process TypeScript
extensions. Nothing patches pi's core.

## Install

Node >= 22.5, `pi` on PATH.

```bash
npm install -g waywiser
waywiser                    # interactive TUI
waywiser -p "do something"  # one-shot
```

From source:

```bash
cd waywiser && npm install && bash bin/waywiser
```

## Features

### Memory

Cross-session memory with full-text search (SQLite FTS5). Waywiser remembers
your preferences, project context, and lessons across sessions without you
asking it to.

- Automatic writes: a turn-end gate extracts durable facts from the
  conversation and stores them at controlled confidence levels
- Selective recall: BM25-ranked relevant memories injected per turn
- Consolidation: dedup, decay, merge — run `/memory consolidate` periodically
- Full audit trail in `memlog`; readable exports in `MEMORY.md` and `USER.md`

### Kanban board

Project boards backed by SQLite with three views of the same data:

- **Web dashboard** at `http://localhost:7749/` — drag-and-drop columns,
  inline editing, card CRUD, board tabs, real-time SSE updates, dark/light
  theme. Runs while waywiser is active.
- **Markdown files** at `~/.waywiser/boards/` — always readable, even when
  waywiser is off. Open them in your editor or commit them to git.
- **TUI** — `/kanban` in the terminal, same operations.

Cards have types (task, idea, bug), priorities, due dates with overdue
detection, notes, and reports. `assign subagent` spawns a detached worker
that files its results on the card.

### Delegation

Spawn isolated pi children for research, code tasks, or anything that would
flood your main context window. Up to 3 concurrent subagents, each with their
own session.

### MCP integrations

Connect any MCP server — Gmail, Calendar, Notion, filesystem, whatever. Tools
appear as `server__toolname` and work like native tools. Config lives in
`~/.waywiser/mcp.json`. Servers spawn lazily and reconnect on failure.

### Notifications

Desktop (`notify-send`), Telegram bot, or webhook. Quiet hours respected, rate
limited, urgency override available. Set up with `/notify setup`, test with
`/notify test`.

### Scheduled jobs

Five-field cron expressions or one-shot `@ISO` timestamps. Session-mode timers
fire while pi runs; system-mode `.cron` files integrate with your OS cron.
Quiet hours defer non-critical fires.

### Identity

`SOUL.md` persists across restarts. The agent appends preferences and lessons
but never rewrites what's there. You can edit it by hand.

## Configuration

All config lives in `~/.waywiser/`:

| File | Purpose |
|---|---|
| `waywiser.db` | SQLite database (memory, boards, cron, goals) |
| `SOUL.md` | Agent identity and preferences |
| `MEMORY.md` | Append-only memory log |
| `USER.md` | Generated preferences export |
| `mcp.json` | MCP server configuration |
| `notify.json` | Notification channel setup |
| `quiet.json` | Quiet hours window |
| `mem.json` | Memory subsystem tuning |
| `boards/` | Markdown board exports |
| `board.html` | Static board snapshot (offline fallback) |

## Tests

```bash
npm test
```

54 tests covering memory, kanban, cron, and a smoke test asserting all tools
and commands register.

## License

MIT

---

Built on pi. Adapted from NousResearch/hermes-agent (MIT). Legacy `~/.hermes`
homes are auto-migrated on first run.
