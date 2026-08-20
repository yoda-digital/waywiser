# waywiser

**A personal AI agent layered on `pi`** (the `@earendil-works/pi-coding-agent`
harness). No core changes to pi — 13 tools + 15 commands + 1 operating skill,
loaded as in-process TypeScript extensions.

Tested in production daily-driver conditions on **Qwen3.8-27B served via a
remote Ollama** (128K window, thinking mode, OpenAI-compat API) with pi 0.84.2.
This README reports what was **actually run and observed**, not what the code
claims. Sections: what / why / how / what works / what does not — the last one
is the honest part, read it too.

---

## What it is

Your `pi` session, plus:

| Piece | What it gives you |
|---|---|
| `soul` tool + SOUL.md | A living identity that survives restarts; append-only preferences/lessons |
| `memory` tool | Cross-session memory (SQLite FTS5) + MEMORY.md you can read yourself; **gated auto-writes** at turn end (a one-shot gate child extracts durable facts/preferences from structural signals, verbatim-anchored, `agent@0.6`), **relevance-selective recall** per turn (BM25 top-k, throttled, ≤500-char block injected), **consolidation** (`/memory consolidate` — dry-run first), and inspectability (`memlog`, `/memory conflicts/stats`, USER.md export) |
| `delegate_task` | Real subagents: isolated `pi --mode rpc` children, leaf/orchestrator roles, steer/stop, max 3 concurrent |
| `execute_code` | Batch N tool calls in one turn via a script the child model executes |
| `web_search` / `web_extract` | Web research (`vsearch` CLI if installed, DuckDuckGo fallback; no deps needed) |
| `todo` tool | In-session task board + TODO.md (yields politely if another extension owns `todo`) |
| `skills_*` tools | Create/view/manage SKILL.md files without leaving the agent |
| `cronjob` + `/cron` | Scheduled jobs: session-mode timers and system-mode `~/.waywiser/cron/*.cron`; **quiet hours** (global DND window — in-window fires are deferred to window end, one-shot jobs fire exactly once) |
| `clarify` | Ask you a question mid-task (degrades to a clean error in `-p` mode) |
| `/kanban` + `kanban` tool | Multi-agent board — 2 subcommand forms of the same board (REPL + model, any mode): new/list/show/move/assign/block/resume/note/report/pri/due/wait/done/remove/stats/clear-done; **`assign … subagent` really spawns a detached leaf worker that files its report on the card** (verified live); priorities, due dates + OVERDUE, TUI widget |
| `/waywiser /memory /soul /journey /refine /handoff /worktree /context` | REPL/status set |
| `/memory [query|action line]` | Bare words → OR-joined recall; action lines: `/memory consolidate [apply]`, `/memory conflicts`, `/memory stats`, `/memory promote <id>` / `supersede <keep> <drop>` / `set auto\|recall\|gateTimeoutMs=…` (TUI) |

All additive-only and **prompt-cache-stable**: state is injected once per
session (SOUL first, memory digest second, goals last); mid-session changes are
append-only file edits that apply next turn. Nothing rewrites past context or
swaps toolsets mid-conversation.

## Why it exists

Two problems a plain CLI LLM has:

1. **Amnesia.** Every session starts from zero. A personal assistant you use
   daily needs to remember your preferences, projects, and lessons.
2. **One context window.** Research that floods 100K tokens of context is a
   bad place to burn your main window. Delegation spends a *child's* context
   and returns a summary.

Everything else (cron, board, skills) is for keeping a *long-lived* agent
useful between conversations — scheduled digests, visible progress, reusable
capabilities. If you only want problems 1–2, you can ignore the rest.

## How it works

- **Entrypoint** (`bin/waywiser`) bootstraps `WAYWISER_HOME` (default
  `~/.waywiser`), one-time non-destructive migration from a legacy
  `~/.hermes`, then execs `pi --extension <pkg>/extensions/index.ts --skill …`.
