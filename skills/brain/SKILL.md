---
name: brain
description: Self-learning brain with procedural memory, auto-evolution, and Obsidian-compatible vault. Use when asked about memory, learning, evolution, procedures, or brain status.
---

# Brain

Brain is Waywiser's self-learning system. It observes your work, extracts durable knowledge, and evolves its own skills based on evidence.

## What Brain Does Automatically

- **Observes** tool calls and results during your session
- **Learns** at session boundaries (agent_settled) — extracts memories and procedures
- **Recalls** relevant memories and procedures before each agent run via reciprocal rank fusion
- **Evolves** mature procedures into native Pi skills after competitive evaluation
- **Syncs** all state to Obsidian-compatible markdown for human inspection

## How Learning Works

1. **Deterministic pass** — scans for user corrections, preference statements, tool failures, and recovery patterns. No LLM call.
2. **Reflective pass** — if durable signals found, asks a meta-worker to extract lasting knowledge. Runs only when needed.
3. **Evidence tracking** — every memory links back to the Pi session and observation that created it.

## Memory Types

- **fact** — something true about the world or project
- **preference** — user's stated preference
- **decision** — a commitment or architectural decision
- **lesson** — something learned from experience

## Procedures

Procedures are "when X happens, do Y instead of Z" patterns extracted from tool failure/recovery observations. They accumulate evidence across sessions and mature into skills.

## Tools

### `evolve`
Inspect the evolution system:
- `evolve status` — overview of memories, procedures, active/candidate skills
- `evolve candidates` — list candidate skills awaiting evaluation
- `evolve inspect <name>` — version history of a skill
- `evolve history <name>` — evaluation run history
- `evolve policy` — current evolution policy settings

### `memory` (existing Waywiser tool)
- `memory remember` — store a memory (source determined by call context)
- `memory recall` — search memories by query
- `memory search` — FTS search
- `memory recent` — recent memories
- `memory forget` — archive a memory

## Commands

- `/brain status` — full observability dashboard
- `/brain sync` — manual vault sync (DB ↔ markdown)
- `/brain consolidate` — run memory/procedure consolidation
- `/brain evolve status` — evolution status
- `/brain evolve promote <skill>` — manually promote a candidate
- `/brain evolve reject <skill>` — reject a candidate
- `/brain evolve rollback <skill>` — roll back to previous version
- `/brain experience <id>` — inspect an experience record
- `/brain procedure <key>` — inspect a procedure with evidence
- `/brain memory <id>` — inspect a memory with full evidence chain
- `/brain config` — show current brain configuration

## Provenance

Every piece of knowledge has traceable provenance:
- **user** — explicitly stated by the user (highest trust)
- **agent** — inferred by the agent (medium trust)
- **external** — from web/MCP tools (low trust, frozen until promoted)
- **environment** — from filesystem observations (medium trust)

External information enters frozen at low confidence. Use `memory promote <id>` to elevate.

## Configuration

Brain reads `~/.waywiser/brain.json` for settings. Key options:
- `markdownRoot` — where vault files live (default: `~/.waywiser/brain/`)
- `dbPath` — SQLite database location (default: `~/.waywiser/waywiser.db`)
- `skillsRoot` — where evolved skills live (default: `~/.waywiser/skills/`)
- `modules.*` — enable/disable individual modules
- `learning.boundary` — when to learn (`agent_settled` or `turn_end`)
- `recall.mode` — recall mode (`selective`, `top8`, `off`)
- `evolution.promotionPolicy` — `auto`, `manual`, or `confirm`
