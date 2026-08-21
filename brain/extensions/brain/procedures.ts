/**
 * waywiser-brain — procedural memory: evidence tracking and maturity.
 *
 * Procedures encode "when X happens, doing Y is more effective than Z" —
 * kept separate from semantic memories because a procedure is a claim
 * about effectiveness that has to earn trust through repeated observation,
 * not a single assertion. This module is the only place that turns a
 * LearningResult's `procedureUpdates` into durable `procedures` rows: for
 * each update it upserts the procedure (creating it on first sighting),
 * records an evidence row, recomputes confidence with a simple
 * Bayesian-ish update, and re-derives the procedure's status
 * (tentative → reinforced → mature, or contradicted/retired when the
 * evidence turns against it) from the accumulated counts.
 */
import { randomUUID } from "node:crypto";
import type { BrainConfig, Experience, LearningResult, Procedure, ProcedureStatus } from "./types.ts";
import type { BrainStore } from "./store.ts";
import { generateProcedureKey } from "./learner.ts";

// ---------------------------------------------------------------------------
// Evidence intake
// ---------------------------------------------------------------------------

/**
 * Process procedure updates from a learning result. For each
 * `procedureUpdate`: upsert the procedure (creating it with neutral
 * defaults if this is the first time this key is seen), record the
 * evidence row, then recompute confidence and status from the evidence
 * accumulated so far.
 *
 * `experience` is accepted (rather than just an id) so this function's
 * signature mirrors the rest of the learning pipeline, but it isn't read
 * directly — every `procedureUpdate` already carries its own
 * `experienceId`/`observationId`, which is what evidence is recorded
 * against.
 *
 * `config` supplies the maturity thresholds `deriveProcedureStatus` needs;
 * `BrainStore` has no config of its own, so callers must pass the same
 * `BrainConfig` the rest of the pipeline is using.
 */
export function updateProcedureEvidence(
  experience: Experience,
  learning: LearningResult,
  store: BrainStore,
  config: BrainConfig,
): void {
  void experience;

  for (const update of learning.procedureUpdates) {
    const key = update.key?.trim() || generateProcedureKey(update.triggerText, update.avoidText, update.preferText);

    let proc = store.getProcedure(key);

    if (!proc) {
      store.upsertProcedure({
        id: `proc_${randomUUID()}`,
        key,
        triggerText: update.triggerText,
        avoidText: update.avoidText,
        preferText: update.preferText,
        confidence: 0.5,
        status: "tentative",
        scope: "global",
        projectKey: null,
      });
      proc = store.getProcedure(key)!;
    }

    // Record the evidence row. This also bumps success_count/failure_count
    // on the procedures row itself, so `proc`'s counts (fetched above,
    // before this call) are the pre-update counts.
    store.recordProcedureEvidence(proc.id, update.experienceId, update.observationId, update.outcome);

    const newConfidence = updateProcedureConfidence(proc.confidence, update.outcome);

    const evidenceCount = store.db
      .prepare("SELECT COUNT(DISTINCT experience_id) as cnt FROM procedure_evidence WHERE procedure_id = ?")
      .get(proc.id) as { cnt: number };
    const distinctExperiences = evidenceCount.cnt;

    const newStatus = deriveProcedureStatus(
      {
        successCount: proc.successCount + (update.outcome === "success" ? 1 : 0),
        failureCount: proc.failureCount + (update.outcome === "failure" ? 1 : 0),
        status: proc.status,
      },
      distinctExperiences,
      config,
    );

    store.upsertProcedure({
      id: proc.id,
      key: proc.key,
      triggerText: update.triggerText || proc.triggerText,
      avoidText: update.avoidText ?? proc.avoidText,
      preferText: update.preferText ?? proc.preferText,
      confidence: newConfidence,
      status: newStatus,
      scope: proc.scope,
      projectKey: proc.projectKey,
    });
  }
}

// ---------------------------------------------------------------------------
// Confidence update
// ---------------------------------------------------------------------------

/**
 * Update a procedure's confidence based on a new outcome, using a simple
 * Bayesian-ish update:
 * - success: confidence += (1 - confidence) * 0.1  (approaches 1, slower as it climbs)
 * - failure: confidence -= confidence * 0.15        (approaches 0, slower as it falls)
 * Bounded to [0.1, 0.99] so a procedure is never fully certain nor fully
 * discounted by confidence alone — status transitions (contradicted,
 * retired) are what actually stop a procedure from being recalled.
 */
export function updateProcedureConfidence(
  currentConfidence: number,
  outcome: "success" | "failure",
): number {
  const next =
    outcome === "success"
      ? currentConfidence + (1 - currentConfidence) * 0.1
      : currentConfidence - currentConfidence * 0.15;
  return Math.max(0.1, Math.min(0.99, next));
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

/**
 * Determine a procedure's status from its evidence counts:
 * - retired: failures overwhelm successes (>2x) once there's enough data (4+ observations)
 * - contradicted: failures outnumber successes once there's enough data (3+ observations)
 * - mature: meets all configured maturity thresholds (positive observations,
 *   independent experiences, success ratio, no-contradiction requirement)
 * - reinforced: 2+ independent experiences and 2+ successes
 * - tentative: anything else (the default for a newly observed procedure)
 *
 * `retired`'s condition (failures > 2x successes) always implies
 * `contradicted`'s weaker condition (failures > successes), so retired is
 * checked first — otherwise a procedure whose evidence overwhelmingly
 * contradicts it would only ever be reported as "contradicted" the moment
 * total reaches 3, and "retired" would never be reachable.
 *
 * Contradiction/retirement are both checked before maturity/reinforcement
 * so a procedure whose evidence has turned decisively negative is never
 * reported as mature or reinforced just because it also racked up early
 * successes.
 */
export function deriveProcedureStatus(
  proc: { successCount: number; failureCount: number; status: ProcedureStatus },
  distinctExperiences: number,
  config: BrainConfig,
): ProcedureStatus {
  const total = proc.successCount + proc.failureCount;

  if (proc.failureCount > proc.successCount * 2 && total >= 4) {
    return "retired";
  }

  if (proc.failureCount > proc.successCount && total >= 3) {
    return "contradicted";
  }

  const maturity = config.evolution.maturity;
  const successRatio = total === 0 ? 1 : proc.successCount / total;

  if (
    proc.successCount >= maturity.minPositiveObservations &&
    distinctExperiences >= maturity.minIndependentExperiences &&
    successRatio >= maturity.minSuccessRatio &&
    (!maturity.requireNoContradictions || proc.status !== "contradicted")
  ) {
    return "mature";
  }

  if (distinctExperiences >= 2 && proc.successCount >= 2) {
    return "reinforced";
  }

  return "tentative";
}

// ---------------------------------------------------------------------------
// Maturity check
// ---------------------------------------------------------------------------

/**
 * Check if a procedure meets maturity thresholds for skill candidacy —
 * i.e. whether `deriveProcedureStatus` would currently classify it as
 * "mature" given its stored evidence counts and the caller-supplied count
 * of distinct experiences that observed it.
 */
export function checkMaturity(proc: Procedure, distinctExperiences: number, config: BrainConfig): boolean {
  return (
    deriveProcedureStatus(
      { successCount: proc.successCount, failureCount: proc.failureCount, status: proc.status },
      distinctExperiences,
      config,
    ) === "mature"
  );
}
