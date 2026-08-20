# Waywiser Selective Memory — Design Spec (A+B+C+D)

> Status: DESIGN (approved-in-chat 2026-08-20; written per brainstorming skill)
> Owner: waywiser package · Scope: extension-level only, no pi core changes
> Supersedes nothing; extends `extensions/memory.ts` (current: explicit `/remember`,
> FTS5 `recall`, top-8 session-start digest — all of which remain the fallback layer).

## 1. Context and problem

Current memory subsystem (verified 2026-08-20):
- Writes: **manual only** (`memory` tool `remember`). Nothing is stored unless the
  user/model explicitly says to → the #2 user-complaint ("never uses memories")
  on the write side.
- Reads: session-start digest of top-8 by `access_count` (coarse, not
  relevant to the current task), plus explicit `recall`.

Target state: **reliable selective memory** — the assistant unprompted remembers
the *right* things (gated writes + per-turn relevant recall), never poisons
itself (provenance + external freeze), and stays inspectable (everything is in
SQLite + two human-readable exports).

Evidence base (vsearch sweeps 2026-08-20; full source list §9):
- SOTA auto-extraction misses ~1 in 4 facts (MOSAIC 84% recall / 72% acc) →
  **precision-first gating**, not recall-first extraction.
- Unfiltered auto-store measured *worse* than no memory (HBS) → hard gates.
- MINJA: ~95% memory-poisoning success via query-only injection → external
  content is a durable sink; **never auto-confirmed**, never in the recall pool.
- EMNLP 2025 context-length degradation (13.9–85%) + small-model extra penalty →
  per-turn recall is **capped (≤5 items, ≤500 tokens)**, throttled for cache
  stability, edge-placed.
- Vendor "sleep-time compute" (preprint, unreplicated) + ChatGPT memory-collapse
  postmortem → consolidation is **deterministic-first, LLM-only-on-candidates,
  capped, append-only-log, user-confirm for contradictions**.
- BM25 ≥ vectors at 1k–5k items → **no sqlite-vec**. Cuts: vectors, graph,
  HippoRAG, 4-store taxonomy, spaced repetition — recorded as YAGNI (§7).

Hard constraints (from the pack, all binding):
- No hidden automation: every auto-write is logged (`memlog`), visible in
  `list`/`stats`, and reversible (`forget`; user-confirmed supersession).
- Prompt-cache stability: session-start digest stays byte-stable per session;
  the new injection block is throttled (re-selected at most once per 2 user
  turns) and lives in the same `before_agent_start` append slot.
- No new dependencies: `node:sqlite` (FTS5), JSON config files, one 27B Ollama
  chat call per gating/consolidation operation (no embedding models).
- 27B is the WEAKEST link: every extraction is verbatim-anchored or discarded,
  JSON-only outputs, bounded inputs, hard timeouts with safe fallback.

## 2. Architecture

```
                      turn_end hook (new, in memory.ts)
        ┌───────────────┬───────────────────────────────┐
        ▼               ▼                               ▼
  GateInput ──► memrules.ts (PURE)              27B gate call
  (transcript  - buildGateInput()                 (timeout 8 s, fire-and-
   window)     - parse/validate candidates        forget, in-flight flag)
                          │
                          ▼
        candidate rows ──► memories (source, verbatim, conf by §4)
                          └► memlog (kind=write)

   before_agent_start (existing hook, extended)
        ├─ digest (UNCHANGED, byte-stable)        ← fallback + base
        └─ recall block (NEW): throttle → query builder → FTS5 BM25
           → top-5 ≤ 500 tokens, conf ≥ 0.5 only, each line tagged source=

   /memory consolidate  (new action + command)
        ├─ pass 1: SQLite-only (exact-hash dedup, Jaccard≥0.8 near-dup,
        │          supersede-orphan cleanup, staleness decay — all pure fns)
        ├─ pass 2: 27B on ≤10 near-dup pairs (merge proposal → apply + log)
        │          and ≤10 contradiction pairs (→ memlog PROPOSED, user confirms)
        └─ rebuild USER.md export
```