- **Memory** is the selective-memory pipeline (spec:
  `docs/superpowers/specs/2026-08-20-selective-memory-design.md`), all in
  `node:sqlite` (`waywiser.db` + FTS5) with plain text you can read: `MEMORY.md`
  (append-only raw log — the trustworthy one) and `USER.md` (regenerated
  preferences export):  
  *Three write paths:* explicit `memory remember` (`user@0.9`) · the turn-end
  **gate** — one core-tool leaf child, 8 s default budget, extracts ≤2
  durable candidates only when structural signals are present, verbatim-anchored
  to the current window, written `agent@0.6`; a timeout drops the candidate
  silently (never stalls the turn) · `consolidate` (user-triggered). Every
  mutation lands in the `memlog` audit table.  
  *Read pool:* read paths see only `confidence ≥ 0.5` rows not superseded by a
  live non-external row. External (web-scraped) rows are stored
  `external@0.3` — invisible in **all** read paths until you `promote` them.
  *Recall, three modes* (`memory set recall=…`): `selective` (default) —
  per-turn BM25 block (≤5 rows / 500 chars) reselected only on query-key
  change or every N user turns; `top8` — legacy top-8 every turn; `off` —
  digest only. The session **digest** (top-8 by access) is built once at
  `session_start` and injected **before** the recall block, so the prefix is
  byte-stable for prompt caching.
- **Delegation** spawns children over pi's strict JSONL RPC protocol
  (`prompt/follow_up/get_last_assistant_text/…`), probes readiness with a
  `get_state` round-trip, and isolates failures — a dead child returns a report
  saying so, it does not crash you.
- **Failure isolation**: every sub-extension loads in its own try/catch; one
  broken module never takes down the pack.

## What works — with evidence

Verified by running it (2026-08, pi 0.84.2, Qwen3.8-27B remote Ollama):

- **First run is genuinely frictionless.** `bash bin/waywiser -p "…"` one
  command: home bootstrapped, legacy `~/.hermes` migrated silently, answered
  same turn. No config files to write.
- **Memory roundtrip across separate sessions** — including with *natural* phrasing (see "Fixed this audit" below). Stored a preference + a fact
  in session A; a *fresh* session B recalled both with correct IDs and
  presented them with source attribution. Honest "I remember nothing" when the
  store was empty — it does not fake recall.
- **Delegation end-to-end.** A leaf child ran real bash in a real repo,
  returned exactly the constrained answer (`12 files / 2092 lines`), and the
  **parent independently re-verified the child's answer**. The verify-the-child
  habit is the whole feature — it works when you use it.
- **Tool-calling reliability under ~21 registered tools** (13 waywiser + core
  pi tools): 6/6 API round-trips with 100% valid-JSON tool calls, correct tool
  selection, 1–2.5s latency. The "small models choke on big tool surfaces"
  fear does **not** apply to Qwen3.x at this size — those early-2026 reports
  were Ollama template/renderer bugs (fixed ≥ 0.17.6), not model ceilings.
- **Thinking mode coexists with tool calls** under a 16K output cap. Reasoning
  is returned in its own `reasoning` field, doesn't crowd out the tool call,
  and no `finish_reason=length` truncation in stressed runs (effort=high,
  verbose prompts).
- **`unit + smoke` test suite** passes (**54 tests**: memrules gate
  extraction/validation, planPass1 near-dup/orphan/decay math, consolidate
  dry-run/apply/supersede-resolution, OR-joined FTS recall + throttle +
  renderer, full memory action surface incl. promote/supersede/set/stats and
  the command-line parser, state schema, FTS5, kanban ops, quiet-hours core,
  htmlToText; + smoke); smoke asserts the full 13 tools + 15 commands
  register against a deterministic API stub.

## What does not work / go wrong — brutally

Observed in the same runs, not theoretical:

1. **Fixed this audit (see below), kept as the repro record:** the original
   `memory recall` AND-joined every query term — a natural multi-word query
   ("preferred editor waywiser") returned **0 rows** unless one memory
   contained every word; a hyphenated term (`pi-package`) parsed as a column →
   SQL error. Reproduced directly against the DB, then fixed (OR-join, bm25
   ranked, hyphens quoted) and covered by two regression tests that fail on
   the old code.
2. **Fresh-session self-narration errors.** In one of six sessions the model
   flatly claimed "I don't have a `memory` tool exposed in this session" —
   it did; the next sessions listed all tools correctly. With ~20 tools on a
   27B model, expect the occasional "I can't do that" blip on first ask.
   Don't believe it on first attempt; ask it to list its tools.
