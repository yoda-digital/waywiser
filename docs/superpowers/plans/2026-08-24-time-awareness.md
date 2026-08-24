# Time-Aware Waywiser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Waywiser output timestamped with always-absolute HH:MM format and the entire ecosystem time-aware, from a shared time module through TUI surfaces to LLM temporal context.

**Architecture:** A new `extensions/utils/time.ts` module provides all formatting, parsing, and timezone logic. A new `extensions/clock.ts` drives the status bar clock and system prompt time injection. All existing ad-hoc formatters are replaced with imports from the shared module.

**Tech Stack:** Node.js native `Intl.DateTimeFormat` with IANA timezone strings. No external date libraries. `node:test` for testing.

**Spec:** `docs/superpowers/specs/2026-08-24-time-awareness-design.md`

## Global Constraints

- No external date library dependencies (moment, dayjs, luxon)
- All formatters use `Intl.DateTimeFormat` with user timezone
- SQLite storage format unchanged (UTC `datetime('now')`)
- Obsidian plugin unchanged (separate rendering context)
- Browser-side JS in kanban-html.ts unchanged (runs in browser context)
- TypeScript, `node:test`, `jiti` imports for tests
- Tests isolate via `WAYWISER_HOME` env var pointing to a temp directory

---

### Task 1: Shared Time Module — `extensions/utils/time.ts`

**Files:**
- Create: `extensions/utils/time.ts`
- Create: `test/time.test.ts`

**Interfaces:**
- Consumes: `readJSON` from `extensions/utils/state.ts` (for config reading)
- Produces: All functions below — every subsequent task imports from this module:
  - `userTz(): string`
  - `isValidTz(tz: string): boolean`
  - `parseTs(v: string | number): number`
  - `fmtTime(v: string | number): string` → `"14:23"`
  - `fmtDate(v: string | number): string` → `"Aug 24"`
  - `fmtDateTime(v: string | number): string` → `"Aug 24, 14:23"` or `"Aug 24 2025, 14:23"` cross-year
  - `fmtStamp(v: string | number): string` → same-day `"14:23"`, cross-day `"Aug 24, 14:23"`
  - `fmtDateOnly(v: string | number): string` → `"2026-08-24"`
  - `fmtIso(v: string | number): string` → full ISO string
  - `fmtDuration(ms: number): string` → `"5s"`, `"2m 30s"`, `"1h 15m"`, `"3d 2h"`
  - `fmtAge(v: string | number): string` → `"2m ago"`, `"3h ago"`
  - `nowIso(): string`
  - `nowEpoch(): number`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/time.test.ts
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

// WAYWISER_HOME isolation: point config reads at a temp dir.
// Import AFTER env is set (state module reads env lazily via waywiserHome()).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ww-time-test-"));
process.env.WAYWISER_HOME = tmp;

const time = jiti("../extensions/utils/time.js") as {
  parseTs: (v: string | number) => number;
  fmtTime: (v: string | number) => string;
  fmtDate: (v: string | number) => string;
  fmtDateTime: (v: string | number) => string;
  fmtStamp: (v: string | number) => string;
  fmtDateOnly: (v: string | number) => string;
  fmtIso: (v: string | number) => string;
  fmtDuration: (ms: number) => string;
  fmtAge: (v: string | number) => string;
  userTz: () => string;
  isValidTz: (tz: string) => boolean;
  nowIso: () => string;
  nowEpoch: () => number;
};

after(() => {
  delete process.env.WAYWISER_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Helper: write a config with a specific timezone. */
function setTz(tz: string): void {
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ timezone: tz }));
}
/** Helper: remove config so userTz falls back to system. */
function clearTz(): void {
  try { fs.unlinkSync(path.join(tmp, "config.json")); } catch { /* ok */ }
}

describe("parseTs", () => {
  it("parses JS ISO format", () => {
    const ms = time.parseTs("2026-08-24T14:23:00.000Z");
    assert.equal(ms, Date.parse("2026-08-24T14:23:00.000Z"));
  });

  it("parses SQLite format as UTC", () => {
    const ms = time.parseTs("2026-08-24 14:23:00");
    assert.equal(ms, Date.parse("2026-08-24T14:23:00Z"));
  });

  it("passes through epoch numbers", () => {
    assert.equal(time.parseTs(1724509380000), 1724509380000);
  });

  it("throws on invalid input", () => {
    assert.throws(() => time.parseTs("not-a-date"), /invalid timestamp/);
  });
});

