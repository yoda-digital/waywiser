# Time-Aware Waywiser — Phase 2 Design Spec

**Date:** 2026-08-25
**Status:** Draft
**Predecessor:** `2026-08-24-time-awareness-design.md` (Phase 1 — merged)
**Scope:** Per-message TUI timestamps + finish the ecosystem time-awareness pass

## Context

Phase 1 (Aug 24) landed:

- Shared `extensions/utils/time.ts` with `fmtTime` / `fmtDate` / `fmtDateTime` / `fmtStamp` / `fmtDateOnly` / `fmtIso` / `fmtDuration` / `fmtAge` / `nowIso` / `nowEpoch` / `parseTs` / `userTz`.
- `extensions/clock.ts` — status-bar clock + `[Time context]` system-prompt injection.
- Journey, proactive, delegate, memory recall, kanban card lines, kanban HTML dates, soul stamps — all migrated onto the shared module.

Phase 1 declared per-message TUI stamping impossible on the stated grounds that pi's `UserMessageComponent` / `AssistantMessageComponent` are internal. That constraint is **incorrect**: pi ships `ExtensionAPI.registerMarkdownTransformer(transformer)` (see `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:921`). The transformer runs on the markdown body of every `user`, `assistant`, and `assistant-thinking` message before pi renders it. That is the hook Phase 2 uses.

Phase 2 also closes the surfaces Phase 1 skipped: brain (memories, procedures, experiences, traces), kanban HTML card footer, notify webhook, cronjob listings, mobile inbox, and inspection commands.

## Problem

1. **No per-message TUI stamps.** Users still cannot see when a message was sent or received. The status-bar clock shows "now" but not the history of the turn.
2. **Brain output is time-blind.** `renderBrainContext` injects recalled memories and procedures into the system prompt with no recency signal. `handleMemoryInspect` and `handleExperienceInspect` emit raw ISO fields the LLM must parse mentally.
3. **Brain traces have no wall-clock sibling.** ISO timestamps only.
4. **Kanban HTML footer** still shows raw SQLite datetime strings.
5. **Notify webhook payloads** ship only ISO — downstream consumers have no human-formatted field.
6. **Telegram notifications** cross midnight without indicating date.
7. **Mobile inbox** items lack per-item timestamps.
8. **Cronjob listings** don't show last-run stamp or age.
9. **No adaptive age-vs-stamp choice** for older items — everything is stamp or everything is age; the point at which age becomes more legible than absolute date is not codified.

## Non-Goals

