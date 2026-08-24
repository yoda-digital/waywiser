# PA Self-Organization via Kanban — Skill Spec

**Date:** 2026-08-24
**Status:** Spec
**Scope:** One SKILL.md file — no schema changes, no code changes, no new tools
**Audit:** The 2026-08-24 audit against agents-best-practices confirmed the kanban
subsystem is architecturally ready for PA internal use. The only gap is a skill
that teaches the model when and how to use the board for self-organization.

---

## Problem

Waywiser can use `kanban` for multi-step work (the tool exists, multi-board works,
subagent workers exist). But the model has no guidance on when to PROACTIVELY
organize its own execution on the board. The `waywiser` skill mentions the board
as a tool reference; `pa-project-coord` covers user-facing project management.
Neither teaches the PA to use the board as its own executive function.

## Non-goals (from audit)

These were rejected as unnecessary code changes:

- `created_by` field — multi-board handles separation
- `depends_on` field — goals handle hierarchy, model handles sequencing
- Proactive engine → kanban auto-card creation — model decides, not the engine
- Board `visibility` control — multi-board IS visibility control
- SOUL.md edits — narrow core principle; this belongs in a skill

## What the skill teaches

### 1. Activation trigger

The PA activates this pattern when facing work that:
- Has 3+ distinct steps that cannot all complete in the current turn
- Will span multiple sessions or require long-running subagent work
- Benefits from visible progress tracking (the user or the PA checking back)

The PA does NOT activate for:
- Simple one-turn answers or single-tool tasks
- Work that the user is already tracking on a board (use their board)
- Vague open-ended goals without decomposable steps

### 2. Board convention

- Board name: `plan-<slug>` (e.g., `plan-report-x`, `plan-site-migration`)
- One board per objective — never reuse a board for unrelated work
- Keep the user's `default` board clean — PA work goes on dedicated boards

### 3. Decomposition pattern

```
User request → Goal (via /goal or in conversation) → Decompose into 3-8 cards
```

Each card:
- Title: action verb + object (e.g., "Research competitors", "Draft intro section")
- Priority: reflects execution order / importance
- Due: only if the parent objective has a deadline
- Notes: prerequisites, context the worker will need, link to goal
- Type: task (default), idea (for exploration), bug (for fixes)

### 4. Card lifecycle management

```
todo → doing → review → done
        │
        └─ blocked (with reason)
```

- Move cards to `doing` before starting work
- Use `assign subagent` for delegatable independent work
- Move to `review` when the PA wants to verify/consolidate output
- Move to `done` only after verification
- `block` with a reason when waiting on external input

### 5. Integration with goals

The PA links kanban execution to goals:
- Set a goal first (via `/goal` or the goals table)
- Create the planning board as the execution layer for that goal
- Card notes reference the goal: "For goal: <text>"
- When all cards are done, evaluate the goal's done_condition
- Archive the board when the goal completes

### 6. Cross-session continuity

On session start, the PA:
1. Reads the system prompt injection (open cards from active board)
2. Checks for in-progress planning boards via `kanban action=boards`
3. If a planning board has open cards, reports status and asks whether to continue

This requires NO code — the `before_agent_start` injection already surfaces open
cards, and the model can read the board on any turn.

### 7. When to delegate

Use `kanban action=assign id=<id> who=subagent` when a card represents:
- Independent work that doesn't need the PA's conversation context
- Research/extraction that would flood the current context
- Mechanical work (bulk reads, formatting, analysis)

Use `kanban action=wait id=<id>` to block on a subagent result when the next
card depends on its output. Otherwise, let it run and check later.

### 8. Cleanup

- `kanban action=clear_done board=plan-<slug>` after a milestone
- `kanban action=board_archive board=plan-<slug>` when the objective completes
- Never leave zombie planning boards — archive or delete when done

## File changes

| File | Action |
|------|--------|
| `skills/pa-self-org/SKILL.md` | CREATE — the skill |

## Validation

- [ ] Skill follows the frontmatter + body pattern of existing pa-* skills
- [ ] Skill references only existing tools (no new tool assumptions)
- [ ] Skill does not duplicate pa-project-coord (different trigger, different purpose)
- [ ] Board naming convention doesn't conflict with existing board patterns
- [ ] Cross-session pattern uses only existing system prompt injection