3. **Identity drift.** The model introduced itself as "Waywiser **(Hermes
   Agent)**" despite SOUL.md saying otherwise — training-data residue.
   Cosmetic, but on day one of a *personal* assistant it dents trust.
4. **`execute_code` ordering is the child model's call.** The README's old risk
   note stands, now with nuance: Qwen3.8 is *conservative* about batching —
   in practice it made 1-of-4 requested batch calls per turn on its own
   initiative, which de-risks (but doesn't eliminate) reorderings.
   Order-sensitive work must still be verified.
5. **Session-mode cron jobs only fire while pi is running.** System-mode
   (`.cron` files) is the real scheduling path; session timers are for
   reminders inside one sitting.
   **Quiet hours (DND) are session-mode and static**: the `HH:MM-HH:MM`
   window (may wrap midnight; `/cron quiet 22:00-07:00`) defers in-window
   fires to the window's end — it does not mute system-cron jobs (separate
   process) and has no per-job windows or quiet-hours *inside* the window
   (everything queues to one wake at window end; that is deliberate).
6. **Kanban/goal tree: keep or ignore, don't invest.** They work (persist,
   render, inject), but external 1-year user data for solo operator board
   products is thin-to-negative (the 27.9k-star Vibe Kanban is sunsetting);
   the pattern is consolidating *into* harnesses. Useful as a progress
   scratchpad while the agent works; not something a solo user comes back
   to daily. (After the 2026-08-20 audit: kanban additionally gained
   model-side access in `-p` mode, priorities/due-dates/OVERDUE, note/report
   ops, and real `assign … subagent` spawning with on-card reports — see the
   capability table.)
7. **`todo` disappears if you also load another `todo` extension** (e.g.
   pi-superpowers). By design (collision-aware), but you'll see a stderr line
   every launch and waywiser's board is simply not there.
8. **`-p` one-shot mode is the honest but curt mode.** `clarify` cannot ask
   you anything there; delegation blocks without a TUI. Interactive TUI mode
   is where the pack is actually comfortable.
9. **Your server specifically: Cloudflare WAF blocks Python-client UAs** —
   any `python-urllib` request to `ollama.nalyk.dev` gets `403 (error code:
   1010)`; curl/Go/Node UAs pass. Self-written Python scripts that hit it
   directly need a non-python `User-Agent` header (or you allowlist python on
   the WAF). (Server serves `unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL`; pi itself
   is unaffected.)
10. **The gate costs a model round-trip per user turn** (leaf 27B child, 8 s
   default budget, `gateTimeoutMs` tunable up to 20 s). The 2026-08-20/21
   battery measured ~5–30 s *whole-session* — the in-turn contribution is
   smaller but real, and it is the price of auto-writes: silent skip on
   timeout, never a stall. `memory set auto=false` removes the cost entirely
   (your explicit `remember` calls still work). Two honest filter
   asymmetries: the session digest uses a plain `confidence ≥ 0.5` top-8
   (it does not filter superseded rows or decay), whereas recall/list/read
   paths use the full read-pool predicate — between consolidations the digest
   can quote a superseded line that recall correctly withholds; and stale
   low-use `fact` rows only drop below the read pool when you run
   `consolidate apply` (decay is not time-continuous).

## Fixed this audit (2026-08-20, each covered by tests + live reruns)

- **`memory recall` natural-query bug — FIXED.** `ftsEscape` now OR-joins
  terms (relevance ranked by bm25, which the SQL already computed) and always
  quotes hyphenated terms. Proven two ways: two regression tests that fail on
  the old code (verified by stash-and-rerun) and a live run where one natural
  query ("editor choice and project I'm building") returned both memories —
  the exact phrasing that previously returned 0 rows.
