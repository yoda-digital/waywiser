---
name: pa-onboard
description: PA system onboarding — first-run setup for personal assistant capabilities. Creates default crons, captures preferences, initializes PA infrastructure. Auto-triggered on first PA interaction when no pa-onboarded memory exists.
model_tier: verified
---

# PA Onboarding

You are Waywiser running first-time PA setup. This skill initializes the
personal assistant infrastructure so PA skills work from day one.

**Trigger:** the catalog injection checks for a `pa-onboarded` memory. If absent,
it instructs you to load this skill before any other PA skill.

## Setup checklist

Run through this sequentially. Ask the user each question, then configure.
If they skip a question, use the sensible default and move on.

### 1. Working hours & timezone

Ask: "What are your typical working hours and timezone?"
Default: Mon-Fri 09:00-18:00, system timezone.

Actions:
- `memory` action=remember type=preference content="Working hours: <hours>, timezone: <tz>"
- `cronjob` action=set_quiet window="22:00-07:00" (or derive from working hours)

### 2. Daily planning review

Ask: "Want a daily planning prompt each morning? What time?"
Default: yes, 08:00 Mon-Fri.

Actions:
- `cronjob` action=schedule schedule="0 8 * * 1-5" name="pa-daily-review" mode=session prompt="Good morning. Review today's priorities: recall open kanban cards, check deadlines in the next 48 hours, and present a focused plan for today. Use skill_view name=pa-time-manage for methodology."

### 3. Weekly review

Ask: "Want a weekly review? Which day and time?"
Default: yes, Friday 16:00.

Actions:
- `cronjob` action=schedule schedule="0 16 * * 5" name="pa-weekly-review" mode=session prompt="Weekly review time. Summarize: what was completed this week (kanban done cards), what is still open, what is overdue, and what should be prioritized next week. Use skill_view name=pa-time-manage for methodology. After the review, run memory action=consolidate dry_run=true and report findings."

### 4. Calendar source

Ask: "Where is your calendar? (Google Calendar via MCP, a file, or you'll tell me manually)"

Actions:
- If Google Calendar: verify MCP config has it, `memory` remember type=fact content="Calendar source: Google Calendar via MCP"
- If file: `memory` remember type=fact content="Calendar source: <path>"
- If manual: `memory` remember type=preference content="Calendar: user provides agenda verbally each session"

### 5. Communication preferences

Ask: "Preferred language for PA interactions? Notification channel? (desktop/telegram/webhook)"

Actions:
- `memory` action=remember type=preference content="PA language: <lang>"
- `memory` action=remember type=preference content="Notification channel: <channel>"

### 6. Key contacts & recurring commitments

Ask: "Any recurring meetings, key contacts, or standing commitments I should know about?"

Actions:
- For each: `memory` action=remember type=fact content="Recurring: <commitment>"
- For regular meetings: consider a `cronjob` reminder

### 7. PA kanban board

Create the PA overview board:
- `kanban` action=board_create board="pa-overview"
- `kanban` action=new board="pa-overview" title="PA system onboarded" type=task priority=low
- `kanban` action=move id=<id> status=done

### 8. Mark onboarding complete

- `memory` action=remember type=decision content="PA system onboarded on <date>. Daily review: <time>, weekly review: <day> <time>, calendar: <source>, language: <lang>, notifications: <channel>"

## Example interaction

**Waywiser:** "I'm setting up your personal assistant capabilities. I'll ask a few questions to configure things — skip any you want and I'll use sensible defaults."

**Waywiser:** "1/6 What are your working hours? (default: Mon-Fri 09:00-18:00)"
**User:** "8-17, same days"
**Waywiser:** *(sets quiet hours 22:00-07:00, remembers working hours 08:00-17:00)*

**Waywiser:** "2/6 Want a daily morning planning prompt? What time? (default: 08:00)"
**User:** "da, la 7:30"
**Waywiser:** *(creates cronjob 7:30 Mon-Fri, confirms)*

...and so on through all 6 questions.

## Tool integration

| Setup step | Tool | Action |
|-----------|------|--------|
| Preferences | `memory` | remember type=preference |
| Quiet hours | `cronjob` | set_quiet |
| Daily review | `cronjob` | schedule (session-mode) |
| Weekly review | `cronjob` | schedule (session-mode) |
| PA board | `kanban` | board_create + new |
| Ask questions | `clarify` | step-by-step setup |
| Confirm setup | `notify` | summary notification |

## Thinking level

`low` — this is a setup wizard, not complex analysis.

## Guardrails

- Never assume preferences — always ask or use stated defaults.
- Don't create crons the user declined.
- If MCP calendar isn't configured, don't pretend it is — tell the user what's needed.
- Mark onboarding complete so it doesn't repeat every session.