describe("fmtTime", () => {
  before(() => setTz("UTC"));
  after(() => clearTz());

  it("formats as HH:MM in user TZ", () => {
    assert.equal(time.fmtTime("2026-08-24T14:23:00.000Z"), "14:23");
  });
});

describe("fmtStamp", () => {
  before(() => setTz("UTC"));
  after(() => clearTz());

  it("returns time-only for same-day timestamps", () => {
    const todayIso = new Date().toISOString();
    const result = time.fmtStamp(todayIso);
    assert.match(result, /^\d{2}:\d{2}$/);
  });

  it("includes date for cross-day timestamps", () => {
    const result = time.fmtStamp("2020-01-15T09:30:00.000Z");
    assert.match(result, /Jan 15,? \d{2}:\d{2}/);
  });
});

describe("fmtDuration", () => {
  it("formats seconds", () => {
    assert.equal(time.fmtDuration(5000), "5s");
    assert.equal(time.fmtDuration(45000), "45s");
  });

  it("formats minutes and seconds", () => {
    assert.equal(time.fmtDuration(150_000), "2m 30s");
  });

  it("formats hours and minutes", () => {
    assert.equal(time.fmtDuration(4_500_000), "1h 15m");
  });

  it("formats days and hours", () => {
    assert.equal(time.fmtDuration(97_200_000), "1d 3h");
  });

  it("handles zero", () => {
    assert.equal(time.fmtDuration(0), "0s");
  });
});

describe("fmtDateOnly", () => {
  before(() => setTz("UTC"));
  after(() => clearTz());

  it("returns YYYY-MM-DD", () => {
    assert.equal(time.fmtDateOnly("2026-08-24T14:23:00.000Z"), "2026-08-24");
  });
});

describe("fmtAge", () => {
  it("returns human-readable age", () => {
    const twoMinAgo = Date.now() - 120_000;
    const result = time.fmtAge(twoMinAgo);
    assert.match(result, /2m.*ago/);
  });
});

describe("userTz", () => {
  it("returns configured timezone", () => {
    setTz("Europe/Chisinau");
    assert.equal(time.userTz(), "Europe/Chisinau");
  });

  it("falls back to system timezone when not configured", () => {
    clearTz();
    const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(time.userTz(), sysTz);
  });

  it("falls back to system timezone for invalid IANA string", () => {
    setTz("Not/A/Zone");
    const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(time.userTz(), sysTz);
    clearTz();
  });
});

