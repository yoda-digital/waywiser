/**
 * waywiser-brain — evolution pipeline.
 *
 * Connects procedures, skills, and eval into the full evolution loop:
 *
 *   1. `checkEvolutionTriggers` scans for mature procedures that haven't
 *      already been compiled into a candidate/evaluating/active skill, and
 *      runs the pipeline for each. Called after each learning pass at
 *      `agent_settled`.
 *   2. `compileSkillFromProcedure` asks the cognition pool's skill-compiler
 *      lane to turn a mature procedure (plus its recent evidence) into a
 *      SKILL.md body.
 *   3. `validateSkillCandidate` is a pure, deterministic gate on that
 *      body — size, frontmatter shape, and a forbidden-directive denylist —
 *      run before anything is ever written to disk or evaluated.
 *   4. `runEvolutionPipeline` chains compile → validate → write candidate →
 *      evaluate → accept/reject for one procedure, recording an
 *      `EvolutionRun` row regardless of where it stops.
 *   5. `promotePending`, called at a session boundary (not from within the
 *      pipeline itself), promotes every candidate with a passed evolution
 *      run — unless `config.evolution.promotionPolicy` is `"manual"`.
 *
 * Rejection and promotion of a *specific* candidate happen immediately
 * (rejection inside `runEvolutionPipeline`, since a failed candidate has no
 * reason to wait); auto-promotion of *passed* candidates is deferred to
 * `promotePending` so a new skill version never appears mid-session out
 * from under a running agent.
 */
import * as crypto from "node:crypto";
import type { BrainConfig, EvolutionRun, Procedure } from "./types.ts";
import type { BrainStore } from "./store.ts";
import type { CognitionPool } from "./cognition.ts";
import { compileSkillPrompt } from "./prompts.ts";
import { writeCandidate, promoteCandidate, rejectCandidate } from "./skills.ts";
import { generateEvalCases, runEvaluation } from "./eval.ts";

// ---------------------------------------------------------------------------
// validateSkillCandidate
// ---------------------------------------------------------------------------

/** Directives a compiled skill must never contain — these are the brain's
 * own governance surface (kernel behavior, evaluation policy, provenance
 * trust, SOUL principles) and a skill compiled from procedural evidence has
 * no business touching any of them. Checked against the whole document
 * (not just the body) so a directive smuggled into the frontmatter is
 * still caught. */
const FORBIDDEN_PATTERNS = [
  /modify.*brain.*kernel/i,
  /rewrite.*policy/i,
  /change.*evaluation.*rules/i,
  /override.*provenance/i,
  /modify.*SOUL/i,
];

/**
 * Validate a candidate SKILL.md before it is written to disk or evaluated.
 * Checks (in order, first failure wins):
 *   - non-empty content
 *   - <= 10KB (UTF-8 byte length, not character length)
 *   - has a `---`-fenced frontmatter block
 *   - frontmatter has both `name:` and `description:`
 *   - no forbidden directive anywhere in the document
 */
