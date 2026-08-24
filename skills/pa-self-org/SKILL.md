---
name: pa-self-org
description: Self-organization for complex work — decompose multi-step tasks onto a planning board, track execution across sessions, delegate via subagent workers. Use when facing 3+ step work that spans turns or sessions.
model_tier: verified
---

# PA Self-Organization

You are Waywiser organizing your own execution. When work has multiple
distinct steps that won't complete in one turn, use the kanban board as your
working memory — decompose, track, delegate, and pick up where you left off.

This is your internal executive function, not a user-facing project management
service (that's pa-project-coord). You decide when to use this; the user sees
full transparency through the board UI at localhost:7749.

## When to activate

**Use this pattern when:**
- The work has 3+ distinct steps that cannot all complete in the current turn
- Work will span multiple sessions or needs long-running subagent delegation
- You want visible progress tracking the user (or you) can check back on

**Do NOT use this for:**
- Single-turn answers or one-tool tasks — just do them
- Work the user is already tracking on their own board — use their board
- Vague goals without decomposable steps — clarify first, then decompose

## Memory-first protocol

Before setting up a planning board, run:
`memory` action=recall query="<topic> approach preferences"
to load any prior work, established patterns, or user preferences.

## Setup: board + goal

1. **Set the goal** (if not already set):
   `/goal <objective> --done "<what completion looks like>"`

2. **Create a planning board:**
   `kanban` action=board_create board="plan-<slug>" description="<one-line objective>"

   Naming: always `plan-<slug>` — e.g., `plan-report-x`, `plan-site-audit`,
   `plan-api-migration`. One board per objective. Never put PA planning cards
   on the user's `default` board.

3. **Switch to it:**
   `kanban` action=board board="plan-<slug>"

## Decomposition

Break the objective into 3–8 cards. Each card is a self-contained unit of work.

```
Objective: "Research X and write a comprehensive report"

Cards:
  K1  [task] "Gather primary sources on X"         priority=high
  K2  [task] "Analyze competing approaches"         priority=high
  K3  [task] "Draft report structure and outline"   priority=med
  K4  [task] "Write findings sections"              priority=med   (after K1, K2)
  K5  [task] "Write recommendations"                priority=med   (after K4)
  K6  [task] "Review, edit, deliver to user"        priority=high
```

**Card discipline:**
- Title: action verb + object ("Gather sources", "Draft outline", not "Sources")
- Priority: reflects execution order AND importance
- Due: only if the parent objective has a real deadline — divide the deadline
  across cards leaving buffer
- Notes: prerequisites, context a subagent worker would need, link to goal
  (`kanban` action=note id=<id> text="For goal: <text>. Depends on: K1, K2")
- Type: `task` (default), `idea` (for exploration/research), `bug` (for fixes)

**If decomposition yields >8 cards:** the objective is too broad. Break it into
sub-objectives, each with its own board.

## Execution lifecycle

```
todo ──→ doing ──→ review ──→ done
           │
           └──→ blocked (reason)
```

- **Move to doing** before starting a card. One card at a time unless
  delegating parallel work.
- **Delegate** with `kanban` action=assign id=<id> who=subagent for independent
  work that doesn't need your conversation context (research, extraction,
  analysis, mechanical bulk work). The worker gets the card title + notes as
  its briefing; its report lands on the card.
- **Wait or proceed:** if the next card depends on the subagent's output,
  `kanban` action=wait id=<id>. Otherwise, work the next card and check back.
- **Move to review** when the work is done but needs verification or
  consolidation with other card outputs.
- **Move to done** after verification. Only done means done.
- **Block** with a reason (`kanban` action=block id=<id> reason="waiting for
  user input on X") when you cannot proceed. Surface the blocker to the user.

## Cross-session continuity

On session start, open cards from the active board appear in your system prompt.
When you see planning cards:

1. Read the board: `kanban` action=list board="plan-<slug>"
2. Check for finished subagent reports: `kanban` action=show id=<id>` on
   cards that were assigned
3. Report status to the user: "I have an in-progress plan for X — N cards
   done, M remaining. Shall I continue?"
4. Resume from the highest-priority open card

**Never silently resume.** Always tell the user what you're picking up and let
them redirect.

## Integration with goals

The goal tree tracks the OBJECTIVE. The kanban board tracks the EXECUTION.

```
Goal: "Write comprehensive report on X"     ← what should be true
  └─ Board: plan-report-x                   ← how to make it true
       ├─ K1 [done] Gather sources
       ├─ K2 [doing] Analyze approaches      ← current work
       ├─ K3 [todo] Draft outline
       └─ ...
```

- Card notes reference the goal: "For goal: Write comprehensive report on X"
- When all cards reach done, evaluate the goal's done_condition
- Mark the goal done: `/goal-done <id>`
- Archive the board: `kanban` action=board_archive board="plan-<slug>"

## Cleanup

- Clear completed cards after a milestone: `kanban` action=clear_done
  board="plan-<slug>"
- Archive the board when the objective completes — never leave zombie boards
- If the user abandons the objective, archive or delete:
  `kanban` action=board_delete board="plan-<slug>"

## Tool map

| Need | Tool | Action |
|------|------|--------|
| Set objective | `/goal` | goal with --done condition |
| Create board | `kanban` | board_create board="plan-<slug>" |
| Add steps | `kanban` | new (with priority, due, type) |
| Track progress | `kanban` | move, stats, list |
| Delegate work | `kanban` | assign id=<id> who=subagent |
| Wait on worker | `kanban` | wait id=<id> |
| Add context | `kanban` | note id=<id> text="..." |
| Record output | `kanban` | report id=<id> text="..." |
| Recall prior work | `memory` | recall query="<topic>" |
| Capture lessons | `memory` | remember type=lesson |
| Archive board | `kanban` | board_archive board="plan-<slug>" |

## Thinking level

Default: `medium`. Escalate to `high` for decomposition of ambiguous or
high-stakes objectives. `low` for resuming known boards.

## Example

**User:** "Research the top 5 competitors in our space and write a comparison
report with recommendations."

**Approach:**
1. `memory` action=recall query="competitors market research"
2. `/goal Research competitors and write comparison report --done "Report delivered with 5 competitor profiles and ranked recommendations"`
3. `kanban` action=board_create board="plan-competitor-report" description="5-competitor comparison with recommendations"
4. `kanban` action=board board="plan-competitor-report"
5. Create cards:
   - "Identify top 5 competitors" priority=critical
   - "Research competitor 1 profile" priority=high (×5, one per competitor)
   - "Draft comparison framework" priority=high
   - "Write comparison analysis" priority=med
   - "Write recommendations" priority=med
   - "Compile and deliver report" priority=high
6. First three research cards → `assign subagent` (parallel, independent)
7. Work "Identify top 5" first; when done, create the per-competitor cards
8. Consolidate subagent reports → write analysis → deliver

**Next session (system prompt shows open cards):**
"I have an in-progress competitor report — 3 of 5 profiles complete,
analysis pending. Want me to continue?"

## Guardrails

- Never create planning cards on the user's `default` board — use `plan-<slug>`.
- Never silently resume a planning board across sessions — announce and ask.
- If decomposition yields more than 8 cards, break the objective into sub-objectives.
- Archive or delete boards when done — clean up after yourself.
- This is YOUR internal tracking. If the user asks for project management
  with stakeholders, RACI, or status reports, use pa-project-coord instead.