Module graph (no import cycles; `memory.ts` is pure top for tools/hooks):

```
commands.ts ──► memory.ts (shared memAction dispatcher) ──► mem-dream.ts
                                                    ├──► memrules.ts (pure)
                                                    ├──► utils/llmcall.ts ──► utils/rpc.ts
                                                    └──► utils/state.ts
mem-dream.ts ──► { memrules.ts, utils/llmcall.ts, utils/state.ts }
memrules.ts  ──► (nothing — pure)
```

Files changed:

| File | Change | Responsibility (one) |
|---|---|---|
| `extensions/memrules.ts` | **new** | ALL pure logic: gate prompt + input builder + candidate parsing/validation, confidence policy, Jaccard/tokenizer, recall query builder + bounded renderer, consolidation pass-1 plan (pure diffing), pass-2 prompts, decay math. No I/O — unit-testable in isolation. |
| `extensions/utils/llmcall.ts` | **new** | The ONLY model-call primitive: `runChild({ prompt, totalMs, cwd })` — one-shot `pi --mode rpc` child with EXACT LEAF args (spec §4), `command({type:"prompt"}) → waitAgentEnd → getLastAssistantText → stop`, in-flight guard, `stderrTail()` on failure. Shared by the gate (B) and consolidation pass 2 (D). |
| `extensions/mem-dream.ts` | **new** | Consolidation execution: `runConsolidate(db, { dryRun, cap, llm })` (pass 1 from memrules + pass 2 via the `llm` fn — injectable for tests, default `llmcall.runChild`), `rebuildUserMd()`, `listConflictsDB(db)`, `applySupersedeDB(db, keep, drop)`. Exports DB-backed helpers for conflicts/supersede (memory.ts tool actions call them). |
| `extensions/memory.ts` | modify | Tool wiring (all actions; structured doX handlers; shared command-line parser `memAction`), `turn_end` auto-write hook (gate via llmcall), `before_agent_start` recall-block injection + throttle. Owns ALL read-pool DB queries. |
| `extensions/commands.ts` | modify | Existing `/memory [query]` (currently AND-joined FTS — same bug fixed in the tool) becomes the dispatcher: bare words → OR-joined recall (via `ftsEscape`); action lines (`consolidate [apply]`, `conflicts`, `promote <id>`, `supersede <keep> <drop>`, `stats`, `set <k>=<v>`, …) → `memory.ts`'s `memAction` (single source of truth for tool + command). |
| `extensions/utils/state.ts` | modify | Schema migration (idempotent `ALTER`/`CREATE IF NOT EXISTS`): column additions + `episodes` + `memlog` tables; `memSettings()`/`setMemSettings()`; low-level row helpers (`rememberRow`, `recentMemories`, `logMem`, `memlogRecent`, `appendEpisode`). |
| `~/.waywiser/mem.json` (runtime home) | new file at rest | `{ auto: true, recall: "selective", recallMaxItems: 5, recallMaxChars: 500, consolidateCap: 10, throttle: 2, gateTimeoutMs: 8000 }` — readJSON/writeJSON, same shape as `quiet.json` (gateTimeoutMs clamped to ≤ 20000 on read). |

Explicitly NOT touching: `delegate.ts`, `kanban.ts`, `cronjob.ts` (consolidation
is user/model-invoked, **not** auto-cron'd — the pack rule; a cron schedule for
it is a one-liner the user can add later via `cronjob`).

**Interface surface added** (exhaustive — the plan must not invent extras):
tool `memory` gains actions `promote`, `supersede`, `conflicts`,
`consolidate` (`dry_run` default true), `stats`, `set` (`auto`, `recall`,
`gateTimeoutMs`), and `remember` gains an optional `verbatim` param;
`list` output adds source/superseded markers. The EXISTING `/memory [query]`
command (`extensions/commands.ts`, recall via AND-joined FTS + top-8 list)
is EXTENDED into a dispatcher: bare words still recall (now OR-joined via
`ftsEscape` — fixing the same AND-join defect already fixed in the tool);
`consolidate [apply]`, `conflicts`, `promote <id>`, `supersede <keep> <drop>`,
`stats`, `set <k>=<v>` dispatch actions. New tables `memlog`, `episodes`
(§3). New file `~/.waywiser/mem.json`. Nothing else. The smoke test's 13-tool
expectation is unchanged (memory stays one tool; no NEW command name).