- **Selective memory, end-to-end (2026-08-20 battery, real 27B via
  `ollama.nalyk.dev`, isolated home).** Six observed proofs: (a) the turn-end
  gate wrote a new row itself — `source=agent, confidence=0.6`, verbatim
  anchor set, `memlog kind='gate' accept`; (b) a *fresh* session recalled it
  from the injected block (memlog `inject` row for the recall query); (c) an
  externally-seeded row (`source=external@0.3`) was **not** recalled
  (READ_POOL freeze), and after `source='user'@0.9` promote it was; (d) the
  session digest is built once at `session_start` (pure function of SOUL +
  read-pool top-8 by access_count) and is positioned **before** the recall block
  for prompt-cache stability; (e) `set recall=off|selective` persists to
  `mem.json` and read-back reflects the mode; (f) consolidation dry-run over
  the live rows returned a clean, sane change-set (0 exact-dups, 0 merges)
  with zero mutations. Full log: `~/.superpowers/sdd/2026-08-20-selective-memory/task-10-report.md`.
- **`execute_code` child-skip visibility — HARDENED.** The chain was already
  protocol-sequential (one prompt + a forced follow_up per call, agent_end
  between); it now detects when the child's summary lacks one line per call
  and prepends an explicit `WARNING: … some calls may not have executed`
  instead of passing that off as a clean success.
- **Identity drift — MITIGATED (prompt-level only).** `config/SOUL.md` now
  carries an identity anchor forbidding invented/predecessor names (the
  "Waywiser (Hermes Agent)" self-introduction observed on first run). Caveat:
  the model's weights know the ancestor project's name (it is in the training
  corpus); the anchor suppresses, it does not un-teach. Fresh homes get it on
  bootstrap; existing `WAYWISER_HOME` files are yours — copy the anchor block
  in, or re-bootstrap deliberately.
- **Cloudflare-403 finding sharpened** (item 9 above: it is a Cloudflare WAF
  rule matching Python client UAs, verified by A/B, not "non-curl").

## Deliberate non-fixes (documented, not bugs)

Session-mode cron limits, `/goal`-tree ROI (kanban is now full-featured —
see the capability table), `todo` collision-yield, `-p`
curtness — product decisions; code added for them would be cargo-cult. Still
honestly **open**: week-long retention and shared-pool latency — re-run this
audit's checks after real sustained use. **Never-claimed as tested:**
shared-pool latency, heavy multi-agent workloads, week-long retention of
SOUL/memory as they grow. The runs above were hours apart and small-scale. If
you lean on this as the daily driver for weeks, expect to audit this list
again.

## Install / run

Requires **Node >= 22.5** and a working `pi` on PATH (peer dependency).

```bash
npm install -g waywiser          # or: pi install waywiser
# or from a checkout:
cd waywiser && npm install && bash bin/waywiser

waywiser                          # interactive TUI (the comfortable mode)
waywiser -p "task"                # one-shot
waywiser --tools "delegate_task,memory" "task"   # any pi flag passes through
WAYWISER_HOME=~/.waywiser waywiser
```

## Tests

```bash
npm test    # node --test test/*.test.ts (Node >= 22.5)
```

- `smoke` — every sub-extension loads under jiti and registers 13 tools + 15
  commands against a deterministic ExtensionAPI stub.
- `waywiser` — unit tests: state, gate (extraction/validation/episode batching),
  selective recall (OR-join query, throttle, renderer), consolidate (pass-1,
  report, USER.md rebuild), memory actions (promote/supersede/set/stats),
  SQLite FTS5 triggers, htmlToText. **54 tests total, all green.**

Live-model verification notes (kept verbatim, dated):
`tools list, memory roundtrip, delegate_task spawn+report (real child),
execute_code 2-call batch, web_search results, SOUL + digest injection` —
2026-08, Qwen3.8-27B via `ollama.nalyk.dev`.

## Out of scope (deliberate)

Gateway (Telegram/Discord — wrap pi RPC), browser CDP, sandbox backends (pi
has none by design — "a partial in-process sandbox would be easy to
misunderstand as a security boundary"), MCP (pi rejected it as its extension
mechanism), desktop app.

---

**Provenance.** This pack began as "hermes-on-pi", an independent
re-implementation of the product surface of NousResearch/hermes-agent (MIT),
"adapt, don't copy"; research notes in `research/`. It is now Waywiser and
stands on its own; `~/.hermes` homes are still auto-migrated non-destructively
on first run.
