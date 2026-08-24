# Time-Aware Waywiser — Design Spec

**Date:** 2026-08-24
**Status:** Approved
**Scope:** Cross-cutting — shared time module, TUI time surfaces, ecosystem time awareness

## Problem

Waywiser has no shared time infrastructure:

1. **No timestamps in TUI** — Standard chat messages, proactive signals, subagent reports, and notifications display no timestamps. Users lose temporal context during sessions.
2. **No shared time module** — 6+ modules each roll their own formatters (`fmtDate`, `fmtShortDate`, `parseHM`, inline ISO slicing). Duplicated, inconsistent.
3. **No user timezone** — All display is raw UTC or system-dependent. No config for timezone preference. SQLite stores `YYYY-MM-DD HH:MM:SS` (UTC), JS produces `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC) — compatible but syntactically different, never normalized.
4. **LLM is time-blind** — The system prompt carries no temporal context. The model can't reference time of day, session duration, or relative time naturally.
5. **Memory/brain display lacks temporal context** — Recall output doesn't show memory age. Experience traces show raw ISO, not human-readable durations.

## Constraint

Pi's built-in `UserMessageComponent` and `AssistantMessageComponent` are internal to the Pi harness. Waywiser cannot modify their rendering from extension land. Standard user/assistant chat messages will not get visual timestamps.

Workarounds:
- **Status bar clock** — Always-visible time via `ctx.ui.setStatus()`, updated at turn boundaries and on a 1-minute idle timer.
- **System prompt time injection** — The LLM becomes time-aware and naturally references times in its responses.

## Design

### Layer 1: `extensions/utils/time.ts` — Shared Time Module

A new module that replaces all ad-hoc time formatting across the codebase.

#### User Timezone

Read from `~/.waywiser/config.json` under the top-level `"timezone"` key (IANA string, e.g. `"Europe/Chisinau"`). Falls back to `Intl.DateTimeFormat().resolvedOptions().timeZone` (system TZ).

```typescript
export function userTz(): string {
  const cfg = readJSON<{ timezone?: string }>(configFile(), {});
  if (cfg.timezone && isValidTz(cfg.timezone)) return cfg.timezone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
```

Validation: `isValidTz(tz)` tries `Intl.DateTimeFormat("en", { timeZone: tz })` and catches on invalid.

#### Timestamp Parsing

Handles both SQLite format (`YYYY-MM-DD HH:MM:SS`, implicitly UTC) and JS ISO format (`YYYY-MM-DDTHH:MM:SS.sssZ`):

```typescript
export function parseTs(v: string | number): number {
  if (typeof v === "number") return v;
  // SQLite format has a space separator and no trailing Z — treat as UTC
  const normalized = v.includes("T") ? v : v.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp: ${v}`);
  return ms;
}
```

#### Core Formatters

All accept `string | number` (ISO string or epoch ms), output in user timezone. Format chosen: **always absolute** (HH:MM, with date when cross-day).

```typescript
// Time only: "14:23"
export function fmtTime(v: string | number): string;

// Date only: "Aug 24"
export function fmtDate(v: string | number): string;

// Full: "Aug 24, 14:23" (cross-year: "Aug 24 2025, 14:23")
export function fmtDateTime(v: string | number): string;

// Smart stamp: same day → "14:23", cross-day → "Aug 24, 14:23"
export function fmtStamp(v: string | number): string;

// ISO date: "2026-08-24" (for persistence, SOUL.md datestamps)
export function fmtDateOnly(v: string | number): string;

// Full ISO: "2026-08-24T14:23:00.000Z"
export function fmtIso(v: string | number): string;
```

Implementation uses `Intl.DateTimeFormat` with `{ timeZone: userTz() }`. No external dependencies.

`fmtStamp` is the **primary formatter** for TUI display. Same-day detection compares the formatted date part of the input against today's formatted date.

#### Duration and Age

```typescript
// Duration: 0-59s → "Xs", 1-59m → "Xm Ys", 1-23h → "Xh Ym", 1d+ → "Xd Yh"
export function fmtDuration(ms: number): string;

// Age: fmtDuration(now - parseTs(v)) + " ago"
export function fmtAge(v: string | number): string;
```

#### Convenience Entry Points

```typescript
export function nowIso(): string { return new Date().toISOString(); }
export function nowEpoch(): number { return Date.now(); }
```

These replace scattered `new Date().toISOString()` and `Date.now()` calls where the intent is "current time for stamping." Timer intervals and `setTimeout` scheduling continue to use `Date.now()` directly (they're not timestamps, they're scheduling primitives).

### Layer 2: TUI Time Surfaces

#### 2a. Status Bar Clock

New module: **`extensions/clock.ts`**

A lightweight extension that:
1. Caches `latestCtx` from `before_agent_start` and `agent_settled` (same pattern as proactive.ts)
2. Sets `ctx.ui.setStatus("waywiser:clock", "🕐 14:23")` at turn boundaries
3. Runs a 1-minute `setInterval` (with `.unref()`) that updates the clock during idle periods

```typescript
export default function clock(pi: ExtensionAPI): void {
  let latestCtx: ExtensionContext | undefined;

  const update = () => {
    if (latestCtx) latestCtx.ui.setStatus("waywiser:clock", `🕐 ${fmtTime(Date.now())}`);
  };

  pi.on("before_agent_start", (_e, ctx) => { latestCtx = ctx; update(); });
  pi.on("agent_settled", (_e, ctx) => { latestCtx = ctx; update(); });

  const timer = setInterval(update, 60_000);
  (timer as unknown as { unref?: () => void }).unref?.();

  pi.on("session_shutdown", () => { clearInterval(timer); });
}
```

Loaded from `extensions/index.ts` in the modules list, after `commands.js` (low priority — clock doesn't gate other modules).

#### 2b. System Prompt Time Injection

Registered in `before_agent_start` as a **volatile** injection at priority 7 (between PERMISSIONS at 6 and any future lower-priority injections):

```
[Time context]
Current: Sunday, Aug 24, 2026 14:23 (Europe/Chisinau)
Session active: 2h 15m
```

Add `TIME_CONTEXT: 7` to `PRIORITIES` in `prompt-budget.ts`.

Implementation: register the injection from `clock.ts`'s `before_agent_start` handler:

```typescript
registerInjection({
  key: "time-context",
  priority: PRIORITIES.TIME_CONTEXT,
  content: buildTimeContext(sessionStartAt),
  cacheable: false, // volatile — changes every turn
});
```

The `sessionStartAt` is captured at `session_start` as `Date.now()`.

#### 2c. Proactive Signal Timestamps

In `extensions/proactive.ts`, the signal delivery line:

```typescript
// Before:
pi.sendUserMessage(`[proactive] ${signal.body}`, { deliverAs: "followUp" });
// After:
pi.sendUserMessage(`[${fmtTime(Date.now())} proactive] ${signal.body}`, { deliverAs: "followUp" });
```

Same for notification delivery:
```typescript
// Before:
await sendNotification(signal.title, signal.body, ...);
// After:
await sendNotification(signal.title, `[${fmtTime(Date.now())}] ${signal.body}`, ...);
```

And the `/proactive signals` preview:
```typescript
// Before:
`P${s.priority} [${s.requiresLLM ? "turn" : "notify"}] ${s.title}: ${s.body}`
// After:
`P${s.priority} [${s.requiresLLM ? "turn" : "notify"}] ${s.title}: ${s.body}`
// (preview doesn't need timestamps — these are hypothetical signals)
```

#### 2d. Subagent Report Timestamps

In `extensions/delegate.ts`, the `childReport()` function (or the assembly in `agent_end`) gains timestamps and durations:

```typescript
// Before:
`[waywiser-*] ${fresh.length} delegated subagent(s) finished:\n\n${fresh.map(childReport).join(...)}`
// After:
`[${fmtTime(Date.now())} waywiser-*] ${fresh.length} delegated subagent(s) finished:\n\n${fresh.map(c => `[${fmtStamp(c.finishedAt ?? Date.now())}] ${childReport(c)} (took ${fmtDuration((c.finishedAt ?? Date.now()) - c.startedAt)})`).join(...)}`
```

#### 2e. Command Output Timestamps

**`/journey`**: Journey log entries currently display `[${r.created_at}]` (raw UTC). Change to `[${fmtStamp(r.created_at)}]`.

**`/waywiser status`**: Add session time. Change proactive last tick from raw ISO to `fmtStamp() (fmtAge())`.

**`/proactive status`**: Same — `Last tick: ${lastTickAt ? `${fmtStamp(lastTickAt)} (${fmtAge(lastTickAt)})` : "never"}`.

**`/goals`**: Goal deadlines formatted with `fmtDateTime()`.

### Layer 3: Ecosystem Time Awareness

#### 3a. Memory Temporal Context

In `extensions/memory.ts`, the `runRecallText()` function enriches recalled memories with age:

```typescript
// Before:
`[${r.type}] ${r.content}`
// After:
`[${r.type}, ${fmtAge(r.created_at)}] ${r.content}`
```

This appears in the system prompt recall injection, so the LLM sees temporal freshness of each recalled memory.

#### 3b. Brain Experience Traces

In `extensions/brain/trace.ts`, `settledAt` computation already produces an ISO string. Add a human-readable duration:

```typescript
// In the experience summary/log:
`settled in ${fmtDuration(Date.parse(settledAt) - Date.parse(startedAt))}`
```

#### 3c. Kanban Temporal Display

In `extensions/kanban/ops.ts`:
- Replace `fmtShortDate()` with `fmtStamp()` from the shared module
- `cardLine()` gains temporal info: `K-abc: fix login (doing, 2h)` where "2h" is time since `updated_at`
- Due dates formatted with `fmtDateTime()`: `due Aug 25, 09:00`

In `extensions/kanban-html.ts`:
- Replace `fmtDate()` with the shared module's `fmtDate()`/`fmtDateTime()`
- The web UI's last-event timestamp already uses `toLocaleTimeString()` — leave as-is (browser-local)

#### 3d. Kanban Widget

The kanban TUI widget (`ctx.ui.setWidget("kanban", [...])`) shows a compact board. If card lines include temporal info from `cardLine()`, the widget inherits it automatically.

## Replacement Map

Every ad-hoc formatter being replaced:

| Location | Current | Replacement |
|---|---|---|
| `kanban-html.ts:65` | `fmtDate()` (YYYY-MM-DD) | `time.fmtDateOnly()` (same output) |
| `kanban/ops.ts:67` | `fmtShortDate()` (Mon DD) | `time.fmtStamp()` |
| `kanban-html.ts:271` | `new Date().toLocaleTimeString()` | Leave (browser-side JS) |
| `kanban-html.ts:444` | Inline ISO slice | `time.fmtDateTime()` |
| `obsidian/src/dashboard-view.ts:199` | `.slice(11, 16)` HH:MM | Leave (Obsidian plugin has its own rendering context) |
| `obsidian/src/commands.ts:101` | `.slice(11, 16)` HH:MM | Leave (Obsidian plugin) |
| `soul.ts:137` | `.toISOString().slice(0, 10)` | `time.fmtDateOnly()` |
| `commands.ts:281` | `[${r.created_at}]` raw UTC | `[${time.fmtStamp(r.created_at)}]` |
| `proactive.ts:546` | `new Date(lastTickAt).toISOString()` | `time.fmtStamp(lastTickAt)` |
| `cronjob.ts:54` | `parseHM()` | Keep (DND is local-clock logic, not display) |
| `delegate.ts:278` | Inline age calc in seconds | `time.fmtDuration()` |

The Obsidian plugin (`plugins/obsidian/`) is left unchanged — it runs in Obsidian's rendering context with its own timezone handling.

## Config

New top-level key in `~/.waywiser/config.json`:

```json
{
  "timezone": "Europe/Chisinau",
  "proactive": { ... },
  "promptBudget": { ... }
}
```

`timezone` is optional. When absent, `userTz()` returns the system timezone. No migration needed — missing key = system default behavior.

## New Files

| File | Purpose |
|---|---|
| `extensions/utils/time.ts` | Shared time formatting, parsing, timezone |
| `extensions/clock.ts` | Status bar clock + system prompt time injection |

## Modified Files

| File | Nature of change |
|---|---|
| `extensions/utils/prompt-budget.ts` | Add `TIME_CONTEXT: 7` to PRIORITIES |
| `extensions/index.ts` | Add `"./clock.js"` to modules list |
| `extensions/proactive.ts` | Import `fmtTime`; timestamp signal delivery |
| `extensions/delegate.ts` | Import `fmtStamp`, `fmtDuration`; timestamp reports |
| `extensions/commands.ts` | Import `fmtStamp`, `fmtAge`, `fmtDateTime`; all command outputs |
| `extensions/notify.ts` | Import `fmtTime`; timestamp notification body |
| `extensions/memory.ts` | Import `fmtAge`; age in recall output |
| `extensions/brain/trace.ts` | Import `fmtDuration`; human-readable experience durations |
| `extensions/kanban/ops.ts` | Import `fmtStamp`, `fmtDateTime`, `fmtDuration`; replace fmtShortDate, add card age |
| `extensions/kanban-html.ts` | Import `fmtDateOnly`, `fmtDateTime`; replace local fmtDate |
| `extensions/soul.ts` | Import `fmtDateOnly`; replace inline ISO slice |

## Testing

Extend the existing test suite (`node:test`, `jiti` imports, `WAYWISER_HOME` isolation):

- **`tests/time.test.ts`** — Unit tests for all formatters: both input formats (SQLite/JS ISO), timezone handling, same-day vs cross-day, duration edge cases, age formatting, invalid input handling.
- **`tests/clock.test.ts`** — Clock module: verify status update calls, time injection content, session duration calculation.
- **Existing test updates** — Tests that assert on command output text (`/journey`, `/proactive status`) will need updated assertions to match the new timestamped format.

## Non-Goals

- Modifying Pi's built-in message component rendering
- Adding an external date library (moment, dayjs, luxon)
- Changing SQLite storage format (UTC is correct for persistence)
- Timezone conversion in SQLite queries (UTC-to-UTC comparisons are correct)
- Modifying the Obsidian plugin's time handling