- Reworking pi's native message rendering (still off-limits — we only edit the markdown pi feeds those renderers).
- Adding a separate gutter/column for timestamps (pi doesn't expose that surface; the transformer prefixes inline).
- Persisting `wallClock` alongside stored ISO — derivation stays at display time.
- Migrating the Obsidian plugin — it has its own rendering context (unchanged in Phase 1, unchanged here).
- Switching stored timestamp format. SQLite `datetime('now')` (UTC, space separator) and JS `toISOString()` (UTC, `T` separator) both stay; `parseTs` already normalizes.
- Adding a datetime dependency (moment, dayjs, luxon). Native `Intl` only.
- New locales beyond the current `en-GB` (times) / `en-US` (dates) mix.

## Design

### § 1 — TUI stamping (`extensions/tui-stamps.ts`, new)

Registers exactly one thing: a `MarkdownTransformer`.

```typescript
pi.registerMarkdownTransformer((md, mtCtx) => {
  if (!enabled) return md;
  if (mtCtx.messageType === "assistant-thinking") return md;
  const stamp = stampForMessage(mtCtx);      // adaptive cache — see below
  return `${renderStamp(stamp)} ${md}`;       // e.g. "`[14:23]` <original md>"
});
```

**Format rules** (adaptive per Section § 5 choice `3`):

| `messageType` | Output |
|---|---|
| `user` | dim `[HH:MM]` (or `[Mon DD, HH:MM]` cross-day) |
| `assistant` | dim `[HH:MM]` (or `[Mon DD, HH:MM]` cross-day) |
| `assistant-thinking` | no change |

Cross-day / cross-year is handled by delegating to `fmtStamp` (from Phase 1). Times use user timezone via `userTz`.

**Stamp caching (streaming safety).**
`MarkdownTransformContext` provides `messageType` + `isStreaming` + `availableWidth` — no stable message id. Approach:

- Maintain `stampCache: Map<string, number>` (LRU, cap 64) — value is the pinned `Date.now()` for that message.
- Key = `${messageType}|${md.slice(0, 40)}`. First 40 chars are stable across streaming updates for the same message (they start identical and only grow); risk of collision across turns is bounded by the 40-char prefix and mitigated by evicting on `session_start` and `message_end`.
- On cache hit → reuse timestamp. On miss → `Date.now()`, insert.
- On `pi.on("message_end", …)` → walk cache and evict any entry whose key starts with the ended message's first 40 chars.
- On `pi.on("session_start", …)` → clear cache entirely.

If pi later exposes a stable message id on `MarkdownTransformContext`, migrate. Add a TODO comment referencing the pi upstream request.

**Dim rendering.**
The markdown transformer produces markdown, not ANSI. To get a muted color we lean on pi's inline-code theme color:

```typescript
function renderStamp(ms: number): string {
  return style === "code" ? `\`[${fmtStamp(ms)}]\`` : `[${fmtStamp(ms)}]`;
}
```

Default `style: "code"`. If code coloring is too loud in practice, users flip to `"plain"` in config. If pi's inline-code renderer changes color rules, we still render, just not muted.

**Loading.**
Add `"./tui-stamps.js"` to the modules list in `extensions/index.ts`, positioned AFTER `"./clock.js"` (last). The transformer only affects display; late load is safe.

**Configuration** (new keys under `~/.waywiser/config.json`):

```json
{
  "tuiStamps": {
    "enabled": true,
    "style": "code"
  },
  "timeDisplay": {
    "relativeThresholdHours": 24
  }
}
```

- `tuiStamps.enabled: false` → transformer becomes a passthrough (no unregister needed; the file still loads).
- `timeDisplay.relativeThresholdHours` → drives § 2's `fmtSmart` helper (below). Default 24: anything ≤ 24h old renders as age; older renders as `fmtStamp`.

Config is read once per turn from `before_agent_start` into module-local state so the hot path (`registerMarkdownTransformer` callback) doesn't touch disk.

### § 2 — New helper `fmtSmart` in `extensions/utils/time.ts`

The only new addition to the shared time module. Chosen policy for "adaptive" display:

```typescript
/**
 * Age when recent, absolute stamp when old.
 * "3h ago" for a memory touched yesterday afternoon,
 * "Aug 20, 09:15" for something from 5 days ago.
 * If thresholdHours is omitted, reads from config
 * (timeDisplay.relativeThresholdHours, default 24).
 */
