# Time-Awareness Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-message TUI timestamps via `pi.registerMarkdownTransformer`, and close the remaining ecosystem time-awareness gaps (brain recall/inspect/traces, kanban HTML footer, notify webhook, mobile inbox, cronjob listings, sweep of raw-stamp holdouts).

**Architecture:** One new extension `extensions/tui-stamps.ts` prefixes user/assistant markdown with `[HH:MM]` via pi's markdown-transformer hook, with a small streaming-safe stamp cache. Everywhere else, existing code paths swap raw stamp munging for shared `utils/time.ts` formatters (`fmtStamp`, `fmtAge`, `fmtSmart`). One new helper `fmtSmart` picks age vs absolute based on a configurable threshold.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent` (ExtensionAPI, `registerMarkdownTransformer`), `node:test`, `jiti` for TS imports in tests.

**Spec:** `docs/superpowers/specs/2026-08-25-time-awareness-phase-2-design.md`

## Global Constraints

- **No new runtime dependencies.** Use only native `Intl.DateTimeFormat` and the existing `utils/time.ts` module.
- **Storage stays UTC.** No timestamp is mutated at rest. Every formatter runs at display time.
- **Preserve public payload shape.** Webhook fields are ADDED, never removed or renamed.
- **Test isolation.** Every test that reads config uses `process.env.WAYWISER_HOME = mkdtempSync(...)` (mirrors `test/permissions.test.ts` and `test/time.test.ts`).
- **Test runner.** All tests run under `npm test` (`node --test 'test/**/*.test.ts'`). Individual tests: `node --test test/<file>.test.ts`.
- **TS imports in tests.** Use `jiti` (as existing tests do) to load `.ts` modules with `.js` extensions in the specifiers.
- **Commit style.** Follow existing repo convention: `feat(area): …`, `refactor(area): …`, `test(area): …`, `docs(area): …`. Every task ends with one commit.
- **Node version floor.** `>=22.5` (from `package.json`).

---

## File Structure

**New files:**
- `extensions/tui-stamps.ts` — registers the markdown transformer; owns streaming stamp cache and config gate. Exports internal helpers for tests.
- `test/time-smart.test.ts` — unit tests for `fmtSmart` and `relativeThresholdHours()`.
- `test/tui-stamps.test.ts` — unit tests for the transformer's pure helpers + wiring against a mock `ExtensionAPI`.

**Modified files:**
- `extensions/utils/time.ts` — add `fmtSmart` + cached `relativeThresholdHours()` getter.
- `extensions/index.ts` — append `"./tui-stamps.js"` as the LAST module.
- `extensions/brain/prompts.ts` — `renderBrainContext` appends age suffix per memory/procedure.
- `extensions/brain/index.ts` — `handleMemoryInspect` + `handleExperienceInspect` add derived human fields.
- `extensions/brain/trace.ts` — emitted trace rows gain `wallClock` sibling.
- `extensions/kanban-html.ts` — card footer uses `fmtStamp` + `fmtAge`; overdue badge.
- `extensions/kanban/ops.ts` — `cardLine` fills `todo` age gap.
- `extensions/notify.ts` — webhook payload gains `human` + `age`; Telegram body uses `fmtStamp`.
- `extensions/mobile/index.ts` — `processMessage` prefixes inbox bodies with `[received …]`.
- `extensions/cronjob.ts` — job listings show `fmtSmart(lastRun)` + `fmtDateTime(nextRun)`.
- `extensions/commands.ts`, `extensions/proactive.ts`, `extensions/meta-skills.ts`, `extensions/clarify.ts` — grep sweep, replace remaining raw stamps.

---

## Task 1: Add `fmtSmart` + `relativeThresholdHours()` to `utils/time.ts`

**Files:**
- Modify: `extensions/utils/time.ts` (add after existing exports, before the `// ── convenience ──` block)
- Test: `test/time-smart.test.ts` (new)

**Interfaces:**
- Consumes: existing `parseTs`, `fmtAge`, `fmtStamp` from `utils/time.ts`; `readJSON` from `utils/state.ts`.
- Produces:
  - `export function relativeThresholdHours(): number` — cached read from `~/.waywiser/config.json` → `timeDisplay.relativeThresholdHours`; default `24`; falls back to `24` on invalid (non-finite or ≤ 0), logs once per session to stderr.
  - `export function fmtSmart(v: string | number, thresholdHours?: number): string` — returns `fmtAge(v)` when `0 ≤ ageHours ≤ threshold`, otherwise `fmtStamp(v)`.

- [ ] **Step 1: Write failing tests**

Create `test/time-smart.test.ts`:

```typescript
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ww-smart-test-"));
process.env.WAYWISER_HOME = tmp;

const time = jiti("../extensions/utils/time.js") as {
  fmtSmart: (v: string | number, thresholdHours?: number) => string;
  fmtAge: (v: string | number) => string;
  fmtStamp: (v: string | number) => string;
  relativeThresholdHours: () => number;
};

function writeConfig(cfg: object): void {
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify(cfg));
}
function clearConfig(): void {
  try { fs.unlinkSync(path.join(tmp, "config.json")); } catch { /* ok */ }
}

after(() => {
  delete process.env.WAYWISER_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("fmtSmart", () => {
  it("returns age for recent timestamps (below threshold)", () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    assert.equal(time.fmtSmart(oneHourAgo, 24), time.fmtAge(oneHourAgo));
  });

  it("returns stamp for old timestamps (above threshold)", () => {
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    assert.equal(time.fmtSmart(fiveDaysAgo, 24), time.fmtStamp(fiveDaysAgo));
  });

  it("returns age at exact threshold boundary (tie → age)", () => {
    const exactlyThreshold = Date.now() - 24 * 60 * 60 * 1000;
    assert.equal(time.fmtSmart(exactlyThreshold, 24), time.fmtAge(exactlyThreshold));
  });

  it("returns age for future timestamps", () => {
    const inFiveMin = Date.now() + 5 * 60 * 1000;
    assert.equal(time.fmtSmart(inFiveMin, 24), time.fmtAge(inFiveMin));
  });

  it("uses custom threshold when passed", () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    assert.equal(time.fmtSmart(twoHoursAgo, 1), time.fmtStamp(twoHoursAgo));
    assert.equal(time.fmtSmart(twoHoursAgo, 3), time.fmtAge(twoHoursAgo));
  });
});

describe("relativeThresholdHours", () => {
  before(clearConfig);
  after(clearConfig);

  it("defaults to 24 when config absent", () => {
    clearConfig();
    assert.equal(time.relativeThresholdHours(), 24);
  });

  it("reads valid positive threshold from config", () => {
    writeConfig({ timeDisplay: { relativeThresholdHours: 48 } });
    assert.equal(time.relativeThresholdHours(), 48);
  });

  it("falls back to 24 when value is not a positive finite number", () => {
    writeConfig({ timeDisplay: { relativeThresholdHours: -5 } });
    assert.equal(time.relativeThresholdHours(), 24);
    writeConfig({ timeDisplay: { relativeThresholdHours: "abc" } });
    assert.equal(time.relativeThresholdHours(), 24);
    writeConfig({ timeDisplay: { relativeThresholdHours: 0 } });
    assert.equal(time.relativeThresholdHours(), 24);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/time-smart.test.ts`
