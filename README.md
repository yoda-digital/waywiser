# waywiser

> Your data never leaves your machine. Memories, preferences, boards, and
> scheduled jobs live in `~/.waywiser/` — a SQLite database you own, files you
> can edit by hand, and a whole home you can nuke in one `rm -rf`. No telemetry,
> no cloud sync. Your LLM runs on your hardware or behind your own API key.

A personal AI agent built on [pi](https://github.com/earendil-works/pi-coding-agent).
Extends pi with persistent memory, task delegation, project boards, MCP
integrations, scheduled jobs, and notifications — all as in-process TypeScript
extensions. Nothing patches pi's core.

## Architecture

```
waywiser/
├── extensions/              ← Core agent (memory, delegation, kanban, etc.)
├── skills/                  ← Core skills
├── bin/waywiser             ← Launcher (auto-discovers plugins)
├── config/                  ← Default configs
│
└── plugins/                 ← Vendor plugins (auto-loaded by launcher)
    └── brain/               ← Self-learning brain plugin
        ├── extensions/      ← Pi extension (18 modules)
        ├── skills/          ← Brain skill
        ├── test/            ← 315 tests
        └── plugins/         ← Brain's own sub-plugins
            └── obsidian/    ← Obsidian integration (plugin-in-plugin)
```

## Install from Source

Node >= 22.5, `pi` on PATH.

### Level 1: Waywiser Core

The base agent — memory, delegation, kanban, MCP, cron, notifications.

```bash
git clone git@github.com:yoda-digital/waywiser.git
cd waywiser
npm install
bin/waywiser
```

**What you get:**
- Cross-session memory (FTS5)
- Task delegation (3 concurrent subagents)
- Kanban boards (web dashboard + TUI + markdown)
- MCP integrations (Gmail, Calendar, Notion, etc.)
- Scheduled jobs (cron + one-shot timers)
- Desktop/Telegram/webhook notifications
- SOUL identity persistence

### Level 2: Waywiser + Brain Plugin

Adds self-learning, procedural memory, auto-evolution of skills, and an Obsidian-compatible vault. The launcher auto-discovers Brain from `plugins/brain/`.

```bash
git clone git@github.com:yoda-digital/waywiser.git
cd waywiser
npm install
bin/waywiser    # Brain loads automatically
```

No extra steps — `bin/waywiser` scans `plugins/` and loads everything it finds. On first run, it creates `~/.waywiser/brain.json` from the example config.

**What Brain adds:**
- Self-learning at `agent_settled` boundaries (not mid-turn)
- Reciprocal rank fusion recall (lexical + scope + usage + confidence + recency)
- Procedural memory ("when X, prefer Y over Z") with evidence tracking
- Auto-evolution: mature procedures → candidate skills → competitive evaluation → promotion
- Obsidian-native vault sync (wikilinks, Properties, callouts, mermaid diagrams, MOCs, canvas)
- `/brain status`, `/brain sync`, `/brain consolidate`, `/brain evolve *` commands
- `evolve` tool for evolution inspection

**Verify Brain loaded:**
```
/brain status
```

### Level 3: Waywiser + Brain + Obsidian Plugin

The Obsidian plugin is a plugin OF Brain (not of Waywiser directly). It lives inside Brain's distribution at `plugins/brain/plugins/obsidian/`.

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
| Delegation & subagents | ✅ | ✅ | ✅ |
| Kanban boards | ✅ | ✅ | ✅ |
| MCP integrations | ✅ | ✅ | ✅ |
| Cron jobs | ✅ | ✅ | ✅ |
| Notifications | ✅ | ✅ | ✅ |
| SOUL identity | ✅ | ✅ | ✅ |
| Self-learning (agent_settled) | — | ✅ | ✅ |
| Procedural memory | — | ✅ | ✅ |
| Skill auto-evolution | — | ✅ | ✅ |
| Vault markdown sync | — | ✅ | ✅ |
| Wikilinks + mermaid | — | ✅ | ✅ |
| `/brain` commands | — | ✅ | ✅ |
| Dashboard sidebar | — | — | ✅ |
| Command palette (7 cmds) | — | — | ✅ |
| Real-time DB refresh | — | — | ✅ |
| Graph view coloring | — | — | ✅ |
| Confidence bars | — | — | ✅ |

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

### Memory

Cross-session memory with full-text search (SQLite FTS5). Waywiser remembers
your preferences, project context, and lessons across sessions.

- Automatic writes: a turn-end gate extracts durable facts
- Selective recall: BM25-ranked relevant memories injected per turn
- Consolidation: dedup, decay, merge — run `/memory consolidate`
- Full audit trail in `memlog`; readable exports in `MEMORY.md`

### Kanban Board

Project boards backed by SQLite with three views:

- **Web dashboard** at `http://localhost:7749/` — drag-and-drop, real-time SSE
- **Markdown** at `~/.waywiser/boards/` — readable offline
- **TUI** — `/kanban` in terminal

### Delegation

Spawn isolated pi children for research, code tasks, or anything that would
flood your main context. Up to 3 concurrent subagents.

### MCP Integrations

Connect any MCP server — Gmail, Calendar, Notion, filesystem. Config lives in
`~/.waywiser/mcp.json`. Servers spawn lazily and reconnect on failure.

### Notifications

Desktop (`notify-send`), Telegram bot, or webhook. Quiet hours respected.

### Scheduled Jobs

Cron expressions or one-shot `@ISO` timestamps. Session-mode timers and
system-mode `.cron` files.

### Identity

`SOUL.md` persists across restarts. The agent appends preferences and lessons
but never rewrites what's there.

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
| `brain/` | Brain vault (Obsidian-compatible markdown) |
| `skills/` | Evolved skills (active/candidates/retired) |

## Tests

```bash
# Core tests
npm test                                           # 54 tests

# Brain plugin tests
cd plugins/brain && node --test test/*.test.ts      # 315 tests

# Everything
npm test && cd plugins/brain && node --test test/*.test.ts  # 369 total
```

## License

MIT

---

Built on pi. Adapted from NousResearch/hermes-agent (MIT). Legacy `~/.hermes`
homes are auto-migrated on first run.