export function validateSkillCandidate(skillMd: string): { valid: boolean; reason: string } {
  if (!skillMd || !skillMd.trim()) {
    return { valid: false, reason: "empty content" };
  }

  if (Buffer.byteLength(skillMd, "utf-8") > 10240) {
    return { valid: false, reason: "exceeds 10KB size limit" };
  }

  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return { valid: false, reason: "missing frontmatter" };
  }

  const fm = fmMatch[1];
  if (!fm.includes("name:")) {
    return { valid: false, reason: "frontmatter missing name" };
  }
  if (!fm.includes("description:")) {
    return { valid: false, reason: "frontmatter missing description" };
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(skillMd)) {
      return { valid: false, reason: `contains forbidden directive: ${pattern.source}` };
    }
  }

  return { valid: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// compileSkillFromProcedure
// ---------------------------------------------------------------------------

/**
 * Compile a mature procedure into a candidate SKILL.md via the cognition
 * pool's skill-compiler lane. Pulls the procedure's 10 most recent evidence
 * rows to ground the prompt in real outcomes rather than the procedure's
 * bare trigger/avoid/prefer text alone.
 *
 * Returns `null` (rather than throwing) when the compiler produces no
 * usable output or the cognition pool call fails/times out — the caller
 * treats that as a soft failure that still gets recorded as a failed
 * `EvolutionRun`, not an exception that aborts the whole trigger sweep.
 */
export async function compileSkillFromProcedure(
  proc: Procedure,
  store: BrainStore,
  pool: CognitionPool,
  config: BrainConfig,
): Promise<{ skillMd: string; metadata: { sourceProcedureIds: string[] } } | null> {
  const evidence = store.db
    .prepare(
      "SELECT experience_id, outcome, observation_id FROM procedure_evidence WHERE procedure_id = ? ORDER BY created_at DESC LIMIT 10",
    )
    .all(proc.id) as Array<{ experience_id: string; outcome: string; observation_id: string | null }>;

  const mappedEvidence = evidence.map((e) => ({
    experienceId: e.experience_id,
    outcome: e.outcome,
    observationId: e.observation_id,
  }));

  const prompt = compileSkillPrompt(proc, mappedEvidence);

  try {
    const raw = await pool.runSkillCompiler(prompt, config.learning.gateTimeoutMs);
    if (!raw.trim()) return null;

    return {
      skillMd: raw.trim(),
      metadata: { sourceProcedureIds: [proc.id] },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// runEvolutionPipeline
// ---------------------------------------------------------------------------

function failedRun(id: string, reason: string): EvolutionRun {
  const now = new Date().toISOString();
  return {
    id,
    skillVersionId: "",
    baselineVersionId: null,
    status: "failed",
    resultJson: JSON.stringify({ reason }),
    createdAt: now,
    completedAt: now,
  };
}

/**
 * Run the full evolution pipeline for one procedure: compile → validate →
 * write candidate → generate/reuse eval cases → evaluate against the
 * current active baseline (if any) → accept or reject. Always records
 * (and returns) an `EvolutionRun` row, even when the pipeline stops at
 * compilation or validation before a candidate ever exists on disk.
 *
 * A passing candidate is NOT promoted here — see the module doc comment.
 * A failing candidate IS rejected immediately (moved to `retired/` with
 * status `"rejected"`), since there's no reason to keep a known-bad
 * candidate around until the next session boundary.
 */
export async function runEvolutionPipeline(
  proc: Procedure,
  store: BrainStore,
  pool: CognitionPool,
  config: BrainConfig,
): Promise<EvolutionRun> {
  const runId = `evo_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  // 1. Compile skill from procedure.
  const compiled = await compileSkillFromProcedure(proc, store, pool, config);
  if (!compiled) {
    const run = failedRun(runId, "compilation failed");
    store.insertEvolutionRun(run);
    return run;
  }

  // 2. Validate.
  const validation = validateSkillCandidate(compiled.skillMd);
  if (!validation.valid) {
    const run = failedRun(runId, `validation failed: ${validation.reason}`);
    store.insertEvolutionRun(run);
    return run;
  }

  // 3. Write candidate.
  const sv = writeCandidate(proc.key, compiled.skillMd, compiled.metadata.sourceProcedureIds, config, store);

  // 4. Generate eval cases if there aren't enough yet.
  let cases = store.getEvalCases(proc.key);
  if (cases.length < config.evolution.evalCasesPerCandidate) {
    generateEvalCases(proc, store, config.evolution.evalCasesPerCandidate);
    cases = store.getEvalCases(proc.key);
  }

  // 5. Find baseline (the currently active version of this skill, if any).
  const activeVersions = store.getActiveSkills().filter((s) => s.name === proc.key);
  const baseline = activeVersions.length ? activeVersions[0] : null;

  // 6. Run competitive evaluation.
  const verdict = await runEvaluation(sv, baseline, store, pool, config);

  // 7. Record the evolution run.
  const run: EvolutionRun = {
    id: runId,
    skillVersionId: sv.id,
    baselineVersionId: baseline?.id || null,
    status: verdict.pass ? "passed" : "failed",
    resultJson: JSON.stringify(verdict),
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  store.insertEvolutionRun(run);

  // 8. Handle the result per promotion policy.
  if (!verdict.pass) {
    rejectCandidate(sv.name, sv.versionHash, config, store);
    store.logBrain("evolution-rejected", `${proc.key}: ${verdict.details}`, run.id);
  } else if (config.evolution.promotionPolicy === "auto") {
    // Auto-promote, but only at the next session boundary via
    // promotePending() — never immediately from inside the pipeline.
    store.logBrain("evolution-passed", `${proc.key}: ready for promotion`, run.id);
  } else {
    store.logBrain("evolution-passed", `${proc.key}: awaiting manual promotion`, run.id);
  }

  return run;
}

// ---------------------------------------------------------------------------
// checkEvolutionTriggers
// ---------------------------------------------------------------------------

/**
 * Check for mature procedures that haven't been compiled into a candidate
 * (or evaluating/active) skill yet, and run the evolution pipeline for
 * each. Called after each learning pass at `agent_settled`.
 *
 * A per-procedure failure (thrown by `runEvolutionPipeline` itself, as
 * opposed to a soft "failed" `EvolutionRun` it returns normally) is caught
 * and logged rather than aborting the sweep — one broken procedure should
 * never block the rest from evolving.
 */
export async function checkEvolutionTriggers(
  store: BrainStore,
  pool: CognitionPool,
  config: BrainConfig,
): Promise<void> {
  if (!config.modules.evolve) return;

  const mature = store.db
    .prepare(
      `SELECT p.* FROM procedures p
       WHERE p.status = 'mature'
       AND NOT EXISTS (
         SELECT 1 FROM skill_versions sv
         WHERE sv.source_procedure_ids LIKE '%' || p.id || '%'
         AND sv.status IN ('candidate', 'evaluating', 'active')
       )`,
    )
    .all() as Array<Record<string, unknown>>;

  for (const row of mature) {
    const proc: Procedure = {
      id: String(row.id),
      key: String(row.key),
      triggerText: String(row.trigger_text),
      avoidText: row.avoid_text ? String(row.avoid_text) : null,
      preferText: row.prefer_text ? String(row.prefer_text) : null,
      confidence: Number(row.confidence),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      status: row.status as Procedure["status"],
      scope: row.scope as Procedure["scope"],
      projectKey: row.project_key ? String(row.project_key) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };

    try {
      await runEvolutionPipeline(proc, store, pool, config);
    } catch (err) {
      store.logBrain("evolution-error", `Failed to evolve ${proc.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// promotePending
// ---------------------------------------------------------------------------

/**
 * Promote every candidate skill that has a passed `EvolutionRun`. Called at
 * a session boundary (`session_shutdown` or `session_start`) rather than
 * immediately after evaluation, so a running agent never sees its skills
 * change mid-session.
 *
 * A no-op when `config.evolution.promotionPolicy` is `"manual"` — under
 * that policy a human decides when (and whether) to run
 * `promoteCandidate`/`rejectCandidate` directly. `"auto"` and `"confirm"`
 * both promote here; `"confirm"`'s human-in-the-loop step (if any) belongs
 * to the caller that decides whether to invoke `promotePending` at all, not
 * to this function.
 */
export function promotePending(store: BrainStore, config: BrainConfig): void {
  if (config.evolution.promotionPolicy === "manual") return;

  const passed = store.db
    .prepare(
      `SELECT sv.* FROM skill_versions sv
       JOIN evolution_runs er ON er.skill_version_id = sv.id
       WHERE sv.status = 'candidate'
       AND er.status = 'passed'`,
    )
    .all() as Array<Record<string, unknown>>;

  for (const row of passed) {
    const name = String(row.name);
    const versionHash = String(row.version_hash);
    try {
      promoteCandidate(name, versionHash, config, store);
      store.logBrain("evolution-promoted", `${name} version ${versionHash}`);
    } catch (err) {
      store.logBrain("evolution-promote-error", `Failed to promote ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