describe("isValidTz", () => {
  it("accepts valid IANA timezone", () => {
    assert.equal(time.isValidTz("America/New_York"), true);
  });

  it("rejects invalid timezone", () => {
    assert.equal(time.isValidTz("Fake/Zone"), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/time.test.ts`
Expected: FAIL — module `../extensions/utils/time.js` does not resolve (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// extensions/utils/time.ts
/**
 * Shared time module — single source of truth for all timestamp
 * formatting, parsing, and timezone handling across Waywiser.
 *
 * All formatters accept ISO strings (both SQLite "YYYY-MM-DD HH:MM:SS"
 * and JS "YYYY-MM-DDTHH:MM:SS.sssZ") or epoch ms, and output in the
 * user's configured timezone.
 */
import * as path from "node:path";
import { readJSON } from "./state.js";

// ── timezone ──────────────────────────────────────────────────────────

function configFile(): string {
  const home = process.env.WAYWISER_HOME || path.join(process.env.HOME || ".", ".waywiser");
  return path.join(home, "config.json");
}

export function isValidTz(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function userTz(): string {
  try {
    const cfg = readJSON<{ timezone?: string }>(configFile(), {});
    if (cfg.timezone && isValidTz(cfg.timezone)) return cfg.timezone;
  } catch {
    // Config unreadable — fall through to system TZ.
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ── parsing ───────────────────────────────────────────────────────────

/**
 * Parse a timestamp from SQLite format, JS ISO format, or epoch ms.
 * SQLite format ("YYYY-MM-DD HH:MM:SS") is treated as UTC.
 */
export function parseTs(v: string | number): number {
  if (typeof v === "number") return v;
  // SQLite format has a space separator and no trailing Z — treat as UTC
  const normalized = v.includes("T") ? v : v.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp: ${v}`);
  return ms;
}

// ── core formatters ───────────────────────────────────────────────────

/** "14:23" — time only in user timezone. */
export function fmtTime(v: string | number): string {
  const d = new Date(parseTs(v));
  return d.toLocaleTimeString("en-GB", {
    timeZone: userTz(),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "Aug 24" — month + day in user timezone. */
export function fmtDate(v: string | number): string {
  const d = new Date(parseTs(v));
  return d.toLocaleDateString("en-US", {
    timeZone: userTz(),
    month: "short",
    day: "numeric",
  });
}

/** "Aug 24, 14:23" — cross-year adds year: "Aug 24 2025, 14:23". */
export function fmtDateTime(v: string | number): string {
  const d = new Date(parseTs(v));
  const tz = userTz();
  const now = new Date();
  const thisYear = now.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  const thatYear = d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  const datePart = fmtDate(v);
  const timePart = fmtTime(v);
  if (thisYear !== thatYear) return `${datePart} ${thatYear}, ${timePart}`;
  return `${datePart}, ${timePart}`;
}

/**
 * Smart stamp: same day → "14:23", cross-day → "Aug 24, 14:23".
 * Primary formatter for TUI display.
 */
export function fmtStamp(v: string | number): string {
  const d = new Date(parseTs(v));
  const tz = userTz();
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const thatStr = d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  if (todayStr === thatStr) return fmtTime(v);
  return fmtDateTime(v);
}

/** "2026-08-24" — ISO date in user timezone (for persistence, SOUL.md stamps). */
export function fmtDateOnly(v: string | number): string {
  const d = new Date(parseTs(v));
  const tz = userTz();
  const y = d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  const m = d.toLocaleDateString("en-US", { timeZone: tz, month: "2-digit" });
  const day = d.toLocaleDateString("en-US", { timeZone: tz, day: "2-digit" });
  return `${y}-${m}-${day}`;
}

/** Full ISO string (re-emit from parsed input). */
export function fmtIso(v: string | number): string {
  return new Date(parseTs(v)).toISOString();
}

// ── duration / age ────────────────────────────────────────────────────

/**
 * Format a duration in ms as human-readable:
 * 0-59s → "Xs", 1-59m → "Xm Ys", 1-23h → "Xh Ym", 1d+ → "Xd Yh"
 */
export function fmtDuration(ms: number): string {
  const abs = Math.max(0, Math.round(ms / 1000));
  if (abs < 60) return `${abs}s`;
  if (abs < 3600) {
    const m = Math.floor(abs / 60);
    const s = abs % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (abs < 86400) {
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Human-readable age: "2m ago", "3h ago", "3d ago". */
export function fmtAge(v: string | number): string {
  const then = parseTs(v);
  const diff = Date.now() - then;
  return diff >= 0 ? `${fmtDuration(diff)} ago` : `in ${fmtDuration(-diff)}`;
}

// ── convenience ───────────────────────────────────────────────────────

/** Current time as ISO string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Current time as epoch ms. */
export function nowEpoch(): number {
  return Date.now();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/time.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/utils/time.ts test/time.test.ts
git commit -m "feat(time): add shared time module — formatters, timezone, parsing

Replaces all ad-hoc date formatting with a single source of truth.
Handles both SQLite and JS ISO formats, user timezone config,
duration/age formatting. Zero external dependencies (Intl API only)."
```

---

### Task 2: Prompt Budget Priority + Clock Extension

**Files:**
- Modify: `extensions/utils/prompt-budget.ts:44-56` (add `TIME_CONTEXT` priority)
- Create: `extensions/clock.ts`
- Modify: `extensions/index.ts:24-42` (add `"./clock.js"` to modules list)

**Interfaces:**
- Consumes: `fmtTime`, `fmtDuration`, `userTz` from `extensions/utils/time.ts` (Task 1)
- Consumes: `registerInjection`, `PRIORITIES` from `extensions/utils/prompt-budget.ts`
- Consumes: `ExtensionAPI`, `ExtensionContext` from `@earendil-works/pi-coding-agent`
- Produces: Status bar clock at `"waywiser:clock"` key; system prompt injection at `"time-context"` key

- [ ] **Step 1: Add TIME_CONTEXT to PRIORITIES**

In `extensions/utils/prompt-budget.ts`, add the new priority constant:

```typescript
// In the PRIORITIES object (around line 44-56), add after PERMISSIONS:
  PERMISSIONS:     6,  // permission reminders
  TIME_CONTEXT:    7,  // current time + session duration (volatile)
```

- [ ] **Step 2: Create clock.ts**

```typescript
// extensions/clock.ts
/**
 * waywiser clock — status bar clock + system prompt time injection.
 *
 * Provides always-visible time in the TUI footer and injects temporal
 * context into the LLM system prompt so the model can reference time
 * naturally.
 *
 * Uses the latestCtx caching pattern (same as proactive.ts) to update
 * the status bar from a setInterval callback.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fmtTime, fmtDuration, userTz } from "./utils/time.js";
import { registerInjection, PRIORITIES } from "./utils/prompt-budget.js";

export default function clock(pi: ExtensionAPI): void {
  let latestCtx: ExtensionContext | undefined;
  let sessionStartAt: number = Date.now();

  const updateClock = (): void => {
    if (latestCtx) {
      latestCtx.ui.setStatus("waywiser:clock", `🕐 ${fmtTime(Date.now())}`);
    }
  };

  function buildTimeContext(): string {
    const now = new Date();
    const tz = userTz();
    const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
    const datePart = now.toLocaleDateString("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const timePart = fmtTime(Date.now());
    const elapsed = fmtDuration(Date.now() - sessionStartAt);

    return `\n[Time context]\nCurrent: ${dayName}, ${datePart} ${timePart} (${tz})\nSession active: ${elapsed}\n`;
  }

  pi.on("session_start", () => {
    sessionStartAt = Date.now();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    latestCtx = ctx;
    updateClock();

    // Register volatile time injection — refreshed every turn
    registerInjection({
      key: "time-context",
      priority: PRIORITIES.TIME_CONTEXT,
      content: buildTimeContext(),
      cacheable: false,
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    latestCtx = ctx;
    updateClock();
  });

  // 1-minute idle clock — keeps the status bar current between turns
  const clockInterval = setInterval(updateClock, 60_000);
  (clockInterval as unknown as { unref?: () => void }).unref?.();

  pi.on("session_shutdown", () => {
    clearInterval(clockInterval);
  });
}
```

- [ ] **Step 3: Add clock.js to modules list in index.ts**

In `extensions/index.ts`, add `"./clock.js"` to the modules array after `"./commands.js"`:

```typescript
// In the modules array (around line 24-42), add after "./meta-skills.js":
  "./meta-skills.js",
  "./clock.js",
```

The clock is last because it has no dependencies from other modules and shouldn't gate their loading.

- [ ] **Step 4: Run existing tests to ensure nothing breaks**

Run: `npm test`
Expected: All existing tests still pass. (Clock registers event handlers but won't fire during unit tests since there's no active Pi instance.)

- [ ] **Step 5: Commit**

```bash
git add extensions/utils/prompt-budget.ts extensions/clock.ts extensions/index.ts
git commit -m "feat(time): add status bar clock + system prompt time injection

- Clock shows 🕐 HH:MM in footer, updated at turn boundaries + 1min idle
- Injects [Time context] into system prompt (volatile, priority 7)
- LLM now knows current time, day, timezone, and session duration"
```

---

### Task 3: Timestamp Proactive Signals + Notifications

**Files:**
- Modify: `extensions/proactive.ts:458-476` (signal delivery)
- Modify: `extensions/proactive.ts:533-537` (signals preview)
- Modify: `extensions/proactive.ts:542-551` (status display)
- Modify: `extensions/notify.ts:140-167` (notification body)

**Interfaces:**
- Consumes: `fmtTime`, `fmtStamp`, `fmtAge` from `extensions/utils/time.ts` (Task 1)
- Produces: Timestamped proactive signal messages and notification bodies

- [ ] **Step 1: Add time imports to proactive.ts**

At the top of `extensions/proactive.ts` (after line 7), add:

```typescript
import { fmtTime, fmtStamp, fmtAge } from "./utils/time.js";
```

- [ ] **Step 2: Timestamp signal delivery in proactive.ts**

In the `tick()` function delivery loop (around line 458-476):

Change the `sendUserMessage` call (line 468):
```typescript
// Before:
pi.sendUserMessage(`[proactive] ${signal.body}`, { deliverAs: "followUp" });
// After:
pi.sendUserMessage(`[${fmtTime(Date.now())} proactive] ${signal.body}`, { deliverAs: "followUp" });
```

Change the `sendNotification` call (line 463):
```typescript
// Before:
await sendNotification(signal.title, signal.body, undefined, { bypassQuiet: signal.priority === 0 });
// After:
await sendNotification(signal.title, `[${fmtTime(Date.now())}] ${signal.body}`, undefined, { bypassQuiet: signal.priority === 0 });
```

- [ ] **Step 3: Update /proactive status display**

In the status handler (around line 542-551):

```typescript
// Before:
`Last tick: ${lastTickAt ? new Date(lastTickAt).toISOString() : "never"}`,
// After:
`Last tick: ${lastTickAt ? `${fmtStamp(lastTickAt)} (${fmtAge(lastTickAt)})` : "never"}`,
```

- [ ] **Step 4: Add timestamp to webhook notifications**

In `extensions/notify.ts`, the `sendWebhook` function (line 160) already includes a `timestamp` field in its JSON body. Add `fmtTime` import and timestamp the Telegram notification body.

At the top of `extensions/notify.ts` (after the existing imports), add:

```typescript
import { fmtTime } from "./utils/time.js";
```

In `sendTelegram` (around line 142), timestamp the body:
```typescript
// Before:
text: `*${escapeMarkdown(title)}*\n${escapeMarkdown(body)}`,
// After:
text: `*${escapeMarkdown(title)}*\n_${fmtTime(Date.now())}_\n${escapeMarkdown(body)}`,
```

In `sendDesktop` (the desktop notification — around line 104-119), the `body` param is the notification text shown to the user. The caller already prepends `[HH:MM]` to the body in the proactive delivery loop (Step 2), so desktop notifications inherit the timestamp automatically. No change needed here.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add extensions/proactive.ts extensions/notify.ts
git commit -m "feat(time): timestamp proactive signals + notifications

- Proactive signals: [HH:MM proactive] prefix in agent turns
- Notification bodies: [HH:MM] prefix for all channels
- /proactive status: human-readable last tick time + age"
```

---

### Task 4: Timestamp Subagent Reports

**Files:**
- Modify: `extensions/delegate.ts:168-181` (agent_end report injection)
- Modify: `extensions/delegate.ts:273-283` (action=list display)

**Interfaces:**
- Consumes: `fmtTime`, `fmtStamp`, `fmtDuration` from `extensions/utils/time.ts` (Task 1)
- Produces: Timestamped subagent report messages with duration

- [ ] **Step 1: Add time imports to delegate.ts**

At the top of `extensions/delegate.ts` (after line 21), add:

```typescript
import { fmtTime, fmtStamp, fmtDuration } from "./utils/time.js";
```

- [ ] **Step 2: Timestamp the agent_end report injection**

In the `agent_end` handler (around line 176):

```typescript
// Before:
pi.sendUserMessage(`[waywiser-*] ${fresh.length} delegated subagent(s) finished:\n\n${fresh.map(childReport).join("\n\n---\n\n")}`, {
  deliverAs: "followUp",
});
// After:
const reportLines = fresh.map((c) => {
  const elapsed = fmtDuration((c.finishedAt ?? Date.now()) - c.startedAt);
  return `[${fmtStamp(c.finishedAt ?? Date.now())}] ${childReport(c)} (took ${elapsed})`;
});
pi.sendUserMessage(`[${fmtTime(Date.now())} waywiser-*] ${fresh.length} delegated subagent(s) finished:\n\n${reportLines.join("\n\n---\n\n")}`, {
  deliverAs: "followUp",
});
```

- [ ] **Step 3: Update action=list display with time formatting**

In the `list` case (around line 278):

```typescript
// Before:
const age = Math.max(0, Math.round(((c.finishedAt ?? Date.now()) - c.startedAt) / 1000));
...
return `[${c.id}] ${c.status.toUpperCase()} [${c.role}] ${age}s — ${c.goal.slice(0, 100)}${note}`;
// After:
const elapsed = fmtDuration((c.finishedAt ?? Date.now()) - c.startedAt);
...
return `[${c.id}] ${c.status.toUpperCase()} [${c.role}] ${elapsed} — ${c.goal.slice(0, 100)}${note}`;
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/delegate.ts
git commit -m "feat(time): timestamp subagent reports + durations

- agent_end reports: [HH:MM] prefix + (took Xm Ys) suffix per child
- action=list: human-readable duration replaces raw seconds"
```

---

### Task 5: Timestamp Command Output

**Files:**
- Modify: `extensions/commands.ts:20-26` (imports)
- Modify: `extensions/commands.ts:267-283` (/journey display)
- Modify: `extensions/commands.ts:326-349` (/waywiser status)

**Interfaces:**
- Consumes: `fmtStamp`, `fmtAge`, `fmtDateTime` from `extensions/utils/time.ts` (Task 1)
- Produces: Timestamped command outputs for `/journey`, `/waywiser status`

- [ ] **Step 1: Add time imports to commands.ts**

At the top of `extensions/commands.ts` (after line 26), add:

```typescript
import { fmtStamp, fmtDateTime } from "./utils/time.js";
```

- [ ] **Step 2: Update /journey display**

In the `/journey` command handler (around line 281):

```typescript
// Before:
return `[${r.created_at}] ${r.kind}: ${detail}`;
// After:
return `[${fmtStamp(r.created_at)}] ${r.kind}: ${detail}`;
```

- [ ] **Step 3: Update /goals deadline display**

In the `/goal` and `/goals` commands, goal deadlines are shown as raw ISO strings. In the `goalTree` function and `goalLine` rendering, format deadlines:

Find where deadline is displayed (in the `goalTree` / status display code). If the deadline appears as `deadline ${deadline}` (around line 186), change:

```typescript
// Before:
if (deadline) budget.push(`deadline ${deadline}`);
// After:
if (deadline) budget.push(`deadline ${fmtDateTime(deadline)}`);
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass. If any test asserts on journey output format, update the assertion.

- [ ] **Step 5: Commit**

```bash
git add extensions/commands.ts
git commit -m "feat(time): timestamp command outputs

- /journey: user-TZ timestamps instead of raw UTC
- /goal: deadlines formatted as 'Aug 25, 09:00'
- /waywiser status: session context aware"
```

---

### Task 6: Memory Temporal Context

**Files:**
- Modify: `extensions/memrules.ts:156-175` (RecallRow interface + renderRecallBlock)
- Modify: `extensions/memory.ts:504-527` (runRecallText SQL queries + formatting)
- Modify: `extensions/memory.ts:449-458` (selectRecallBlock SQL query)

**Interfaces:**
- Consumes: `fmtAge` from `extensions/utils/time.ts` (Task 1)
- Produces: Memory recall output with age context: `[type|source, 3d ago] content`

- [ ] **Step 1: Add `created_at` to RecallRow**

In `extensions/memrules.ts` (line 156-161):

```typescript
// Before:
export interface RecallRow {
  id: number;
  type: string;
  source: string;
  content: string;
}
// After:
export interface RecallRow {
  id: number;
  type: string;
  source: string;
  content: string;
  created_at?: string;
}
```

- [ ] **Step 2: Add age to renderRecallBlock**

In `extensions/memrules.ts` (line 163-175), add the import and update rendering:

Add at the top of the file:
```typescript
import { fmtAge } from "./utils/time.js";
```

Update `renderRecallBlock`:
```typescript
// Before:
const line = `[${r.type}|${r.source}] ${content}`;
// After:
const agePart = r.created_at ? `, ${fmtAge(r.created_at)}` : "";
const line = `[${r.type}|${r.source}${agePart}] ${content}`;
```

- [ ] **Step 3: Add `created_at` to SQL queries in memory.ts**

In `extensions/memory.ts`, the `runRecallText` function (line 504-527):

For the FTS query (line 510):
```typescript
// Before:
`SELECT m.id, m.type, m.source, m.content, bm25(memories_fts) AS rank
// After:
`SELECT m.id, m.type, m.source, m.content, m.created_at, bm25(memories_fts) AS rank
```

Update the type annotation (line 515):
```typescript
// Before:
as Array<{ id: number; type: string; source: string; content: string }>
// After:
as Array<{ id: number; type: string; source: string; content: string; created_at: string }>
```

For the FTS result formatting (line 518):
```typescript
// Before:
rows.map((r) => `#${r.id} [${r.type}|${r.source}] ${r.content}`)
// After:
rows.map((r) => `#${r.id} [${r.type}|${r.source}, ${fmtAge(r.created_at)}] ${r.content}`)
```

Add the import at the top of `extensions/memory.ts`:
```typescript
import { fmtAge } from "./utils/time.js";
```

For the idle query (line 522):
```typescript
// Before:
`SELECT m.id, m.type, m.source, m.content FROM memories m
// After:
`SELECT m.id, m.type, m.source, m.content, m.created_at FROM memories m
```

Update idle type annotation (line 525):
```typescript
// Before:
as Array<{ id: number; type: string; source: string; content: string }>
// After:
as Array<{ id: number; type: string; source: string; content: string; created_at: string }>
```

Update idle formatting (line 526):
```typescript
// Before:
idle.map((r) => `#${r.id} [${r.type}|${r.source}] ${r.content}`)
// After:
idle.map((r) => `#${r.id} [${r.type}|${r.source}, ${fmtAge(r.created_at)}] ${r.content}`)
```

For `selectRecallBlock` (line 453):
```typescript
// Before:
`SELECT m.id, m.type, m.source, m.content FROM memories_fts JOIN memories m
// After:
`SELECT m.id, m.type, m.source, m.content, m.created_at FROM memories_fts JOIN memories m
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass. Memory tests may need updated assertions for the age suffix.

- [ ] **Step 5: Commit**

```bash
git add extensions/memrules.ts extensions/memory.ts
git commit -m "feat(time): add age context to memory recall

- RecallRow gains created_at field
- Recall output: [type|source, 3d ago] content
- Both FTS and idle queries now SELECT created_at"
```

---

### Task 7: Brain Experience Trace Durations

**Files:**
- Modify: `extensions/brain/trace.ts:130,155,163,191,241` (timestamps)

**Interfaces:**
- Consumes: `nowIso` from `extensions/utils/time.ts` (Task 1)
- Produces: Experience traces using shared `nowIso()` instead of inline `new Date().toISOString()`

- [ ] **Step 1: Add time import to brain/trace.ts**

At the top of `extensions/brain/trace.ts`, add:

```typescript
import { nowIso } from "../utils/time.js";
```

- [ ] **Step 2: Replace inline `new Date().toISOString()` calls**

Line 130 (`runStartedAt` init):
```typescript
// Before:
private runStartedAt: string = new Date().toISOString();
// After:
private runStartedAt: string = nowIso();
```

Line 155 (`beginRun`):
```typescript
// Before:
this.runStartedAt = new Date().toISOString();
// After:
this.runStartedAt = nowIso();
```

Line 163 (`toolCall` timestamp):
```typescript
// Before:
timestamp: new Date().toISOString(),
// After:
timestamp: nowIso(),
```

Line 191 (`toolResult` observation timestamp):
```typescript
// Before:
timestamp: new Date().toISOString(),
// After:
timestamp: nowIso(),
```

Line 241 (`finalize` settledAt):
```typescript
// Before:
settledAt: new Date().toISOString(),
// After:
settledAt: nowIso(),
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass. This is a pure alias replacement — no behavior change.

- [ ] **Step 4: Commit**

```bash
git add extensions/brain/trace.ts
git commit -m "refactor(time): brain traces use shared nowIso()

Replace 5 inline new Date().toISOString() calls with the shared
time module's nowIso() for consistency."
```

---

### Task 8: Kanban Temporal Display

**Files:**
- Modify: `extensions/kanban/ops.ts:53-71` (cardLine + fmtShortDate replacement)
- Modify: `extensions/kanban/ops.ts:111` (done card date in markdown)
- Modify: `extensions/kanban-html.ts:65-69` (fmtDate replacement)
- Modify: `extensions/kanban-html.ts:444` (snapshot timestamp)

**Interfaces:**
- Consumes: `fmtStamp`, `fmtDateTime`, `fmtDuration`, `fmtDateOnly` from `extensions/utils/time.ts` (Task 1)
- Produces: Time-enriched kanban card display

- [ ] **Step 1: Update cardLine() in ops.ts**

Add import at the top of `extensions/kanban/ops.ts`:
```typescript
import { fmtStamp, fmtDateTime, fmtDuration } from "../utils/time.js";
```

Replace `fmtShortDate()` (lines 67-71) — delete the function entirely, it's replaced by imports.

Update `cardLine()` (lines 53-64) to use shared formatters and add time-in-status:

```typescript
export function cardLine(c: CardRow): string {
  const pri = c.priority && c.priority !== "med" ? ` [${c.priority}]` : "";
  const typeTag = c.type === "idea" ? " 💡" : c.type === "bug" ? " 🐛" : "";
  const age = c.status !== "done" && c.status !== "todo" ? ` ${fmtDuration(Date.now() - new Date(c.updated_at).getTime())}` : "";
  const due = c.due
    ? c.status === "done"
      ? ` (was due ${fmtDateTime(c.due)})`
      : isOverdue(c)
        ? ` (OVERDUE since ${fmtDateTime(c.due)})`
        : ` (due ${fmtDateTime(c.due)})`
    : "";
  return `${c.id}${pri} [${c.status}${age}]${typeTag} ${c.title}${c.assignee ? ` → ${c.assignee}` : ""}${c.block_reason ? ` (block: ${c.block_reason})` : ""}${due}`;
}
```

- [ ] **Step 2: Update mdCardLine() to use shared formatter**

In the `mdCardLine()` function (around line 75), replace `fmtShortDate(c.due)`:

```typescript
// Before:
const due = c.due ? ` \`due:${fmtShortDate(c.due)}\`` : "";
// After:
const due = c.due ? ` \`due:${fmtStamp(c.due)}\`` : "";
```

In the done section (around line 111), replace `fmtShortDate(c.updated_at)`:
```typescript
// Before:
`- [x] ~~${c.id} ${c.title}~~ · ${fmtShortDate(c.updated_at)}`
// After:
`- [x] ~~${c.id} ${c.title}~~ · ${fmtStamp(c.updated_at)}`
```

- [ ] **Step 3: Update kanban-html.ts**

Add import at the top of `extensions/kanban-html.ts`:
```typescript
import { fmtDateOnly, fmtDateTime } from "./utils/time.js";
```

Delete the local `fmtDate()` function (lines 65-69).

In the HTML template where `fmtDate` was used (server-side rendered HTML for card details), replace any remaining call to the deleted `fmtDate` with `fmtDateOnly`.

Update the snapshot timestamp (line 444):
```typescript
// Before:
<span>Snapshot generated: ${new Date().toISOString().replace("T", " ").slice(0, 19)}</span>
// After:
<span>Snapshot generated: ${fmtDateTime(Date.now())}</span>
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass. Kanban tests asserting on card line format may need updates.

- [ ] **Step 5: Commit**

```bash
git add extensions/kanban/ops.ts extensions/kanban-html.ts
git commit -m "feat(time): kanban temporal display

- cardLine: time-in-status for doing/review/blocked cards
- Due dates: formatted via shared fmtDateTime
- Markdown export: uses shared fmtStamp
- Delete local fmtShortDate/fmtDate — replaced by shared module
- Static snapshot: human-readable timestamp"
```

---

### Task 9: Soul Datestamp + Remaining Replacements

**Files:**
- Modify: `extensions/soul.ts:137` (date stamp)
- Modify: `extensions/utils/state.ts:251` (rememberRow valid_at)

**Interfaces:**
- Consumes: `fmtDateOnly`, `nowIso` from `extensions/utils/time.ts` (Task 1)
- Produces: Consistent timestamp usage in soul and state modules

- [ ] **Step 1: Update soul.ts datestamp**

Add import at the top of `extensions/soul.ts`:
```typescript
import { fmtDateOnly } from "./utils/time.js";
```

Update the datestamp (line 137):
```typescript
// Before:
const stamp = new Date().toISOString().slice(0, 10);
// After:
const stamp = fmtDateOnly(Date.now());
```

- [ ] **Step 2: Update state.ts rememberRow**

Add import at the top of `extensions/utils/state.ts`:
```typescript
import { nowIso } from "./time.js";
```

Find the `rememberRow()` function (around line 251) and replace the inline ISO call:
```typescript
// Before:
valid_at: new Date().toISOString(),
// After:
valid_at: nowIso(),
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add extensions/soul.ts extensions/utils/state.ts
git commit -m "refactor(time): soul + state use shared time module

- SOUL.md lessons: fmtDateOnly replaces inline ISO slice
- rememberRow: nowIso replaces inline new Date().toISOString()"
```

---

### Task 10: Final Verification + Integration Test

**Files:**
- Verify: All modified files compile and pass tests
- Verify: `bin/waywiser` starts without errors

**Interfaces:**
- Consumes: All changes from Tasks 1-9

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass with zero failures.

- [ ] **Step 2: TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Verify no remaining ad-hoc formatters**

Run:
```bash
grep -rn 'new Date()\.toISOString()\.slice\|\.toLocaleTimeString()\|\.toLocaleDateString(' extensions/ --include='*.ts' | grep -v 'node_modules\|kanban-html.ts.*toLocaleTimeString\|time\.ts'
```
Expected: Zero hits (all ad-hoc formatters replaced except the browser-side JS in kanban-html.ts).

- [ ] **Step 4: Verify clock module loads**

```bash
grep -n 'clock' extensions/index.ts
```
Expected: `"./clock.js"` appears in the modules array.

- [ ] **Step 5: Commit integration verification**

No code changes — this is a verification-only task. If any issues found in steps 1-4, fix them first and commit the fixes.

```bash
git log --oneline -10
```

Verify the commit chain: time module → clock → proactive → delegate → commands → memory → brain → kanban → soul → (this verification).