## 3. A — Store (schema)

`memories` gains (all nullable, all defaulted — zero migration cost on existing rows):

```sql
ALTER TABLE memories ADD COLUMN source      TEXT NOT NULL DEFAULT 'user';
   -- user (explicit /remember or gate-verified echo) | agent (auto gate) | external (web/tool-derived)
ALTER TABLE memories ADD COLUMN verbatim    TEXT;   -- the quoted speech anchor
ALTER TABLE memories ADD COLUMN valid_at    TEXT;   -- ISO; set on supersede/decay events
ALTER TABLE memories ADD COLUMN supersedes_id INTEGER;
   -- points at the row this one REPLACES (NULL = original)
```

Existing `type` column (`fact|preference|decision|lesson`) is the single
kind column — **no rewrite of existing values**, no new taxonomy.

New tables:

```sql
CREATE TABLE IF NOT EXISTS memlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,   -- write | supersede | dedup | decay | propose | inject | forget
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  summary TEXT NOT NULL,       -- ≤10 lines: what happened (facts/decisions/actions)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Writes: `episodes` appended by the consolidation job (one row per consolidated
session chunk), capped at 200 rows (oldest pruned at cap — logged). `memlog` is
append-only, never pruned (it is the audit trail; ~rows/day are tiny).

Human-facing exports (finding: files are for YOU, SQLite is the system of
record; the agent never treats a file as live memory):
- `MEMORY.md` — unchanged append-only raw log (audit).
- `USER.md` — **now generated**: header `<!-- generated by waywiser consolidate -->`,
  rebuilt from `preference` rows (conf ≥ 0.5) + one ≤10-line profile block the
  consolidation pass rewrites. Never auto-appended elsewhere.

## 4. B — Write path (gated auto-writes)

**Policy (fixed values, in `memrules.ts`):**
- `confForSource`: user `0.9`, agent `0.6`, external `0.3`.
- **External freeze**: `source='external'` rows are written but conf 0.3 →
  invisible to BOTH the digest (`confidence >= 0.5` — existing query) and the
  new recall block (same predicate, new queries). Promote with `memory
  promote <id>` (sets source=user, conf 0.9, logs). This is the MINJA gate —
  enforced in the read predicate, so even a gate bug can't leak external rows.
- Supersede, never append-and-coexist: a gate candidate returning
  `supersedes=<id>` inserts with the link and sets the old row's `valid_at` to
  now (old row stays in DB for audit, but **excluded from recall pools** when a
  live superseder exists: predicate
  `NOT EXISTS (SELECT 1 FROM memories s WHERE s.supersedes_id = m.id AND s.source != 'external')`).

**Gate trigger:** `pi.on("turn_end")` in `memory.ts`. Preconditions (any fails
→ skip silently, no logging noise): setting `auto` true; no gate call in
flight (module-level flag); `episodes`/`memlog` writable; turn contained ≥1
user message.

**Gate call contract** — extensions have no model-call primitive in pi (no
`pi.sendPrompt` to the session model from a hook — verified against the
installed dist typings), so the mechanism is the same one this codebase
already runs for kanban workers: a **one-shot `pi -p` child** via
`utils/rpc.js` `createPiRpcClient` with the existing `LEAF_ARGS`
(`--no-session --no-context-files --no-skills --no-prompt-templates
--no-themes --no-extensions`). `--no-extensions` is load-bearing: the child
runs with CORE tools ONLY — no waywiser `memory` tool — which kills the
circularity (gate child using the tool it gates) and any write side effect by
construction. Prompt = `GATE_PROMPT + buildGateInput(window)`; the handler
`waitAgentEnd(8000)`s, reads `getLastAssistantText`, `stop()`s; on timeout or
error → discard, no memlog row (a silent skip is correct: nothing useful
happened). Cost note (measured class, kanban spawns): child bootstrap ≈ 2–3 s
+ one short 27B turn; the wait runs inside the turn_end handler, so worst
case it delays the NEXT user-turn boundary by ≤ 8 s (knob
`mem.json.gateTimeoutMs`, default 8000, hard cap 20000). In-flight flag
guarantees ≤ 1 concurrent gate, so a stuck child can stall at most one turn
boundary and is killed by the timeout regardless.

Input window: last user message + last assistant message text, each truncated
to 1200 chars.

**GATE_PROMPT (in `memrules.ts`, full text is in the implementation plan):**
structural-signal rule (SelfMem-derived): store ONLY on one of — explicit
constraint/preference stated by the user; a decision or plan commitment; a
recurring failure + the fix that worked; an explicit "remember …". For each
candidate (max 2): `content` ≤500 chars, `type` ∈ fact|preference|decision|
lesson, `verbatim` = the EXACT quoted user substring the claim rests on
(≤200 chars, must appear verbatim in the window — validated client-side),
optional `supersedes=<id>` if it contradicts a listed existing memory (the
prompt includes the top-20 relevant existing rows for contradiction spotting).
Output: JSON only `{"candidates":[…]}` or `{"candidates":[]}`.

**Client-side validation (`validateCandidate`, pure — every rule reject logs a
reason to memlog kind=write, text=`REJECTED <reason>`):**
1. JSON parses; `candidates` array; len ≤ 2.
2. `content` non-empty, ≤ 500 chars, no markdown-fence trickery (contains
   `WAYWISER_MEMORY:` marker → reject, prompt-injection shape).
3. `verbatim` non-empty, ≤ 200 chars, `verbatim in window` (case-sensitive).
4. `type` in the 4-literal set.
5. `supersedes` id exists AND `id != self` AND no cycle (target doesn't
   supersedes back).
6. Dedup short-circuit: Jaccard(content, any row within Jaccard ≥ 0.85) →
   reject as duplicate (logged), **no** LLM dedup at write time.

**What writes:** validated candidates → `memories` (source=agent, conf 0.6,
verbatim, valid_at=now) + `memlog` kind=write + one `episodes` row per N=5
gated writes summarising them (cheap: concatenation, not an LLM call).
Explicit `/remember` stays source=user, conf from param (default 0.9).

**Opt-out:** `mem.json {auto:false}`; tool action `memory set auto=false`;
every auto-write is individually removable via existing `forget`.

## 5. C — Read path (relevance-selective per-turn recall)

New behavior in the existing `before_agent_start` handler, ADDITIVE to the
unchanged digest:

1. **Source of query**: latest user message, recorded by a `turn_start` hook
   (Task 0 of the plan verifies the installed `TurnStartEvent` payload against
   `node_modules/@earendil-works/pi-coding-agent` typings and wires the
   recorder to the real field; fallback if the event doesn't carry user text:
   the `turn_end` hook's `message` field is assistant-side only, so the
   fallback is a `message_end` recorder on user-typed messages; if NEITHER
   yields text in a real run, recall degrades to the digest — recall must
   never block or crash a turn).
2. **Throttle**: re-select at most once per `throttle` (default 2) user
   turns; otherwise reuse the last block byte-for-byte (cache stability).
   Query-hash dedupe on top (identical query → no re-selection).
3. **Query build** (pure, `buildRecallQuery(userText)`): split on
   whitespace/punct, drop a stopword list (~40 words), keep ≤ 8 terms,
   OR-join via existing `ftsEscape`. If < 1 term → no block.
4. **Search**: FTS5 BM25 (existing index), LIMIT `recallMaxItems` (5),
   predicate: `confidence >= 0.5 AND NOT (superseded by live row)` (§4), plus
   recency boost `* (1 + access_count * 0.0)` — no, keep it BM25-only, ties
   broken by `id DESC`. (Deliberately simple; the adversarial evidence says
   ranking cleverness at this corpus size is noise.)
5. **Render** (added AFTER the digest, in the same `systemPrompt` return.
   Distinct from the EXISTING `memory recall` tool action — that one answers
   an explicit model request; this block is the unprompted injection):

   ```
   <!-- WAYWISER RECALL (for: "<first 3 query terms>") -->
   [fact|user] <content>
   [lesson|agent] <content>
   ...up to 5 rows → hard cap at 500 chars total (drop from tail, count chars,
   not tokens — qwen tokenizer ≈ 1 token/1.5 chars EN; 500 chars ≈ safe bound)
   <!-- WAYWISER RECALL END -->
   ```

   Row = `type` + `source` tag + content, truncated per-row to 180 chars.
6. **Modes** (`mem.json.recall`): `"selective"` (above, default) · `"top8"`
   (today's digest only) · `"off"` (nothing injected) — the built-in A/B
   switch. Injection events log `memlog` kind=inject with query terms (one row
   per NEW selection, not per turn).
7. **Cost bound**: zero LLM calls in the read path (BM25 only). The one gate
   LLM call is in the write path. → per-turn added latency ≈ 0 ms.

**Why not an LLM per-turn selector (recorded decision):** the EMNLP
degradation + small-model penalty + one extra 27B round-trip per turn (≈ 2–4 s
on this box, measured class) isn't justified at 1k–5k items where BM25 wins or
ties vectors. If logged `inject` events later show recall misses on
synonym-heavy queries, the upgrade path is a *throttled* LLM selector reusing
the gate child — designed out now, built only on evidence.

## 6. D — Consolidation ("dreaming", shrunken)

Invoked explicitly: tool action `consolidate` (param `dry_run`, default true —
**dry-run is the default on an audit-first principle**: it prints the change
list; `dry_run=false` applies) + `/memory consolidate [apply]` command. No
auto-schedule (pack rule: no hidden automation; user can cron it in one line).

**Pass 1 — pure SQLite, deterministic (row count unbounded; pass-2 work is list-capped below):**
- exact-duplicate: `GROUP BY lower(replace(content,' ',''))` > 1 → keep min(id),
  others become superseded (logged `dedup`); links preserved.
- near-duplicate: pairwise Jaccard ≥ 0.8 on token multisets within the
  conf ≥ 0.3 pool (pair list is O(n²) — fine at ≤ 5k; spec floor: at > 10k the
  pass aborts with a message telling the user to delete old rows; no
  infrastructure invented).
- supersede-orphan cleanup: a `supersedes_id` pointing at a deleted row →
  nulled (logged).
- staleness decay: rows with `confidence ≥ 0.5`, `type='fact'`,
  `last_accessed` > 180 days ago → conf 0.3 (logged `decay`; drops them from
  pools; reversible via `remember` re-write — decay never deletes).

Pass-1 output (dry-run): the full change list as text; `apply` executes and
writes per-change `memlog` rows.

**Pass 2 — LLM-capped (only if 1+ near-dup or contradiction candidate):**
two call types, each ≤ `consolidateCap` (10) pairs per run, same one-shot
isolated child as the gate (reused, sequential, 60 s each):
- **merge** (near-dups): input = the two rows + "merge into one line of ≤ 200
  chars preserving BOTH facts; JSON `{"merged": "…"}` or `{"merged": null}`".
  Applied on success: merged row (source of the LOWER-id row's source if they
  differ, else agent), both originals superseded with valid_at, logged.
- **conflict** (two rows sharing ≥ 2 key tokens AND a `memrules.conflictPair`
  heuristic flags opposite assertions — the heuristic is a keyword negation
  check, deliberately crude; it only PREPARES pairs, the LLM judges):
  output JSON `{"conflict": true|false, "prefer_id": n, "reason": "…"}`.
  `true` → **never auto-applied**; logged `memlog` kind=propose; surfaced by
  `memory conflicts` and `/memory conflicts`; user resolves with
  `memory supersede <keep_id> <drop_id>` (new action) → logs `supersede`.

After any apply: rebuild USER.md export; final response summarizes
(N applied, M proposed, K deduped).

## 7. YAGNI record (cut, with reasons — reviewed against the counter-probe)

| Cut | Why |
|---|---|
| sqlite-vec / embeddings | BM25 ≥ vectors at 1k–5k; adds an embed model dependency to this box |
| Graph / A-MEM / HippoRAG | multi-hop machinery is the wrong tool < 10k passages; no entity index exists today |
| 4-store tiered taxonomy | recall quality, not storage shape, is the bottleneck; single `type` col survives |
| Per-turn LLM recall selector | cost vs measured benefit at this corpus; evidence-gated upgrade path named (§5.7) |
| Spaced repetition, episodic replay-priming | no peer-reviewed evidence found for agent memory; analogies only |
| Auto cron for consolidate | pack rule: explicit automation only |
| Full MemGPT core-memory rewrite | vendor preprint, unreplicated + chatGPT-collapse cautionary tale → deterministic-first, user-confirm |
| Memory "verification second pass" per write | doubles write cost; the verbatim-anchor + Jaccard-dedup gate covers the dominant HaluMem failure at this scale |

## 8. Verification (each task's gate is in the plan; whole-feature proof)

1. **Unit**: gate validation matrix (each §4 rule → accept/reject case),
   `confForSource`, Jaccard, decay, supersede-predicate SQL, external-freeze
   (external row written → `recall` and digest both exclude it; `promote`
   brings it back).
2. **Poisoning test** (dedicated): a web-extracted line is staged as a
   candidate with `source=external` → assert absent from all read paths until
   explicit promote; assert a `WAYWISER_MEMORY:` marker payload is rejected.
3. **Live in-sandbox** (`WAYWISER_HOME=/tmp/ww-mem`): session 1 states a
   preference mid-conversation with no `/remember` → session 2, unrelated
   topic, ask about it → answer must come from recall block (model cites
   source=agent row); assert `memlog` write+inject rows exist; assert digest
   unchanged byte-for-byte between turns (cache check: diff the
   before_agent_start output).
4. **A/B**: `recall=top8` vs `selective` over the same 3-sandbox sessions,
   switched with `memory set recall=<mode>`; the NEW tool action `stats`
   reports counts by source/type/confidence-band + memlog write/inject counts
   — the standing baseline the evidence requires (one tool action, not a
   cron ritual).
5. **Consolidation**: seed 40 rows (5 exact dups, 3 near-dups, 1 seeded
   conflict, 2 external, 1 stale) → dry-run output matches expected list
   exactly; `apply` mutates exactly those rows + logs; conflicts surface with
   `conflicts`; USER.md regenerates.
6. Full suite green (existing 22 + new) and a live `waywiser -p` smoke that
   registers the extension without error (smoke test's 13-tool expectation
   unchanged — `memory` stays ONE tool; `kanban`/`cronjob` untouched).

## 9. Evidence register (for the audit trail)

Write-gating: SelfMem arXiv:2607.03726 (preprint) · MOSAIC arXiv:2607.16211
(extraction recall 83.94% / acc 72.00%) · HBS AI Institute selective-memory
study (unfiltered worse than none) · MemoryAgentBench arXiv:2507.05257.
Poisoning: MINJA 2025 (query-only, ~95% plant success) · Unit 42 Bedrock
PoC Oct 2025. Degradation: EMNLP 2025 arXiv:2510.05381 (context-length
degradation) · lost-in-the-middle. Procedures: Voyager arXiv:2305.16291 ·
Reflexion arXiv:2303.11366 (peer-reviewed mechanism; cross-session port =
practitioner-level, flagged). Consolidation caution: ChatGPT memory-collapse
Feb 2025 (practitioner) · Letta sleep-time arXiv:2504.13171 (vendor preprint,
unreplicated — borrowed as a *batch job*, not a theorem). Retrieval: WANDS
hybrid benchmark (large-corpus only) · r/AI_Agents builder reports (semantic
search needs more data than expected). User model: PersonaMem
arXiv:2504.14225 (isolated benchmark; no head-to-head vs flat facts exists —
flagged as the next item to test on 1 month of real sessions).
Dropped/flagged: "semantic pointers without embeddings (Lazaric 2025)" —
**NOT locatable via vsearch; treated as unverified and NOT used in this
design.**