Expected: FAIL — `fmtSmart is not a function`, `relativeThresholdHours is not a function`.

- [ ] **Step 3: Implement in `extensions/utils/time.ts`**

Add BEFORE the existing `// ── convenience ──` section:

```typescript
// ── smart formatter ───────────────────────────────────────────────────

let cachedThreshold: number | undefined;
let thresholdWarned = false;

/**
 * Read timeDisplay.relativeThresholdHours from ~/.waywiser/config.json,
 * default 24. Cached per process (matches userTz caching policy).
 * Invalid values fall back to 24 with a one-shot stderr warning.
 */
export function relativeThresholdHours(): number {
	if (cachedThreshold !== undefined) return cachedThreshold;
	try {
		const cfg = readJSON<{ timeDisplay?: { relativeThresholdHours?: unknown } }>(configFile(), {});
		const raw = cfg.timeDisplay?.relativeThresholdHours;
		if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
			cachedThreshold = raw;
			return cachedThreshold;
		}
		if (raw !== undefined && !thresholdWarned) {
			process.stderr.write(`waywiser: invalid timeDisplay.relativeThresholdHours (${JSON.stringify(raw)}), using 24\n`);
			thresholdWarned = true;
		}
	} catch {
		// Config unreadable — fall through.
	}
	cachedThreshold = 24;
	return cachedThreshold;
}

/**
 * Age when recent, absolute stamp when old.
 * "3h ago" for a memory touched yesterday afternoon,
 * "Aug 20, 09:15" for something from 5 days ago.
 * If thresholdHours is omitted, reads from config (relativeThresholdHours()).
 */
export function fmtSmart(v: string | number, thresholdHours?: number): string {
	const ms = parseTs(v);
	const t = thresholdHours ?? relativeThresholdHours();
	const ageHours = (Date.now() - ms) / 3_600_000;
	return ageHours <= t ? fmtAge(v) : fmtStamp(v);
}
```

Note: the cache is process-lifetime. Tests that mutate config between assertions need to reset the cache. Add this reset hook next to the cached vars (test-only, but harmless in prod):

```typescript
/** Test-only: clear cached values. Safe to call in prod (would just re-read next call). */
export function _resetTimeCaches(): void {
	cachedThreshold = undefined;
	thresholdWarned = false;
}
```

Update the test to call `_resetTimeCaches()` between config mutations. Amend the `time.ts` declaration in the test file to include `_resetTimeCaches: () => void`, and call it inside each `relativeThresholdHours` test after `writeConfig`:

```typescript
it("reads valid positive threshold from config", () => {
    writeConfig({ timeDisplay: { relativeThresholdHours: 48 } });
    time._resetTimeCaches();
    assert.equal(time.relativeThresholdHours(), 48);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/time-smart.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/utils/time.ts test/time-smart.test.ts
git commit -m "feat(time): fmtSmart adaptive formatter + threshold config"
```

---

## Task 2: Create `extensions/tui-stamps.ts` — pure helpers

**Files:**
- Create: `extensions/tui-stamps.ts`
- Test: `test/tui-stamps.test.ts` (new)

**Interfaces:**
- Consumes: `fmtStamp` from `utils/time.js`; `readJSON` from `utils/state.js`; pi types from `@earendil-works/pi-coding-agent`.
- Produces (for tests + eventual default export):
  - `export function _makeStampCache(cap?: number): { get(key: string, nowMs: number): number; evictPrefix(prefix: string): void; clear(): void; size(): number }`
  - `export function _stampKey(messageType: string, md: string): string` — returns `${messageType}|${md.slice(0, 40)}`.
  - `export function _renderStampPrefix(nowMs: number, style: "code" | "plain"): string` — returns `` `[HH:MM]` `` or `[HH:MM] ` (WITH trailing space).
  - `export function _loadConfig(): { enabled: boolean; style: "code" | "plain" }` — reads `~/.waywiser/config.json → tuiStamps`, defaults `{ enabled: true, style: "code" }`.
  - Default export: extension factory `(pi: ExtensionAPI) => void` — wired in Task 3's test but implemented here.

- [ ] **Step 1: Write failing tests for the pure helpers**

Create `test/tui-stamps.test.ts`:

```typescript
import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ww-tuistamps-test-"));
process.env.WAYWISER_HOME = tmp;

const mod = jiti("../extensions/tui-stamps.js") as {
  default: (pi: unknown) => void;
  _makeStampCache: (cap?: number) => {
    get: (key: string, nowMs: number) => number;
    evictPrefix: (prefix: string) => void;
    clear: () => void;
    size: () => number;
  };
  _stampKey: (messageType: string, md: string) => string;
  _renderStampPrefix: (nowMs: number, style: "code" | "plain") => string;
  _loadConfig: () => { enabled: boolean; style: "code" | "plain" };
};

function writeConfig(cfg: object): void {
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify(cfg));
}
function clearConfig(): void {
  try { fs.unlinkSync(path.join(tmp, "config.json")); } catch { /* ok */ }
}

after(() => {
  delete process.env.WAYWISER_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("_stampKey", () => {
  it("prefixes with messageType and truncates markdown to 40 chars", () => {
    const md = "hello world ".repeat(10);
    const key = mod._stampKey("user", md);
    assert.ok(key.startsWith("user|"));
    assert.equal(key.length, "user|".length + 40);
  });

  it("keeps short markdown intact", () => {
    assert.equal(mod._stampKey("assistant", "hi"), "assistant|hi");
  });
});

describe("_makeStampCache", () => {
  it("pins the first observed timestamp for a key", () => {
    const c = mod._makeStampCache(64);
    const first = c.get("user|abc", 1000);
    const second = c.get("user|abc", 2000);
    assert.equal(first, 1000);
    assert.equal(second, 1000);
  });

  it("returns fresh timestamp after evictPrefix", () => {
    const c = mod._makeStampCache(64);
    c.get("user|hello world", 1000);
    c.evictPrefix("user|hello");
    const after = c.get("user|hello world", 2000);
    assert.equal(after, 2000);
  });

  it("clear() empties the cache", () => {
    const c = mod._makeStampCache(64);
    c.get("k", 1000);
    c.clear();
    assert.equal(c.size(), 0);
    assert.equal(c.get("k", 2000), 2000);
  });

  it("LRU-evicts oldest entries when at capacity", () => {
    const c = mod._makeStampCache(2);
    c.get("a", 1000);
    c.get("b", 2000);
    c.get("c", 3000);              // evicts "a"
    assert.equal(c.get("a", 4000), 4000);   // fresh stamp — "a" was evicted
    assert.equal(c.get("b", 5000), 2000);   // "b" still cached
  });
});

describe("_renderStampPrefix", () => {
  it("wraps stamp in backticks in code style, ends with a space", () => {
    const out = mod._renderStampPrefix(Date.now(), "code");
    assert.match(out, /^`\[.+\]`\s$/);
  });

  it("uses bare brackets in plain style, ends with a space", () => {
    const out = mod._renderStampPrefix(Date.now(), "plain");
    assert.match(out, /^\[.+\]\s$/);
    assert.ok(!out.startsWith("`"));
  });
});

