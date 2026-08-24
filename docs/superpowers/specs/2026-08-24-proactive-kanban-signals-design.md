# Proactive Engine — Complete Kanban Signals

**Date:** 2026-08-24
**Status:** Spec
**Scope:** Add 5 kanban-aware signals to `gatherSignals()` in `proactive.ts` + tests

---

## Problem

The proactive engine's heartbeat (OODA tick) has 9 signal sources, but only 1
reads kanban state (overdue cards). With the PA now using kanban for internal
self-organization (`pa-self-org` skill), the heartbeat needs full kanban
awareness to catch stale work, aging blockers, dead workers, approaching
deadlines, and completed planning boards.

## Constraints

- **SQL-only**: zero LLM cost per tick (existing invariant)
- **Same `Signal` shape**: key, priority, title, body, requiresLLM
- **Dedup-safe**: unique keys per signal type, existing `lastAlerts` map handles it
- **One file**: all changes in `proactive.ts::gatherSignals()`

## New signals

### Signal 10: Cards due soon (24h warning)

```sql
SELECT id, title, due FROM cards
WHERE due IS NOT NULL
  AND datetime(due) > datetime('now')
  AND datetime(due) <= datetime('now', '+24 hours')
  AND status NOT IN ('done')
ORDER BY due LIMIT 5
```

- **Key:** `cards-due-soon`
- **Priority:** 2 (briefing) — heads-up, not urgent yet
- **requiresLLM:** true — model can help prioritize or reschedule
- **Fires before** the existing overdue signal (#1), giving the user/PA time to act

### Signal 11: Stale doing cards (>24h without update)

```sql
SELECT id, title, updated_at FROM cards
WHERE status = 'doing'
  AND datetime(updated_at) < datetime('now', '-24 hours')
ORDER BY updated_at LIMIT 5
```

- **Key:** `cards-stale-doing`
- **Priority:** 2 (briefing) — may be forgotten work
- **requiresLLM:** true — model should check if the card is still relevant

### Signal 12: Blocked cards aging (>24h unresolved)

```sql
SELECT id, title, block_reason, updated_at FROM cards
WHERE status = 'blocked'
  AND datetime(updated_at) < datetime('now', '-24 hours')
ORDER BY updated_at LIMIT 5
```

- **Key:** `cards-blocked-aging`
- **Priority:** 1 (next-turn) — blockers need active attention
- **requiresLLM:** true — model should attempt to unblock or escalate

### Signal 13: Orphaned workers (worker_child set but stale)

```sql
SELECT id, title, worker_child, updated_at FROM cards
WHERE worker_child IS NOT NULL
  AND status = 'doing'
  AND datetime(updated_at) < datetime('now', '-30 minutes')
ORDER BY updated_at LIMIT 5
```

- **Key:** `cards-orphaned-worker`
- **Priority:** 1 (next-turn) — likely a crashed worker that needs cleanup
- **requiresLLM:** true — model should clean up the card state
- **Threshold:** 30 minutes (max worker timeout is 15 min / 900s)

### Signal 14: Planning board complete (all cards done)

```sql
SELECT b.id, b.name, COUNT(*) as total,
       SUM(CASE WHEN c.status = 'done' THEN 1 ELSE 0 END) as done_count
FROM boards b
JOIN cards c ON c.board_id = b.id
WHERE b.id LIKE 'plan-%'
  AND b.archived = 0
GROUP BY b.id
HAVING total = done_count AND total > 0
```

- **Key:** `board-plan-complete`
- **Priority:** 2 (briefing) — time to archive and evaluate the goal
- **requiresLLM:** true — model should archive the board and check the goal

## File changes

| File | Action |
|------|--------|
| `extensions/proactive.ts` | ADD 5 signal queries in `gatherSignals()` |
| `test/waywiser.test.ts` | ADD 5 test cases following existing pattern |

## Test plan

Each new signal gets one test that:
1. Inserts a card/board into the test DB with the triggering condition
2. Calls `gatherSignals(db_())`
3. Asserts the signal appears with correct key, priority, and body content
