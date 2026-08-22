/**
 * waywiser-brain — consolidation.
 *
 * Evolved from Waywiser's `mem-dream.ts`, but operating over the full Brain
 * state (memories, procedures, and their evidence) rather than just the
 * memories table. Runs in four phases:
 *
 *   1. Deterministic cleanup (no LLM): mark memories superseded by a newer
 *      active version, archive memories nobody's touched in 90+ days
 *      (never user-stated ones — those are only retired by the human who
 *      stated them), retire procedures whose failures swamp their
 *      successes.
 *   2. Near-duplicate merging (LLM): cluster active memories by lexical
 *      (Jaccard) overlap, ask the cognition pool whether each cluster is
 *      really saying the same thing and, if so, for one merged line;
 *      supersede every memory in the cluster except the kept one.
 *   3. Contradiction detection (LLM): scan high-confidence memory pairs
 *      that share some lexical overlap for direct conflicts. This phase
 *      never auto-resolves anything — a detected conflict is logged to
 *      `brain_log` as a pending contradiction for a human (or a later
 *      learner pass) to act on.
 *   4. Procedure maturity flagging: re-derive maturity (via
 *      `checkMaturity`) for every tentative/reinforced procedure and
 *      promote it to `mature` when it now qualifies.
 *
 * Phases 2 and 3 need a live `CognitionPool` to talk to the model. Callers
 * that pass `pool: null` (as tests do, to stay fully deterministic and
 * offline) get phases 1 and 4 only — near-duplicate merging and
 * contradiction detection are skipped, not stubbed.
 */
import type { BrainStore } from "./store.ts";
import type { CognitionPool } from "./cognition.ts";
import type { BrainConfig, BrainMemory, Procedure, ConsolidationReport } from "./types.ts";
import { consolidatePrompt, contradictionPrompt } from "./prompts.ts";
import { checkMaturity } from "./procedures.ts";

// ---------------------------------------------------------------------------
// Lexical similarity (shared by near-dup clustering and contradiction gating)
// ---------------------------------------------------------------------------

/**
 * Token-set Jaccard similarity between two strings: lowercase runs of 2+
 * Unicode letters/digits/underscore are the tokens. Returns 0 (rather than
 * NaN) when either side has no tokens at all.
 */
function jaccard(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []);
  const tokensB = new Set(b.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let inter = 0;
  for (const t of tokensA) if (tokensB.has(t)) inter++;
  return inter / (tokensA.size + tokensB.size - inter);
}

// ---------------------------------------------------------------------------
// Phase 1: Deterministic cleanup (no LLM)
// ---------------------------------------------------------------------------

/**
 * Run the deterministic (non-LLM) consolidation phase in isolation.
 * Exported so it can be tested — and run — without a `CognitionPool`.
 * `config` is accepted for signature parity with the LLM-backed phases;
 * phase 1's thresholds (90-day staleness, 7-day procedure grace period,
 * the 2x failure/success retirement ratio) are fixed policy, not
 * currently config-driven.
 */
export function deterministicCleanup(
  store: BrainStore,
  config: BrainConfig,
): { supersededRemoved: number; staleArchived: number; proceduresRetired: number } {
  void config;

  let supersededRemoved = 0;
  let staleArchived = 0;
  let proceduresRetired = 0;

  // 1. Mark memories superseded by a newer *active* version. A memory can
  // name a supersedes_id without the successor having landed yet (or the
  // successor itself having since been superseded/archived) — only an
  // active successor actually retires the predecessor here.
  const superseded = store.db
    .prepare(
      `SELECT m.id FROM memories m
       WHERE EXISTS (SELECT 1 FROM memories s WHERE s.supersedes_id = m.id AND s.status = 'active')
       AND m.status = 'active'`,
    )
    .all() as Array<{ id: number }>;

  for (const { id } of superseded) {
    store.db.prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").run(id);
    supersededRemoved++;
  }

  // 2. Archive memories not accessed in 90+ days. User-stated memories are
  // never auto-archived — the human who stated them is the only one who
  // retires them.
  const staleDays = 90;
  const staleDate = new Date(Date.now() - staleDays * 86400000).toISOString();
  const stale = store.db
    .prepare(
      `SELECT id FROM memories
       WHERE status = 'active'
       AND last_accessed < ?
       AND source != 'user'`,
    )
    .all(staleDate) as Array<{ id: number }>;

  for (const { id } of stale) {
    store.db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(id);
    staleArchived++;
  }

  // 3. Retire procedures whose failures overwhelm successes (>2x) once
  // they've had at least a week to accumulate evidence and have enough
  // observations (4+) for the ratio to be meaningful.
  const retireDate = new Date(Date.now() - 7 * 86400000).toISOString();
  const toRetire = store.db
    .prepare(
      `SELECT id FROM procedures
       WHERE status NOT IN ('retired', 'mature')
       AND failure_count > success_count * 2
       AND (success_count + failure_count) >= 4
       AND created_at < ?`,
    )
    .all(retireDate) as Array<{ id: string }>;

  for (const { id } of toRetire) {
    store.db.prepare("UPDATE procedures SET status = 'retired', updated_at = datetime('now') WHERE id = ?").run(id);
    proceduresRetired++;
  }

  return { supersededRemoved, staleArchived, proceduresRetired };
}