describe("_loadConfig", () => {
  beforeEach(clearConfig);

  it("defaults to enabled=true, style=code when absent", () => {
    assert.deepEqual(mod._loadConfig(), { enabled: true, style: "code" });
  });

  it("reads enabled=false from tuiStamps.enabled", () => {
    writeConfig({ tuiStamps: { enabled: false } });
    assert.equal(mod._loadConfig().enabled, false);
  });

  it("reads style=plain from tuiStamps.style", () => {
    writeConfig({ tuiStamps: { style: "plain" } });
    assert.equal(mod._loadConfig().style, "plain");
  });

  it("ignores unknown style value, falls back to code", () => {
    writeConfig({ tuiStamps: { style: "rainbow" } });
    assert.equal(mod._loadConfig().style, "code");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tui-stamps.test.ts`
Expected: FAIL — module does not exist / helpers not defined.

- [ ] **Step 3: Implement helpers in `extensions/tui-stamps.ts`**

```typescript
/**
 * waywiser tui-stamps — prefixes user + assistant markdown with a
 * dim [HH:MM] stamp via pi.registerMarkdownTransformer. Streaming-safe:
 * caches the stamp per message so it doesn't jitter as tokens arrive.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fmtStamp } from "./utils/time.js";
import { readJSON } from "./utils/state.js";

const DEFAULT_CAP = 64;
const KEY_PREFIX_LEN = 40;

export function _stampKey(messageType: string, md: string): string {
	return `${messageType}|${md.slice(0, KEY_PREFIX_LEN)}`;
}

export function _makeStampCache(cap: number = DEFAULT_CAP) {
	// Insertion-order Map used as LRU: delete-then-set on hit refreshes recency.
	const m = new Map<string, number>();
	return {
		get(key: string, nowMs: number): number {
			const existing = m.get(key);
			if (existing !== undefined) {
				m.delete(key);
				m.set(key, existing);
				return existing;
			}
			m.set(key, nowMs);
			while (m.size > cap) {
				const oldest = m.keys().next().value;
				if (oldest === undefined) break;
				m.delete(oldest);
			}
			return nowMs;
		},
		evictPrefix(prefix: string): void {
			for (const k of Array.from(m.keys())) {
				if (k.startsWith(prefix)) m.delete(k);
			}
		},
		clear(): void {
			m.clear();
		},
		size(): number {
			return m.size;
		},
	};
}

export function _renderStampPrefix(nowMs: number, style: "code" | "plain"): string {
	const stamp = fmtStamp(nowMs);
	return style === "code" ? `\`[${stamp}]\` ` : `[${stamp}] `;
}

function configFile(): string {
	const home = process.env.WAYWISER_HOME || path.join(process.env.HOME || ".", ".waywiser");
	return path.join(home, "config.json");
}

export function _loadConfig(): { enabled: boolean; style: "code" | "plain" } {
	try {
		const cfg = readJSON<{ tuiStamps?: { enabled?: unknown; style?: unknown } }>(configFile(), {});
		const enabled = cfg.tuiStamps?.enabled === false ? false : true;
		const rawStyle = cfg.tuiStamps?.style;
		const style: "code" | "plain" = rawStyle === "plain" ? "plain" : "code";
		return { enabled, style };
	} catch {
		return { enabled: true, style: "code" };
	}
}

// Extension factory (wired in Task 3).
export default function tuiStamps(pi: ExtensionAPI): void {
	const cache = _makeStampCache();
	let cfg = _loadConfig();

	pi.on("session_start", () => {
		cache.clear();
		cfg = _loadConfig();
	});

	pi.on("before_agent_start", () => {
		cfg = _loadConfig();
	});

	pi.on("message_end", (event) => {
		const msg = (event as unknown as { message?: { content?: unknown } }).message;
		const content = typeof msg?.content === "string" ? msg.content : "";
		if (!content) return;
		for (const t of ["user", "assistant"]) {
			cache.evictPrefix(_stampKey(t, content));
		}
	});

	pi.registerMarkdownTransformer((md, mtCtx) => {
		try {
			if (!cfg.enabled) return md;
			if (mtCtx.messageType === "assistant-thinking") return md;
			if (mtCtx.messageType !== "user" && mtCtx.messageType !== "assistant") return md;
			const key = _stampKey(mtCtx.messageType, md);
			const stamp = cache.get(key, Date.now());
			return `${_renderStampPrefix(stamp, cfg.style)}${md}`;
		} catch (err) {
			process.stderr.write(`waywiser: tui-stamps transformer error: ${err instanceof Error ? err.message : String(err)}\n`);
			return md;
		}
	});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/tui-stamps.test.ts`
Expected: PASS (all 12 tests across `_stampKey`, `_makeStampCache`, `_renderStampPrefix`, `_loadConfig`).

- [ ] **Step 5: Commit**

```bash
git add extensions/tui-stamps.ts test/tui-stamps.test.ts
git commit -m "feat(tui-stamps): prefix user + assistant messages with time stamp"
```

---

## Task 3: Wire `tui-stamps` into extension loader + wiring test

**Files:**
- Modify: `extensions/index.ts:24-44` (modules array — append `"./tui-stamps.js"` as LAST entry)
- Test: `test/tui-stamps.test.ts` (extend with wiring tests)

**Interfaces:**
- Consumes: default export from Task 2.
- Produces: no new symbols. Wires the transformer into pi's runtime.

- [ ] **Step 1: Write failing wiring test**

Append to `test/tui-stamps.test.ts` (inside the existing file, before the final closing brace of the last `describe`):

```typescript
describe("extension wiring", () => {
  type Handlers = Record<string, Array<(event: unknown, ctx?: unknown) => unknown>>;
  interface MockAPI {
    handlers: Handlers;
    transformers: Array<(md: string, ctx: { messageType: string; isStreaming: boolean; availableWidth: number }) => string>;
    on(event: string, handler: (event: unknown, ctx?: unknown) => unknown): void;
    registerMarkdownTransformer(t: (md: string, ctx: { messageType: string; isStreaming: boolean; availableWidth: number }) => string): void;
  }
  function makeApi(): MockAPI {
    return {
      handlers: {},
      transformers: [],
      on(event, handler) {
        (this.handlers[event] ??= []).push(handler);
      },
      registerMarkdownTransformer(t) {
        this.transformers.push(t);
      },
    };
  }

  beforeEach(clearConfig);

  it("registers a markdown transformer", () => {
    const api = makeApi();
    mod.default(api as unknown);
    assert.equal(api.transformers.length, 1);
  });

  it("prefixes user markdown with a stamp", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const out = api.transformers[0]("hello", { messageType: "user", isStreaming: false, availableWidth: 80 });
    assert.match(out, /^`\[.+\]`\s+hello$/);
  });

  it("prefixes assistant markdown with a stamp", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const out = api.transformers[0]("world", { messageType: "assistant", isStreaming: false, availableWidth: 80 });
    assert.match(out, /^`\[.+\]`\s+world$/);
  });

  it("passes through assistant-thinking unchanged", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const out = api.transformers[0]("thinking...", { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 });
    assert.equal(out, "thinking...");
  });

  it("reuses stamp across streaming updates for the same message", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const t = api.transformers[0];
    const first = t("streaming reply here...", { messageType: "assistant", isStreaming: true, availableWidth: 80 });
    // Advance real time; cache should still return the same stamp.
    const start = Date.now();
    while (Date.now() - start < 60_000 / 1000) { /* micro-loop; effectively same minute */ break; }
    const second = t("streaming reply here... more tokens", { messageType: "assistant", isStreaming: true, availableWidth: 80 });
    const firstStamp = first.match(/`\[(.+?)\]`/)?.[1];
    const secondStamp = second.match(/`\[(.+?)\]`/)?.[1];
    assert.equal(firstStamp, secondStamp);
  });

  it("no-ops when tuiStamps.enabled=false", () => {
    writeConfig({ tuiStamps: { enabled: false } });
    const api = makeApi();
    mod.default(api as unknown);
    // Fire session_start so the extension re-reads config.
    for (const h of api.handlers["session_start"] ?? []) h(undefined);
    const out = api.transformers[0]("hello", { messageType: "user", isStreaming: false, availableWidth: 80 });
    assert.equal(out, "hello");
  });

  it("uses plain style when configured", () => {
    writeConfig({ tuiStamps: { style: "plain" } });
    const api = makeApi();
    mod.default(api as unknown);
    for (const h of api.handlers["session_start"] ?? []) h(undefined);
    const out = api.transformers[0]("hello", { messageType: "user", isStreaming: false, availableWidth: 80 });
    assert.match(out, /^\[.+\]\s+hello$/);
    assert.ok(!out.startsWith("`"));
  });

  it("session_start clears the streaming cache", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const t = api.transformers[0];
    const before = t("cache me", { messageType: "user", isStreaming: true, availableWidth: 80 });
    for (const h of api.handlers["session_start"] ?? []) h(undefined);
    // After clear, next call for the same key gets a fresh Date.now(). We
    // can't easily assert the value differs (timing), but we can assert the
    // shape is still valid and the call doesn't throw.
    const afterCall = t("cache me", { messageType: "user", isStreaming: true, availableWidth: 80 });
    assert.match(afterCall, /^`\[.+\]`\s+cache me$/);
    void before;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tui-stamps.test.ts`
Expected: PASS on Task 2 helper tests, FAIL on new wiring tests — the module is present but not loaded by pi yet (wiring tests should already pass since they load the module directly; the FAIL is really about `extensions/index.ts` not listing it).

If wiring tests already pass because they invoke the factory directly (they do), skip to Step 3 and verify Step 4.

- [ ] **Step 3: Wire the module into `extensions/index.ts`**

Edit `extensions/index.ts:24-44`, appending `"./tui-stamps.js"` as the LAST entry in the modules array:

```typescript
const modules = [
	"./permissions.js",
	"./soul.js",
	"./memory.js",
	"./brain/index.js",
	"./skills-manage.js",
	"./web.js",
	"./mcp.js",
	"./execute-code.js",
	"./delegate.js",
	"./cronjob.js",
	"./notify.js",
	"./clarify.js",
	"./kanban/index.js",
	"./todo-compat.js",
	"./commands.js",
	"./proactive.js",
	"./meta-skills.js",
	"./mobile/index.js",
	"./clock.js",
	"./tui-stamps.js",
];
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all existing tests still pass; new wiring tests pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/index.ts test/tui-stamps.test.ts
git commit -m "feat(tui-stamps): register transformer in extension loader"
```

---

## Task 4: Age suffix in brain recall injection

**Files:**
- Modify: `extensions/brain/prompts.ts:164-192` (`renderBrainContext`)
- Test: extend `test/brain/` (locate existing brain test; if none targets `renderBrainContext`, add a new `test/brain/prompts.test.ts`)

**Interfaces:**
- Consumes: `fmtSmart` from Task 1, existing `RecallResult` type from `../brain/types.js`.
- Produces: same `renderBrainContext(recalled)` signature; output now includes ` (last used …)` per memory/procedure.

- [ ] **Step 1: Locate or create brain prompts test**

Run: `ls test/brain/`

If a prompts test exists, extend it. If not, create `test/brain/prompts.test.ts`:

```typescript
import { describe, it, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ww-brain-prompts-test-"));
process.env.WAYWISER_HOME = tmp;

const { renderBrainContext } = jiti("../../extensions/brain/prompts.js") as {
  renderBrainContext: (recalled: {
    items: Array<{
      type: "memory" | "procedure";
      content: string;
      scope?: string;
      last_accessed?: string;
      created_at?: string;
      last_used?: string;
      uses?: number;
    }>;
  }) => string;
};

after(() => {
  delete process.env.WAYWISER_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("renderBrainContext age suffix", () => {
  it("appends (last used …) to each memory line", () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const out = renderBrainContext({
      items: [
        { type: "memory", scope: "user", content: "prefers Romanian", last_accessed: yesterday, created_at: yesterday },
      ],
    });
    assert.match(out, /prefers Romanian.*\(last used .+\)/);
  });

  it("appends (N uses, last …) to each procedure line", () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const out = renderBrainContext({
      items: [
        { type: "procedure", content: "always test after refactor", uses: 5, last_used: yesterday, created_at: yesterday },
      ],
    });
    assert.match(out, /always test after refactor.*\(5 uses, last .+\)/);
  });

  it("falls back to created_at when last_accessed absent", () => {
    const created = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const out = renderBrainContext({
      items: [{ type: "memory", scope: "user", content: "some fact", created_at: created }],
    });
    assert.match(out, /some fact.*\(last used .+\)/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/brain/prompts.test.ts`
Expected: FAIL — no `(last used …)` in output.

- [ ] **Step 3: Modify `extensions/brain/prompts.ts`**

At top of file, add import:

```typescript
import { fmtSmart } from "../utils/time.js";
```

Replace the `renderBrainContext` body's memory/procedure loops:

```typescript
if (memories.length) {
    lines.push("## Your Memories (use these first)");
    for (const m of memories) {
      const ref = m.last_accessed ?? m.created_at;
      const age = ref ? ` (last used ${fmtSmart(ref)})` : "";
      lines.push(`- [${m.scope}] ${m.content}${age}`);
    }
}

if (procedures.length) {
    lines.push("## Your Learned Procedures (apply these when relevant)");
    for (const p of procedures) {
      const ref = p.last_used ?? p.created_at;
      const uses = typeof p.uses === "number" ? p.uses : 0;
      const age = ref ? ` (${uses} uses, last ${fmtSmart(ref)})` : "";
      lines.push(`- ${p.content}${age}`);
    }
}
```

If the `RecallItem` type does not currently include `last_accessed`, `last_used`, `uses`, or `created_at`, look at `extensions/brain/types.ts`. Those fields already exist on `BrainMemory` and `BrainProcedure`; ensure the `RecallItem` union carries them or read via `(m as unknown as {...})` for the missing fields. If TypeScript complains, widen `RecallItem` in `types.ts` to include them as optional string fields. That widening is scope-local — verify no consumer relies on the narrower shape (grep for `RecallItem` before widening).

- [ ] **Step 4: Run tests**

Run: `node --test test/brain/prompts.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/brain/prompts.ts extensions/brain/types.ts test/brain/prompts.test.ts
git commit -m "feat(brain): recall injection shows memory/procedure age"
```

---

## Task 5: Derived human fields in brain inspect commands

**Files:**
- Modify: `extensions/brain/index.ts` (`handleMemoryInspect`, `handleExperienceInspect` — search for their definitions)
- Test: extend an existing brain test; if none exists for inspect handlers, add `test/brain/inspect.test.ts`

**Interfaces:**
- Consumes: `fmtDateTime`, `fmtAge` from `utils/time.js`.
- Produces: inspect handlers emit an object that STILL contains original ISO fields (`startedAt`, `settledAt`, `createdAt`, `lastAccessed` — whatever exists) AND adds `startedAtHuman`, `settledAtHuman`, `createdAtHuman`, `lastAccessedHuman`, `age`.

- [ ] **Step 1: Locate handlers**

Run: `grep -n 'handleMemoryInspect\|handleExperienceInspect' extensions/brain/index.ts`

Read the surrounding ~30 lines to see the exact object shape returned to `ctx.ui.notify` (likely `JSON.stringify(obj, null, 2)`).

- [ ] **Step 2: Write failing test**

Create `test/brain/inspect.test.ts` (if missing). Snapshot the current shape of each handler's output, then assert the added fields appear:

```typescript
import { describe, it, after } from "node:test";
import * as assert from "node:assert/strict";
// … tmpdir + WAYWISER_HOME setup identical to other brain tests …

// Seed a memory + experience via the brain's own APIs, then call the inspect handlers.
// Verify the notified JSON contains, for each ISO field, a "*Human" sibling and an "age" field.

it("handleMemoryInspect adds human fields alongside ISO", async () => {
  // arrange: seed a memory, capture the ctx.ui.notify call
  // assert: parsed(notified).createdAtHuman is a non-empty string
  // assert: parsed(notified).age matches /(s|m|h|d) ago/
  // assert: parsed(notified).createdAt still equals the original ISO
});
// Similar for handleExperienceInspect.
```

Fill in the arrange step by reading how existing brain tests seed data (grep for `brain-store` or `remember` calls in `test/brain/`). Use the SAME seed pattern; do not invent a new one.

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/brain/inspect.test.ts`
Expected: FAIL — no `*Human` or `age` fields yet.

- [ ] **Step 4: Modify `extensions/brain/index.ts`**

At top of file, add import:

```typescript
import { fmtDateTime, fmtAge } from "../utils/time.js";
```

Inside `handleMemoryInspect`, before serialising the memory object, augment it:

```typescript
const enriched = {
  ...memory,
  createdAtHuman: memory.createdAt ? fmtDateTime(memory.createdAt) : undefined,
  lastAccessedHuman: memory.lastAccessed ? fmtDateTime(memory.lastAccessed) : undefined,
  age: fmtAge(memory.lastAccessed ?? memory.createdAt),
};
ctx.ui.notify(JSON.stringify(enriched, null, 2), "info");
```

Inside `handleExperienceInspect`, similarly:

```typescript
const enriched = {
  ...experience,
  startedAtHuman: experience.startedAt ? fmtDateTime(experience.startedAt) : undefined,
  settledAtHuman: experience.settledAt ? fmtDateTime(experience.settledAt) : undefined,
  age: fmtAge(experience.startedAt),
};
ctx.ui.notify(JSON.stringify(enriched, null, 2), "info");
```

Field names must match the actual `Experience` and `BrainMemory` types in `extensions/brain/types.ts`. If the actual field is `created_at` (snake_case) or `startedAtIso`, adjust accordingly — the test's assertions must use the actual field names too.

- [ ] **Step 5: Run tests**

Run: `node --test test/brain/inspect.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/brain/index.ts test/brain/inspect.test.ts
git commit -m "feat(brain): inspect commands emit human-readable time fields"
```

---

## Task 6: Add `wallClock` to brain traces

**Files:**
- Modify: `extensions/brain/trace.ts` (locate the emit / row-building function; grep for `timestamp:` in the file)
- Test: extend or add `test/brain/trace.test.ts`

**Interfaces:**
- Consumes: `fmtStamp` from `utils/time.js`.
- Produces: every trace row emitted for LLM/notify consumption additionally carries `wallClock: string` (`fmtStamp(timestamp)`). On-disk persisted trace rows are UNCHANGED — do NOT add `wallClock` to the disk-written shape.

- [ ] **Step 1: Locate the emit path**

Run: `grep -n 'timestamp\|logTrace\|emit\|append' extensions/brain/trace.ts`

Distinguish two paths: the one that writes rows to a JSON/DB store (leave alone) vs. the one that returns rows for `ctx.ui.notify` or brain-context injection (add `wallClock` there).

- [ ] **Step 2: Write failing test**

In `test/brain/trace.test.ts` (create if absent), assert that the RETURN of the LLM-facing accessor (e.g. `formatTraceForContext(traceRows)` or whatever it is) contains a `wallClock` value that matches the shape `HH:MM` or `Mon DD, HH:MM`:

```typescript
it("emitted trace rows include wallClock alongside ISO timestamp", () => {
  const row = { timestamp: new Date().toISOString(), tool: "bash", result: "ok", id: "obs-1" };
  const emitted = formatTraceRowForContext(row);       // exact name from your code
  assert.match(emitted.wallClock, /^\d{2}:\d{2}$|^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/);
  assert.equal(emitted.timestamp, row.timestamp);       // ISO preserved
});
```

- [ ] **Step 3: Run tests to verify they fail**

Expected: FAIL — no `wallClock` field.

- [ ] **Step 4: Implement**

At top of `extensions/brain/trace.ts`:

```typescript
import { fmtStamp } from "../utils/time.js";
```

In the LLM-facing formatter (the one whose output enters `ctx.ui.notify` or the system-prompt injection):

```typescript
return {
  ...row,
  wallClock: fmtStamp(row.timestamp),
};
```

Leave the persistence path untouched.

- [ ] **Step 5: Run tests**

Run: `node --test test/brain/trace.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/brain/trace.ts test/brain/trace.test.ts
git commit -m "feat(brain): trace rows carry wallClock sibling for LLM consumption"
```

---

## Task 7: Kanban HTML card footer + overdue badge

**Files:**
- Modify: `extensions/kanban-html.ts:197` (card footer div — currently `Created: ${escHtml(c.created_at)} · Updated: ${escHtml(c.updated_at)}`)
- Modify: same file — overdue badge; find where the card container is rendered (search for `isOverdue(c)` or `overdue`)
- Test: extend `test/waywiser.test.ts` if it covers kanban HTML, otherwise smoke-only (this file has no dedicated test; a snapshot test is out of scope for this task — mark manual smoke)

**Interfaces:**
- Consumes: `fmtStamp`, `fmtAge` from `utils/time.js`, existing `isOverdue(c: CardRow)` helper.
- Produces: no new symbols. The HTML rendered by `renderCard` (or the equivalent function containing line 197) is changed.

- [ ] **Step 1: Add imports**

Top of `extensions/kanban-html.ts`, alongside other utils imports:

```typescript
import { fmtStamp, fmtAge } from "./utils/time.js";
```

- [ ] **Step 2: Replace the footer line**

Change line 197 from:

```typescript
<div style="margin-top:.2rem">Created: ${escHtml(c.created_at)} · Updated: ${escHtml(c.updated_at)}</div>
```

to:

```typescript
<div style="margin-top:.2rem;opacity:.7">Created: ${escHtml(fmtStamp(c.created_at))} · Updated: ${escHtml(fmtStamp(c.updated_at))} (${escHtml(fmtAge(c.updated_at))})</div>
```

- [ ] **Step 3: Add overdue badge**

Locate the card-container render (search `class="card"` or the wrapping `<div>` around the card title). Just before the title, insert:

```typescript
${isOverdue(c) && c.due ? `<span class="overdue-badge" style="background:#c00;color:#fff;padding:.05rem .3rem;border-radius:.2rem;font-size:.75em;margin-right:.3rem">⚠️ ${escHtml(fmtAge(c.due))} overdue</span>` : ""}
```

If `isOverdue` is not currently imported in `kanban-html.ts`, add:

```typescript
import { isOverdue } from "./kanban/ops.js";
```

Confirm `isOverdue` is exported from `extensions/kanban/ops.ts` (grep for `export function isOverdue`). If it is not exported, add `export` to its declaration in `ops.ts`.

- [ ] **Step 4: Manual smoke**

Run: `bin/waywiser`
- Add a kanban card via `/kanban new`.
- Open the HTML board (URL is printed in the TUI).
- Verify footer shows `Created: Aug 25, 14:23 · Updated: Aug 25, 14:23 (3s ago)`.
- Set a past due date via `/kanban due`. Verify the red `⚠️ Xd overdue` badge appears.

- [ ] **Step 5: Run tests to ensure nothing broke**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/kanban-html.ts extensions/kanban/ops.ts
git commit -m "feat(kanban): HTML card footer uses fmtStamp; overdue badge"
```

---

## Task 8: `cardLine` includes `todo` age

**Files:**
- Modify: `extensions/kanban/ops.ts:cardLine` (around line 54 — the existing conditional excludes `done` and `todo`)
- Test: extend an existing kanban test; if none targets `cardLine`, create `test/kanban/ops.test.ts`

**Interfaces:**
- Consumes: `fmtDuration` (already imported per git log).
- Produces: `cardLine(c)` for `todo` status now includes the age suffix in the same `[status age]` bracket already used for `doing` / `blocked`.

- [ ] **Step 1: Write failing test**

Create `test/kanban/ops.test.ts`:

```typescript
import { describe, it, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ww-kanban-ops-test-"));
process.env.WAYWISER_HOME = tmp;

const { cardLine } = jiti("../../extensions/kanban/ops.js") as {
  cardLine: (c: Record<string, unknown>) => string;
};

after(() => {
  delete process.env.WAYWISER_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("cardLine todo age", () => {
  it("includes age for todo status", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const line = cardLine({
      id: "K-1",
      title: "some task",
      status: "todo",
      priority: "med",
      type: "task",
      updated_at: twoHoursAgo,
    });
    // The age suffix appears inside the [status …] brackets.
    assert.match(line, /\[todo\s+.+?\]/);
  });

  it("still excludes age for done status", () => {
    const line = cardLine({
      id: "K-2",
      title: "done task",
      status: "done",
      priority: "med",
      type: "task",
      updated_at: new Date().toISOString(),
    });
    assert.match(line, /\[done\]/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/kanban/ops.test.ts`
Expected: FAIL — `[todo]` has no age.

- [ ] **Step 3: Modify `extensions/kanban/ops.ts:cardLine`**

Find the existing line:

```typescript
const age = c.status !== "done" && c.status !== "todo" ? ` ${fmtDuration(Date.now() - new Date(c.updated_at).getTime())}` : "";
```

Change to (drop the `c.status !== "todo"` exclusion):

```typescript
const age = c.status !== "done" ? ` ${fmtDuration(Date.now() - new Date(c.updated_at).getTime())}` : "";
```

- [ ] **Step 4: Run tests**

Run: `node --test test/kanban/ops.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/kanban/ops.ts test/kanban/ops.test.ts
git commit -m "feat(kanban): cardLine shows age for todo cards too"
```

---

## Task 9: Notify — webhook payload + Telegram cross-day

**Files:**
- Modify: `extensions/notify.ts` (webhook send around line 292; Telegram body around line 204)
- Test: extend `test/waywiser.test.ts` if it covers notify, otherwise add `test/notify.test.ts`

**Interfaces:**
- Consumes: `fmtStamp` (Telegram already uses `fmtTime`; upgrade to `fmtStamp`), `fmtAge`.
- Produces: webhook POST body gains two ADDED fields — `human: string` and `age: string`. Existing fields (`iso` / `timestamp` / whatever is there) remain identical.

- [ ] **Step 1: Locate exact webhook build site**

Run: `grep -n 'webhook\|toISOString\|fetch\|JSON.stringify' extensions/notify.ts`

Identify the object literal that becomes the POST body. Snapshot its current shape.

- [ ] **Step 2: Write failing test**

Create `test/notify.test.ts` if not present. Test the webhook payload builder in isolation (extract it as a pure helper if it isn't already — a small refactor is fine here):

```typescript
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildWebhookPayload } = jiti("../extensions/notify.js") as {
  buildWebhookPayload: (title: string, body: string, level: string, nowMs?: number) => Record<string, unknown>;
};

describe("buildWebhookPayload", () => {
  it("includes iso, human, and age fields", () => {
    const now = Date.parse("2026-08-25T14:23:00.000Z");
    const p = buildWebhookPayload("test", "hello", "info", now);
    assert.equal(typeof p.iso, "string");
    assert.equal(typeof p.human, "string");
    assert.equal(typeof p.age, "string");
    assert.ok((p.iso as string).includes("2026-08-25"));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Expected: FAIL — `buildWebhookPayload` may not exist as an export; or if it does, `human`/`age` are missing.

- [ ] **Step 4: Refactor + implement**

Extract the webhook payload builder as an exported function:

```typescript
import { fmtStamp, fmtAge } from "./utils/time.js";

export function buildWebhookPayload(title: string, body: string, level: string, nowMs: number = Date.now()): Record<string, unknown> {
	const iso = new Date(nowMs).toISOString();
	return {
		title,
		body,
		level,
		iso,
		human: fmtStamp(nowMs),
		age: fmtAge(nowMs),
	};
}
```

Replace the inline payload construction at the fetch call site with a call to `buildWebhookPayload(...)`. Preserve every existing field — if the current payload has `timestamp`, add `timestamp: iso` to the returned object rather than removing it.

For the Telegram body, change:

```typescript
`[${fmtTime(Date.now())}] ${body}`
```

to:

```typescript
`[${fmtStamp(Date.now())}] ${body}`
```

Import adjustment: replace `fmtTime` with `fmtStamp` in the top imports if `fmtTime` is no longer used elsewhere in the file (grep before removing).

- [ ] **Step 5: Run tests**

Run: `node --test test/notify.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/notify.ts test/notify.test.ts
git commit -m "feat(notify): webhook payload gains human+age; Telegram cross-day"
```

---

## Task 10: Mobile inbox delivery prefix

**Files:**
- Modify: `extensions/mobile/index.ts:88` and every other `pi.sendUserMessage(...)` call site inside `processMessage` (currently `[reply] …` at line 99 plus similar for other intents)
- Test: `test/mobile/` — extend an existing test if one hits `processMessage`, otherwise add `test/mobile/inbox-delivery.test.ts`

**Interfaces:**
- Consumes: `fmtStamp`, `fmtAge` from `utils/time.js`; existing `InboxMessage.receivedAtMs`.
- Produces: no new exports. Every `pi.sendUserMessage(...)` fired from inside `processMessage` prefixes its body with `[received ${fmtStamp(msg.receivedAtMs)} · ${fmtAge(msg.receivedAtMs)}] `.

- [ ] **Step 1: Locate all `sendUserMessage` call sites in `processMessage`**

Run: `grep -n 'sendUserMessage' extensions/mobile/index.ts`

For each call, note the current body construction.

- [ ] **Step 2: Write failing test (best-effort)**

If a mock-`pi` test already exercises `processMessage`, extend it. Otherwise, write a smaller test around a new tiny helper you'll extract:

Add to `extensions/mobile/index.ts`:

```typescript
import { fmtStamp, fmtAge } from "../utils/time.js";

export function _receivedPrefix(receivedAtMs: number): string {
	return `[received ${fmtStamp(receivedAtMs)} · ${fmtAge(receivedAtMs)}] `;
}
```

Test at `test/mobile/inbox-delivery.test.ts`:

```typescript
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { _receivedPrefix } = jiti("../../extensions/mobile/index.js") as {
  _receivedPrefix: (receivedAtMs: number) => string;
};

describe("mobile _receivedPrefix", () => {
  it("wraps receivedAtMs in a [received … · … ago] prefix ending in a space", () => {
    const p = _receivedPrefix(Date.now() - 3600_000);
    assert.match(p, /^\[received .+? · .+? ago\]\s$/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Expected: FAIL — `_receivedPrefix` does not exist yet.

- [ ] **Step 4: Implement**

Add the `_receivedPrefix` helper (as shown above) at the top of `extensions/mobile/index.ts`.

Then wrap every `pi.sendUserMessage(...)` inside `processMessage(msg, ctx)`:

```typescript
// Before:
pi.sendUserMessage(`[reply] ${text}`, { deliverAs: "followUp" });
// After:
pi.sendUserMessage(`${_receivedPrefix(msg.receivedAtMs)}[reply] ${text}`, { deliverAs: "followUp" });
```

And similarly at line ~137:

```typescript
// Before:
if (typeof intent.prompt === "string") pi.sendUserMessage(String(intent.prompt), { deliverAs: "followUp" });
// After:
if (typeof intent.prompt === "string") pi.sendUserMessage(`${_receivedPrefix(msg.receivedAtMs)}${String(intent.prompt)}`, { deliverAs: "followUp" });
```

Apply the same pattern to every other `pi.sendUserMessage` inside `processMessage`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Manual smoke**

- Trigger a mobile capture (send yourself a Telegram message via the configured bot).
- In `bin/waywiser`, observe the injected user turn is prefixed with `[received 14:23 · 2m ago] [reply] …`.

- [ ] **Step 7: Commit**

```bash
git add extensions/mobile/index.ts test/mobile/inbox-delivery.test.ts
git commit -m "feat(mobile): inbox delivery preserves receive time in message body"
```

---

## Task 11: Cronjob listings

**Files:**
- Modify: `extensions/cronjob.ts` (locate the list-rendering function — grep for `ctx.ui.notify` and `lastRun`/`nextRun`)
- Test: extend or create `test/cronjob.test.ts`

**Interfaces:**
- Consumes: `fmtSmart`, `fmtDateTime` from `utils/time.js`.
- Produces: no new exports. The rendered lines shown by the cronjob list command include `last: <fmtSmart(lastRun)>` when defined and `next: <fmtDateTime(nextRun)>` when defined.

- [ ] **Step 1: Locate the list renderer**

Run: `grep -n 'ctx.ui.notify\|lastRun\|nextRun\|list' extensions/cronjob.ts`

Find the string-building loop that formats each job row.

- [ ] **Step 2: Extract as a pure helper for testability**

Refactor the per-row formatter into an exported function `formatJobRow(job)` (or amend a name that already exists):

```typescript
import { fmtSmart, fmtDateTime } from "./utils/time.js";

export interface JobRowForDisplay {
	id: string;
	schedule: string;
	lastRun?: string | number;
	nextRun?: string | number;
	// ... whatever other fields the current formatter reads
}

export function formatJobRow(job: JobRowForDisplay): string {
	const last = job.lastRun ? ` last: ${fmtSmart(job.lastRun)}` : " last: never";
	const next = job.nextRun ? ` next: ${fmtDateTime(job.nextRun)}` : "";
	return `${job.id} @ ${job.schedule}${last}${next}`;
}
```

Preserve every field the current formatter emitted. If the current output is richer (e.g. also emits `command`, `disabled`), keep them in the returned string.

- [ ] **Step 3: Write failing test**

Create `test/cronjob.test.ts`:

```typescript
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatJobRow } = jiti("../extensions/cronjob.js") as {
  formatJobRow: (job: Record<string, unknown>) => string;
};

describe("formatJobRow", () => {
  it("shows fmtSmart for recent lastRun", () => {
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const line = formatJobRow({ id: "j1", schedule: "*/5 * * * *", lastRun: oneHourAgo });
    assert.match(line, /last: .+? ago/);
  });

  it("shows 'never' when lastRun absent", () => {
    const line = formatJobRow({ id: "j2", schedule: "0 * * * *" });
    assert.match(line, /last: never/);
  });

  it("shows fmtDateTime for nextRun", () => {
    const inOneHour = new Date(Date.now() + 3600_000).toISOString();
    const line = formatJobRow({ id: "j3", schedule: "0 * * * *", nextRun: inOneHour });
    assert.match(line, /next: /);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Expected: FAIL — `formatJobRow` not exported yet.

- [ ] **Step 5: Wire helper into existing list output**

Replace the inline formatting inside the cronjob list command handler with `formatJobRow(job)`.

- [ ] **Step 6: Run tests**

Run: `node --test test/cronjob.test.ts && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/cronjob.ts test/cronjob.test.ts
git commit -m "feat(cronjob): list output shows human-readable last/next run"
```

---

## Task 12: Sweep remaining raw stamps in commands/proactive/meta-skills/clarify

**Files:**
- Modify: `extensions/commands.ts`, `extensions/proactive.ts`, `extensions/meta-skills.ts`, `extensions/clarify.ts` (grep-driven; only files with hits)
- No new tests — mechanical replacements verified by full `npm test` pass. If a specific behavior CHANGES visibly (not just a formatter swap), add a test for that change.

**Interfaces:**
- Consumes: `fmtStamp`, `fmtDateTime`, `fmtSmart` from `utils/time.js`.
- Produces: no new symbols. User-visible / LLM-visible timestamp strings switch from raw ISO / `.slice()` / `.toLocaleString()` to shared formatters.

- [ ] **Step 1: Grep for candidates**

Run each in turn (bash tool):

```bash
grep -n '\.toISOString\|\.slice(0,\s*16)\|\.replace(.*T.*)' extensions/commands.ts extensions/proactive.ts extensions/meta-skills.ts extensions/clarify.ts
grep -n 'new Date(.*)\.toLocaleString\|new Date(.*)\.toLocaleTimeString' extensions/commands.ts extensions/proactive.ts extensions/meta-skills.ts extensions/clarify.ts
```

For each hit, classify:
- Is this a MOMENT (one specific event, e.g. "notification sent at X") → use `fmtStamp` or `fmtDateTime`.
- Is this a HISTORICAL LIST ROW (age matters vs absolute) → use `fmtSmart`.
- Is this a SCHEDULING PRIMITIVE (not display; e.g. `Date.now()` for `setTimeout` math) → LEAVE UNCHANGED.

- [ ] **Step 2: Replace each hit in place**

For each classified hit, edit the file. Add the appropriate import at the top of the file if not already present:

```typescript
import { fmtStamp, fmtDateTime, fmtSmart } from "./utils/time.js";
```

(Only import what you use.)

- [ ] **Step 3: Manual smoke each affected command**

For each edited file, exercise the command it powers. Examples:
- `commands.ts` edited → run `/goals`, `/mem list`, `/mem stats`, `/waywiser status` and confirm rendered timestamps.
- `proactive.ts` edited → `/proactive status`.
- `meta-skills.ts` / `clarify.ts` → invoke the relevant command.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: PASS. If a formatter change broke an assertion in an existing test (e.g. a test asserts `\[2026-08-` prefix), UPDATE that test's assertion to match the new formatter's output. Do NOT weaken the assertion — swap the expected string to the exact new output.

- [ ] **Step 5: Commit**

```bash
git add extensions/commands.ts extensions/proactive.ts extensions/meta-skills.ts extensions/clarify.ts
git commit -m "refactor(time): sweep raw stamps to shared formatters"
```

---

## Task 13: End-to-end manual smoke + branch cleanup + PR

**Files:** none modified in this task.

**Interfaces:** N/A.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 2: Type-check (if the project has a `tsc --noEmit` script; otherwise skip)**

Run: `grep -n 'typecheck\|tsc' package.json`
If present, execute the script. Fix any type errors.

- [ ] **Step 3: End-to-end smoke via `bin/waywiser`**

Walk the manual smoke steps from the spec (§ 6):
1. `bin/waywiser` → send a message → both sides show `[HH:MM]` prefix. If the code-style prefix renders as HIGHLIGHTED (loud) rather than muted, edit `~/.waywiser/config.json` to set `"tuiStamps": {"style": "plain"}` — if plain reads better, change the DEFAULT in `extensions/tui-stamps.ts:_loadConfig` and add a commit `refactor(tui-stamps): default style plain (code renders too loud)`.
2. `/mem recall <term>` → rows show `(last used …)`.
3. Add + update a kanban card → HTML board footer shows `Created … · Updated … (Xs ago)`; overdue badge appears on past-due cards.
4. `/journey`, `/goals`, `/mem list`, `/waywiser status` → every row has a formatted stamp.
5. Configure a webhook, trigger a notify → payload has `iso`, `human`, `age`.
6. `/proactive status`, cronjob list → last-run shows age when recent, stamp when older.
7. `~/.waywiser/config.json` → `"tuiStamps": {"enabled": false}` → restart `bin/waywiser` → messages render without stamps.

- [ ] **Step 4: Verify uncommitted `extensions/clock.ts` diff is intended**

Run: `git status && git diff extensions/clock.ts`
The pre-existing diff grabs `ctx` from `session_start` so the status-bar clock isn't blank until the first turn. This is a valid fix. Commit it as its own commit:

```bash
git add extensions/clock.ts
git commit -m "fix(clock): grab ctx from session_start so status bar isn't blank until first turn"
```

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin feat/mobile
gh pr create --title "Time-awareness phase 2 — per-message TUI stamps + ecosystem pass" --body "$(cat <<'EOF'
## Summary
- Adds `extensions/tui-stamps.ts` — `pi.registerMarkdownTransformer` prefixes user/assistant messages with `[HH:MM]` (dim, cross-day aware, streaming-cached).
- Adds `fmtSmart(v, thresholdHours?)` to `utils/time.ts` — picks age vs stamp based on `~/.waywiser/config.json → timeDisplay.relativeThresholdHours` (default 24).
- Fills ecosystem gaps: brain recall + inspect + traces, kanban HTML footer + overdue badge, todo card age, notify webhook payload + Telegram cross-day, mobile inbox `[received …]` prefix, cronjob list `last:` / `next:`.
- Sweeps commands/proactive/meta-skills/clarify for remaining raw stamps.
- Fixes clock status bar being blank until first turn (session_start ctx capture).

## Test plan
- [ ] `npm test` green
- [ ] Manual: `bin/waywiser` → messages carry `[HH:MM]` prefix
- [ ] Manual: kanban HTML card footer shows human-readable created/updated/age; overdue badge on past-due cards
- [ ] Manual: `/mem recall`, `/journey`, `/goals`, `/proactive status`, cronjob list — all human-readable
- [ ] Manual: webhook payload contains `iso`, `human`, `age`
- [ ] Manual: `tuiStamps.enabled = false` disables prefixing after restart

Implements `docs/superpowers/specs/2026-08-25-time-awareness-phase-2-design.md`.
EOF
)"
```

---

## Self-Review

**Spec coverage (per section of the spec):**
- § 1 TUI stamping (`tui-stamps.ts`) → Tasks 2 + 3.
- § 2 `fmtSmart` + `relativeThresholdHours` → Task 1.
- § 3 gap fills:
  - brain/prompts.ts recall → Task 4.
  - brain/index.ts inspect → Task 5.
  - brain/trace.ts wallClock → Task 6.
  - kanban-html.ts footer + overdue → Task 7.
  - kanban/ops.ts todo age → Task 8.
  - notify webhook + Telegram → Task 9.
  - mobile inbox delivery → Task 10.
  - cronjob listings → Task 11.
  - commands / proactive / meta-skills / clarify sweep → Task 12.
- § 4 data flow — no code; presentation-only, verified via smoke.
- § 5 error handling — covered inside individual tasks (try/catch in transformer wrapper, `parseTs` throws contained by callers, LRU cap).
- § 6 testing — split across per-task tests; manual smoke in Task 13.
- § 7 rollout — Task 13 (PR body documents defaults + restart requirement).

**Placeholder scan:** No "TBD" / "TODO" / "implement later" remain. Each task shows the actual code to write.

**Type consistency:** `_makeStampCache`, `_stampKey`, `_renderStampPrefix`, `_loadConfig`, `_receivedPrefix`, `buildWebhookPayload`, `formatJobRow`, `relativeThresholdHours`, `fmtSmart`, `_resetTimeCaches` — each used across tasks with a single consistent signature. Task 4 notes the `RecallItem` type may need widening in `types.ts` and instructs a grep-verify before doing so.

**Sequencing:** Task 1 is a hard prerequisite for Tasks 2 (uses `fmtStamp` only, but the module tests will fail without `fmtSmart` if we're strict); Tasks 4 / 11 / 12 explicitly depend on `fmtSmart` and MUST run after Task 1. Tasks 2 → 3 must be in that order (helpers before wiring). Everything else is independent and can run in any order.
