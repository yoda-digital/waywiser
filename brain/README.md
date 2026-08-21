# @yoda-digital/waywiser-brain

Self-learning, auto-evolving brain extension for Pi.

## What It Does

Brain observes Pi sessions, extracts durable knowledge, accumulates procedural patterns, and evolves them into native Pi skills through competitive evaluation.

```
USER TASK → BRAIN RECALL → PI ACTS → AGENT SETTLED
    → EXPERIENCE → LEARN → PROCEDURES → MATURE?
    → CANDIDATE SKILL → EVALUATE → PROMOTE/REJECT
    → ACTIVE PI SKILL → NEXT SESSION → ACT BETTER
```

## Architecture

Brain is a Pi package (`pi-package`) with 17 composable modules:

| Module | Purpose |
|--------|---------|
| **config** | Configuration with defaults, deep-merge, env overrides |
| **store** | SQLite database — schema, migrations, CRUD |
| **provenance** | Deterministic source classification |
| **trace** | Experience collection from Pi events |
| **recovery** | Tool failure/recovery linking |
| **recall** | Reciprocal rank fusion retrieval |
| **learner** | Two-pass learning (deterministic + reflective) |
| **procedures** | Procedural memory with evidence tracking |
| **consolidate** | Memory/procedure cleanup and maturity flagging |
| **skills** | Skill lifecycle (active/candidates/retired) |
| **eval** | Competitive baseline vs candidate evaluation |
| **evolve** | Evolution pipeline (procedure → skill) |
| **vault** | Markdown projection + Obsidian-compatible sync |
| **policy** | Scope inference, promotion rules, safety boundaries |
| **cognition** | Warm RPC pool for LLM meta-workers |
| **prompts** | All LLM prompt templates |

## Installation

Brain lives inside the waywiser repo at `waywiser/brain/`. It's loaded as a Pi package alongside Waywiser.

## Configuration

Copy and customize `~/.waywiser/brain.json`:

```json
{
  "markdownRoot": "~/.waywiser/brain/",
  "dbPath": "~/.waywiser/waywiser.db",
  "skillsRoot": "~/.waywiser/skills/",
  "learning": {
    "boundary": "agent_settled"
  },
  "recall": {
    "mode": "selective"
  },
  "evolution": {
    "promotionPolicy": "auto"
  }
}
```

All settings have sensible defaults. The config file is optional.

## Obsidian Integration

Point Obsidian at `~/.waywiser/brain/` (or whatever `markdownRoot` is set to). Brain writes standard Markdown with YAML frontmatter — no plugins needed. Human edits are imported at the next session start.

## License

MIT