// ---------------------------------------------------------------------------
// Phase 2: Near-duplicate clustering (deterministic clustering; LLM merges)
// ---------------------------------------------------------------------------

/**
 * Find near-duplicate memory clusters among active memories using
 * Jaccard-based lexical similarity (same approach as Waywiser's existing
 * `mem-dream.ts`). Each returned cluster has 2+ memories whose content
 * overlaps at or above the 0.7 similarity threshold; a memory is placed in
 * at most one cluster. Stops once `limit` clusters have been found.
 */
export function findNearDuplicateClusters(store: BrainStore, limit: number = 20): Array<BrainMemory[]> {
  const memories = store.db.prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY id").all() as BrainMemory[];

  if (memories.length < 2) return [];

  const clusters: Array<BrainMemory[]> = [];
  const used = new Set<number>();

  for (let i = 0; i < memories.length && clusters.length < limit; i++) {
    if (used.has(memories[i].id)) continue;
    const cluster = [memories[i]];

    for (let j = i + 1; j < memories.length; j++) {
      if (used.has(memories[j].id)) continue;
      if (jaccard(memories[i].content, memories[j].content) >= 0.7) {
        cluster.push(memories[j]);
        used.add(memories[j].id);
      }
    }

    if (cluster.length >= 2) {
      used.add(memories[i].id);
      clusters.push(cluster);
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Full consolidation pass
// ---------------------------------------------------------------------------

/**
 * Run a full consolidation pass.
 *
 * Phase 1: Deterministic cleanup (no LLM).
 * Phase 2: Near-duplicate detection and merging (LLM; skipped if `pool` is
 *          `null` or `config.consolidation.dryRunByDefault` is true).
 * Phase 3: Contradiction detection (LLM; same skip condition as phase 2).
 * Phase 4: Procedure maturity flagging (no LLM).
 *
 * Always logs the human-readable report to `brain_log` (kind
 * `"consolidation"`) before returning it.
 */
export async function consolidate(
  store: BrainStore,
  pool: CognitionPool | null,
  config: BrainConfig,
): Promise<ConsolidationReport> {
  const report: ConsolidationReport = {
    supersededRemoved: 0,
    staleArchived: 0,
    nearDuplicatesMerged: 0,
    contradictionsFound: 0,
    proceduresRetired: 0,
    proceduresFlaggedMature: 0,
    report: "",
  };

  // Phase 1: Deterministic cleanup.
  const p1 = deterministicCleanup(store, config);
  report.supersededRemoved = p1.supersededRemoved;
  report.staleArchived = p1.staleArchived;
  report.proceduresRetired = p1.proceduresRetired;

  const runLlmPhases = pool !== null && !config.consolidation.dryRunByDefault;

  // Phase 2: Near-duplicate merging.
  if (runLlmPhases) {
    const clusters = findNearDuplicateClusters(store, 10);
    for (const cluster of clusters) {
      try {
        const prompt = consolidatePrompt(cluster);
        const raw = await pool!.runConsolidation(prompt, config.learning.gateTimeoutMs);
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) continue;
        const parsed = JSON.parse(match[0]) as { merged: string | null; keepId?: number };
        if (parsed.merged && parsed.keepId) {
          // Supersede every memory in the cluster except the kept one,
          // and overwrite the kept one's content with the merged line.
          for (const mem of cluster) {
            if (mem.id === parsed.keepId) {
              store.db
                .prepare("UPDATE memories SET content = ?, last_accessed = datetime('now') WHERE id = ?")
                .run(parsed.merged, mem.id);
            } else {
              store.db
                .prepare("UPDATE memories SET status = 'superseded', supersedes_id = ? WHERE id = ?")
                .run(parsed.keepId, mem.id);
            }
          }
          report.nearDuplicatesMerged++;
        }
      } catch {
        // LLM failure (timeout, bad JSON, non-zero exit) — skip this
        // cluster and keep consolidating the rest.
      }
    }
  }

  // Phase 3: Contradiction detection. Capped at 5 findings per run so a
  // large memory store can't turn one consolidation pass into an
  // unbounded number of LLM calls.
  if (runLlmPhases) {
    const highConf = store.db
      .prepare("SELECT * FROM memories WHERE status = 'active' AND confidence >= 0.7 ORDER BY id LIMIT ?")
      .all(config.consolidation.batchSize) as BrainMemory[];

    outer: for (let i = 0; i < highConf.length; i++) {
      for (let j = i + 1; j < highConf.length; j++) {
        if (report.contradictionsFound >= 5) break outer;
        // Only check pairs with some lexical overlap — an unrelated pair
        // can't be a contradiction, and skipping them keeps the LLM call
        // count down.
        if (jaccard(highConf[i].content, highConf[j].content) < 0.3) continue;
        try {
          const prompt = contradictionPrompt(highConf[i], highConf[j]);
          const raw = await pool!.runConsolidation(prompt, config.learning.gateTimeoutMs);
          const match = raw.match(/\{[\s\S]*\}/);
          if (!match) continue;
          const parsed = JSON.parse(match[0]) as { conflict: boolean; keepId?: number; reason?: string };
          if (parsed.conflict) {
            // Don't auto-resolve — log as a pending contradiction for a
            // human (or a later learner pass) to act on.
            store.logBrain(
              "contradiction",
              JSON.stringify({
                memA: highConf[i].id,
                memB: highConf[j].id,
                reason: parsed.reason || "unknown",
                keepId: parsed.keepId,
              }),
            );
            report.contradictionsFound++;
          }
        } catch {
          // LLM failure — skip this pair, keep scanning.
        }
      }
    }
  }

  // Phase 4: Procedure maturity flagging. Fetched by id and re-read through
  // `getProcedureById` (rather than casting the raw `procedures` row
  // directly) so `checkMaturity` sees the properly camelCased
  // `successCount`/`failureCount` it reads — a raw row only has the
  // snake_case `success_count`/`failure_count` columns, which would
  // silently evaluate as `undefined` and make every procedure look
  // immature.
  const procedureIds = store.db
    .prepare("SELECT id FROM procedures WHERE status IN ('tentative', 'reinforced')")
    .all() as Array<{ id: string }>;

  for (const { id } of procedureIds) {
    const proc: Procedure | null = store.getProcedureById(id);
    if (!proc) continue;

    const evidenceCount = store.db
      .prepare("SELECT COUNT(DISTINCT experience_id) as cnt FROM procedure_evidence WHERE procedure_id = ?")
      .get(proc.id) as { cnt: number };

    if (checkMaturity(proc, evidenceCount.cnt, config)) {
      store.db.prepare("UPDATE procedures SET status = 'mature', updated_at = datetime('now') WHERE id = ?").run(proc.id);
      report.proceduresFlaggedMature++;
    }
  }

  // Build the human-readable report.
  const lines = ["# Consolidation Report", `Date: ${new Date().toISOString()}`, ""];
  if (report.supersededRemoved) lines.push(`- Superseded memories removed: ${report.supersededRemoved}`);
  if (report.staleArchived) lines.push(`- Stale memories archived: ${report.staleArchived}`);
  if (report.nearDuplicatesMerged) lines.push(`- Near-duplicates merged: ${report.nearDuplicatesMerged}`);
  if (report.contradictionsFound) lines.push(`- Contradictions found (pending review): ${report.contradictionsFound}`);
  if (report.proceduresRetired) lines.push(`- Procedures retired: ${report.proceduresRetired}`);
  if (report.proceduresFlaggedMature) lines.push(`- Procedures flagged mature: ${report.proceduresFlaggedMature}`);
  if (lines.length === 3) lines.push("- No changes needed.");
  report.report = lines.join("\n");

  // Log the consolidation run.
  store.logBrain("consolidation", report.report);

  return report;
}
