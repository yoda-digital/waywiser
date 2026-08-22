/**
 * waywiser-brain — competitive evaluation.
 *
 * Runs a candidate skill against a baseline (or no skill at all) across a
 * set of eval cases, scoring each pair with deterministic oracle checks
 * first and a qualitative LLM judge only when the hard checks and
 * efficiency metrics leave the pair too close to call. Returns a verdict
 * the evolve module uses to decide whether to promote a candidate.
 */
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import type {
  Procedure,
  EvalCase,
  EvalVerdict,
  SkillVersion,
  BrainConfig,
} from "./types.ts";
import type { BrainStore } from "./store.ts";
import type { CognitionPool } from "./cognition.ts";
import { judgePrompt } from "./prompts.ts";

// ---------------------------------------------------------------------------
// generateEvalCases
// ---------------------------------------------------------------------------

/**
 * Generate eval cases for a skill from its source procedure's experiences.
 * Creates replay cases (from real experiences) and stores them in the DB.
 * Fills any remaining slots with synthetic cases derived from the
 * procedure's trigger text when there isn't enough real evidence.
 */
export function generateEvalCases(
  procedure: Procedure,
  store: BrainStore,
  count: number = 5,
): EvalCase[] {
  const cases: EvalCase[] = [];

  // Get experiences that contributed evidence for this procedure.
  const evidence = store.db
    .prepare("SELECT DISTINCT experience_id FROM procedure_evidence WHERE procedure_id = ? LIMIT ?")
    .all(procedure.id, count * 2) as Array<{ experience_id: string }>;

  for (const { experience_id } of evidence) {
    if (cases.length >= count) break;

    const exp = store.getExperience(experience_id);
    if (!exp || !exp.objective) continue;

    const id = `ec_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const evalCase: EvalCase = {
      id,
      skillName: procedure.key,
      prompt: exp.objective,
      oracleJson: JSON.stringify({
        mustComplete: true,
        maxErrors: exp.observations.filter((o) => o.result === "error" && !o.recoveryOf).length,
      }),
      safetyClass: "safe",
      sourceExperienceId: experience_id,
      createdAt: new Date().toISOString(),
    };

    store.insertEvalCase(evalCase);
    cases.push(evalCase);
  }

  // If not enough cases from experiences, generate synthetic ones from the trigger.
  while (cases.length < count) {
    const id = `ec_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const evalCase: EvalCase = {
      id,
      skillName: procedure.key,
      prompt: `Task that involves: ${procedure.triggerText}`,
      oracleJson: JSON.stringify({ mustComplete: true, maxErrors: 0 }),
      safetyClass: "safe",
      sourceExperienceId: null,
      createdAt: new Date().toISOString(),
    };
    store.insertEvalCase(evalCase);
    cases.push(evalCase);
  }

  return cases;
}

// ---------------------------------------------------------------------------
// runEvalCase
// ---------------------------------------------------------------------------

export interface EvalRunResult {
  output: string;
  toolCalls: number;
  errors: number;
  completed: boolean;
  durationMs: number;
}

/**
 * Run a single eval case against a Pi configuration (baseline or candidate).
 * Spawns `pi --print` with the specified skill and captures output.
 * Returns the run result.
 */