export function fmtSmart(v: string | number, thresholdHours?: number): string {
  const ms = parseTs(v);
  const t = thresholdHours ?? relativeThresholdHours();
  const ageHours = (Date.now() - ms) / 3_600_000;
  return ageHours >= 0 && ageHours <= t ? fmtAge(v) : fmtStamp(v);
}
```

`relativeThresholdHours()` is a new cached getter in `utils/time.ts` (same shape and cache policy as `userTz()`): reads `~/.waywiser/config.json` `timeDisplay.relativeThresholdHours`, validates it's a positive finite number, falls back to `24`, logs to stderr once per session on invalid.

Called from every surface that lists historical items (brain recall, memory inspect, cronjob last-run, kanban card age, mobile inbox items). Fresh items (< threshold) get age; older items get a concrete date.

### § 3 — Time-awareness gap fills (per file)

Each edit imports only from `./utils/time.js` (or `../utils/time.js`).

**`extensions/brain/prompts.ts` — `renderBrainContext`**

Every memory line gains ` (last used ${fmtSmart(m.last_accessed ?? m.created_at)})`. Every procedure line gains ` (${uses} uses, last ${fmtSmart(p.last_used)})`. If experiences are injected, each gets ` (${fmtSmart(startedAt)})`.

**`extensions/brain/index.ts` — inspection handlers**

`handleMemoryInspect` and `handleExperienceInspect` return the raw object plus derived fields: `startedAtHuman: fmtDateTime(startedAt)`, `settledAtHuman: fmtDateTime(settledAt)`, `age: fmtAge(startedAt ?? createdAt)`. Raw ISO fields stay untouched.

**`extensions/brain/trace.ts` — emitted trace rows**

Each observation-facing row gains `wallClock: fmtStamp(timestamp)` alongside the existing ISO `timestamp`. On-disk storage unchanged (trace rows written straight to disk keep their ISO shape).

**`extensions/kanban-html.ts` — card footer**

Line ~197: swap `${created_at} · ${updated_at}` for `created ${fmtStamp(created_at)} · updated ${fmtStamp(updated_at)} (${fmtAge(updated_at)})`. Overdue cards prefix a badge `⚠️ ${fmtAge(due)} overdue` (using the existing `isOverdue(c)` helper).

**`extensions/kanban/ops.ts` — `cardLine` for `todo` status**

Phase 1 already added age for non-`done`, non-`todo` statuses. Fill the `todo` gap the same way so a card that has been sitting in `todo` for weeks reads as such. Format: same suffix pattern already used for `doing`/`blocked`.

**`extensions/notify.ts` — webhook payload**

Line ~292: extend the outgoing JSON with `human: fmtStamp(now)` and `age: fmtAge(now)` next to the existing `iso` (or `timestamp`) field. No removal — additive only, so downstream consumers don't break.

**`extensions/notify.ts` — Telegram body**

Swap `fmtTime(Date.now())` → `fmtStamp(Date.now())` so a notification arriving after midnight includes the date.

**`extensions/mobile/index.ts` — inbox delivery**

`processMessage` (line ~88) currently calls `pi.sendUserMessage("[reply] " + text, …)` and similar for each drained `InboxMessage`. Each `InboxMessage` carries `receivedAtMs` (set in `extensions/mobile/inbox.ts:enqueueMessage`). Change: prefix the body with `[received ${fmtStamp(msg.receivedAtMs)} · ${fmtAge(msg.receivedAtMs)}]` BEFORE calling `sendUserMessage`, so the original arrival time is preserved in the message body. The tui-stamps transformer will still add the send-time stamp on top; the two stamps together read as "arrived X, delivered to session Y" — deliberate.

**`extensions/commands.ts` — sweep**

Grep for `.slice(0,16).replace('T',' ')`, `.toISOString()`, and bare `${…created_at}` inside `ctx.ui.notify` calls. Every remaining raw stamp in `/goals`, `/mem list`, `/mem stats`, `/waywiser status` is upgraded to `fmtStamp`, `fmtDateTime`, or `fmtSmart` depending on whether it's a moment (single event) vs a historical item (list row).

**`extensions/cronjob.ts` — listings**

Each job row gains `last: ${lastRun ? fmtSmart(lastRun) : "never"}` and, for jobs with a stored `nextRun`, `next: ${fmtDateTime(nextRun)}`.

**`extensions/proactive.ts`, `extensions/meta-skills.ts`, `extensions/clarify.ts` — sweep**

Grep pass; format any user- or LLM-facing timestamps using the same rules (moment → `fmtStamp`, historical → `fmtSmart`).

### § 4 — Data flow

```
[storage: ISO or SQLite datetime, always UTC]
        │
        ▼
     parseTs()  (unchanged from Phase 1)
        │
        ▼
   ┌───────────────────────┐
   │ Presentation formatter │  ← userTz() + relativeThresholdHours (config)
   └───────────────────────┘
        │
        ▼
   ┌─────────────────────────────────────────────┐
   │ Surface: TUI markdown | ctx.ui.notify |     │
   │ system-prompt injection | webhook payload | │
   │ kanban HTML | brain trace row               │
   └─────────────────────────────────────────────┘