export function runEvalCase(
  evalCase: EvalCase,
  skillPath: string | null,
  config: BrainConfig,
): Promise<EvalRunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = ["--print", "--no-extensions", "--no-context-files"];
    if (skillPath) args.push("--skill", skillPath);

    const child = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf-8")).slice(-2000);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, 60000); // 60s timeout for eval runs

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      // Count tool calls and errors from output (rough heuristic).
      const toolCalls = (stdout.match(/tool_call|Tool:/gi) || []).length;
      const errors = (stdout.match(/error|Error|FAIL/gi) || []).length;
      void stderr; // captured for future diagnostics; not surfaced in the result today

      resolve({
        output: stdout.trim(),
        toolCalls,
        errors,
        completed: code === 0 && stdout.trim().length > 0,
        durationMs,
      });
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        output: "",
        toolCalls: 0,
        errors: 1,
        completed: false,
        durationMs: Date.now() - start,
      });
    });

    // Send eval prompt on stdin.
    if (child.stdin) {
      child.stdin.write(evalCase.prompt);
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// computeHardChecks
// ---------------------------------------------------------------------------

/**
 * Compute hard oracle checks against an eval result.
 */
export function computeHardChecks(
  result: EvalRunResult,
  evalCase: EvalCase,
): Array<{ check: string; passed: boolean; detail: string }> {
  const checks: Array<{ check: string; passed: boolean; detail: string }> = [];

  let oracle: { mustComplete?: boolean; maxErrors?: number } = {};
  try {
    if (evalCase.oracleJson) oracle = JSON.parse(evalCase.oracleJson);
  } catch {
    /* malformed oracle JSON — fall through with defaults */
  }

  // Check 1: Task completed.
  if (oracle.mustComplete !== false) {
    checks.push({
      check: "task-completed",
      passed: result.completed,
      detail: result.completed ? "Task completed" : "Task did not complete",
    });
  }

  // Check 2: Error count within bounds.
  const maxErrors = oracle.maxErrors ?? 0;
  checks.push({
    check: "error-count",
    passed: result.errors <= maxErrors,
    detail: `${result.errors} errors (max: ${maxErrors})`,
  });

  // Check 3: Produced output.
  checks.push({
    check: "has-output",
    passed: result.output.trim().length > 0,
    detail: result.output.trim().length > 0 ? "Produced output" : "No output",
  });

  return checks;
}

// ---------------------------------------------------------------------------
// scoreEvalPair
// ---------------------------------------------------------------------------

/**
 * Score a pair of eval run results (baseline vs candidate).
 * Hard oracle checks first, then qualitative judge if both pass and
 * efficiency comparisons are inconclusive.
 */
export async function scoreEvalPair(
  baselineResult: EvalRunResult,
  candidateResult: EvalRunResult,
  evalCase: EvalCase,
  pool: CognitionPool | null,
): Promise<{ candidateBetter: boolean; tie: boolean; reason: string }> {
  const baselineChecks = computeHardChecks(baselineResult, evalCase);
  const candidateChecks = computeHardChecks(candidateResult, evalCase);

  const baselinePassed = baselineChecks.every((c) => c.passed);
  const candidatePassed = candidateChecks.every((c) => c.passed);

  // If candidate fails hard checks and baseline passes, candidate loses.
  if (baselinePassed && !candidatePassed) {
    return { candidateBetter: false, tie: false, reason: "candidate failed hard checks" };
  }

  // If baseline fails and candidate passes, candidate wins.
  if (!baselinePassed && candidatePassed) {
    return { candidateBetter: true, tie: false, reason: "candidate passed, baseline failed" };
  }

  // If both fail, tie (neither is better).
  if (!baselinePassed && !candidatePassed) {
    return { candidateBetter: false, tie: true, reason: "both failed hard checks" };
  }

  // Both pass — compare efficiency.
  if (candidateResult.errors < baselineResult.errors) {
    return { candidateBetter: true, tie: false, reason: "fewer errors" };
  }
  if (candidateResult.errors > baselineResult.errors) {
    return { candidateBetter: false, tie: false, reason: "more errors" };
  }

  // Same error count — check tool calls.
  if (candidateResult.toolCalls < baselineResult.toolCalls * 0.8) {
    return { candidateBetter: true, tie: false, reason: "significantly fewer tool calls" };
  }
  if (candidateResult.toolCalls > baselineResult.toolCalls * 1.2) {
    return { candidateBetter: false, tie: false, reason: "significantly more tool calls" };
  }

  // Close enough — qualitative judge (if pool available).
  if (pool) {
    try {
      const prompt = judgePrompt(
        { output: baselineResult.output, toolCalls: baselineResult.toolCalls, errors: baselineResult.errors },
        { output: candidateResult.output, toolCalls: candidateResult.toolCalls, errors: candidateResult.errors },
      );
      const raw = await pool.runJudge(prompt);
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { winner?: string; reason?: string };
        if (parsed.winner === "candidate") {
          return { candidateBetter: true, tie: false, reason: parsed.reason || "judge prefers candidate" };
        }
        if (parsed.winner === "baseline") {
          return { candidateBetter: false, tie: false, reason: parsed.reason || "judge prefers baseline" };
        }
      }
    } catch {
      /* judge failed or returned unparseable output, treat as tie */
    }
  }

  return { candidateBetter: false, tie: true, reason: "no significant difference" };
}

// ---------------------------------------------------------------------------
// runEvaluation
// ---------------------------------------------------------------------------

/**
 * Run a full competitive evaluation: baseline vs candidate across all cases.
 * Returns the final verdict.
 */
export async function runEvaluation(
  candidateVersion: SkillVersion,
  baselineVersion: SkillVersion | null,
  store: BrainStore,
  pool: CognitionPool | null,
  config: BrainConfig,
): Promise<EvalVerdict> {
  const cases = store.getEvalCases(candidateVersion.name);
  if (!cases.length) {
    return {
      pass: false,
      hardCheckResults: [],
      details: "No eval cases available",
    };
  }

  const allHardChecks: Array<{ check: string; passed: boolean; detail: string }> = [];
  let candidateWins = 0;
  let baselineWins = 0;
  let ties = 0;

  for (const evalCase of cases.slice(0, config.evolution.evalCasesPerCandidate)) {
    // Run candidate.
    const candidateResult = await runEvalCase(evalCase, candidateVersion.path, config);

    // Run baseline (no skill, or baseline skill).
    const baselineResult = await runEvalCase(evalCase, baselineVersion?.path || null, config);

    // Score.
    const score = await scoreEvalPair(baselineResult, candidateResult, evalCase, pool);

    // Collect hard checks from candidate.
    const candidateChecks = computeHardChecks(candidateResult, evalCase);
    allHardChecks.push(...candidateChecks);

    if (score.candidateBetter) candidateWins++;
    else if (score.tie) ties++;
    else baselineWins++;
  }

  // Verdict: candidate must not be worse.
  const pass = baselineWins === 0 && allHardChecks.filter((c) => !c.passed).length === 0;

  return {
    pass,
    hardCheckResults: allHardChecks,
    qualitativeResult: `${candidateWins} wins, ${baselineWins} losses, ${ties} ties`,
    details: `Evaluated ${Math.min(cases.length, config.evolution.evalCasesPerCandidate)} cases: candidate ${pass ? "PASSED" : "FAILED"}`,
  };
}