```

Every write path continues to store UTC. Every read path derives at display time. No stored timestamp is mutated.

### § 5 — Error handling

| Failure | Behavior |
|---|---|
| `parseTs` throws on garbage stored value | Caller catches, renders `?` in place, logs once per unique bad value (module-local seen-set). Never crashes the surface. This matches Phase 1's `fix(time): card age UTC parsing + deadline crash guard`. |
| `userTz()` config invalid | Existing Phase 1 behavior: falls back to system tz. |
| `relativeThresholdHours` malformed | Defaults to 24, warn to stderr once at load. |
| `registerMarkdownTransformer` throws inside transformer | Wrap the whole callback body in try/catch; on error return the original markdown unchanged; log once per session. Prevents a broken stamp from wiping user messages. |
| Streaming cache OOM | LRU cap 64 + eviction on `message_end` / `session_start`. |
| pi later removes / renames `registerMarkdownTransformer` | Feature is gracefully absent (module-load error is caught by `extensions/index.ts` per-module). Everything else in Phase 2 still works. |

### § 6 — Testing

Existing test suite: `node:test`, `jiti` imports, `WAYWISER_HOME` isolation. Add:

**`test/time-smart.test.ts`**
- `fmtSmart` chooses age when `ageHours ≤ threshold`, stamp when `>`.
- Boundary tie (`age === threshold`) → age (documented tie-break).
- Future timestamps → age (`in Xm` from `fmtAge`).
- Custom threshold via arg.
- Invalid input → throws (mirrors `parseTs` contract).

**`test/tui-stamps.test.ts`**
- Transformer passes through `assistant-thinking`.
- Transformer prefixes `user` and `assistant`.
- Two calls with `isStreaming: true` and identical `md.slice(0, 40)` return the SAME stamp (mocked clock advancing between calls).
- `message_end` for that message evicts the cache entry (subsequent identical prefix → new stamp).
- `session_start` clears the whole cache.
- `enabled: false` config → passthrough.
- Transformer body throw → returns original markdown, does not raise.

**Integration**
- Extend `test/brain-*.test.ts`: recall a memory, assert the injection string includes `(last used …)` and the trailer parses back to a duration via a regex.
- Extend the kanban HTML snapshot test (if one exists; otherwise smoke): the footer contains `created `, `updated `, and no raw `T` separator.
- Extend the notify webhook test: payload keys include `iso`, `human`, `age`.

**Manual smoke (documented in PR body)**
1. `bin/waywiser` → send a message → both sides show `[HH:MM]` prefix.
2. `/mem recall <term>` → recalled rows show `(last used …)`.
3. Add + update a kanban card → HTML board shows `created …` / `updated …` / age.
4. `/journey`, `/goals`, `/mem list`, `/waywiser status` → every row shows a formatted stamp.
5. Configure a webhook → outbound payload has `iso`, `human`, `age`.
6. `/proactive status`, cronjob list → last-run shows age when recent, stamp when older.
7. Flip `tuiStamps.enabled = false` → restart → messages render without stamps.

### § 7 — Rollout

- Single feature branch (current `feat/mobile`), single PR.
- Config defaults: `tuiStamps.enabled = true`, `tuiStamps.style = "code"`, `timeDisplay.relativeThresholdHours = 24`. Users can flip either off in `config.json` (requires restart — pi doesn't hot-reload extension config; document in PR body).
- No migration. Presentation-only.
- Backwards compatibility:
  - Webhook payload gains fields, removes none.
  - Kanban HTML re-renders on next update (no persisted format change).
  - Brain injection gains a trailing `(last used …)` per line — LLM-visible only, no downstream tooling consumes this.

## New Files

| File | Purpose |
|---|---|
| `extensions/tui-stamps.ts` | Registers the `MarkdownTransformer`, owns the streaming cache and config gate. |
| `test/time-smart.test.ts` | Unit tests for `fmtSmart`. |
| `test/tui-stamps.test.ts` | Unit tests for the transformer + cache. |

## Modified Files

| File | Nature of change |
|---|---|
| `extensions/utils/time.ts` | Add `fmtSmart` + cached `relativeThresholdHours()` getter. |
| `extensions/index.ts` | Add `"./tui-stamps.js"` as the LAST entry in the modules array. |
| `extensions/brain/prompts.ts` | Recall injection lines gain `fmtSmart` age suffix. |
| `extensions/brain/index.ts` | Inspection commands emit `*Human` + `age` derived fields. |
| `extensions/brain/trace.ts` | Emitted trace rows gain `wallClock`. |
| `extensions/kanban-html.ts` | Card footer uses `fmtStamp` + `fmtAge`, overdue badge. |
| `extensions/kanban/ops.ts` | `cardLine` fills `todo` age gap. |
| `extensions/notify.ts` | Webhook payload gains `human` + `age`; Telegram body uses `fmtStamp`. |
| `extensions/mobile/index.ts` | Inbox delivery prefixes bodies with `[received …]` using `receivedAtMs`. |
| `extensions/commands.ts` | Sweep any remaining raw stamps in `/goals`, `/mem list`, `/mem stats`, `/waywiser status`. |
| `extensions/cronjob.ts` | Job listings show `fmtSmart(lastRun)` + `fmtDateTime(nextRun)`. |
| `extensions/proactive.ts`, `extensions/meta-skills.ts`, `extensions/clarify.ts` | Grep sweep, format any raw stamps. |

## Verified During Implementation

- **Style knob rendering** — `"code"` style depends on pi's inline-code theme color being muted. Manual smoke (see § 6 step 1) confirms this. If it renders as syntax-highlighted code instead of dim text, flip the default to `"plain"` before merge.
