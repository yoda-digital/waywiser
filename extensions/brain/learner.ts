/**
 * waywiser-brain — two-pass learning pipeline.
 *
 * Runs at `agent_settled`. Pass 1 (`deterministicExtract`) is pure and
 * synchronous — it scans an Experience for user corrections/statements,
 * tool failures, and recoveries using regex patterns only, no LLM calls.
 * Pass 2 (`reflectiveExtract`) only fires when pass 1 found durable
 * signals; it sends the experience to a cognition-pool worker and parses
 * the worker's structured JSON reply into memory/procedure candidates.
 * `validateCandidates` is the trust boundary between the two passes: the
 * LLM proposes meaning, but this function — not the LLM — decides
 * provenance and bounds confidence accordingly (spec kernel invariant).
 */
import type {
  BrainConfig,
  Experience,
  DeterministicPass1Result,
  LearningResult,
  MemoryScope,
  MemoryType,
  ProvenanceSource,
} from "./types.ts";
import type { CognitionPool } from "./cognition.ts";
import { gatePrompt } from "./prompts.ts";
import { confidenceForSource } from "./provenance.ts";
import type { BrainStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Pass 1: deterministic extraction
// ---------------------------------------------------------------------------

// Patterns for detecting user corrections
const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(?:actually|wait|sorry)\b/i,
  /\bthat'?s?\s+(?:wrong|incorrect|not right)\b/i,
  /\binstead\s+(?:use|do|try)\b/i,
  /\bcorrection\b/i,
  /\bdon'?t\s+(?:use|do)\b/i,
  /\bstop\s+(?:using|doing)\b/i,
  /\bnever\s+(?:use|do)\b/i,
];

// Patterns for detecting user preference/fact statements
const STATEMENT_PATTERNS = [
  /\b(?:always|never)\s+/i,
  /\bi\s+(?:prefer|want|need|use|like)\b/i,
  /\bwe\s+(?:use|prefer|need|always)\b/i,
  /\bthe\s+project\s+(?:uses?|requires?|needs?)\b/i,
  /\bremember\s+(?:that|this)\b/i,
  /\bfrom\s+now\s+on\b/i,
];

/**
 * Pass 1: Deterministic extraction from an Experience.
 * No LLM calls. Scans for user corrections, statements, tool failures, recoveries.
 */
export function deterministicExtract(
  experience: Experience,
  config: BrainConfig,
): DeterministicPass1Result {
  void config; // reserved for future tuning; pass 1 is pattern-driven today

  const result: DeterministicPass1Result = {
    hasDurableSignals: false,
    userCorrections: [],
    userStatements: [],
    toolFailures: [],
    recoveries: [],
    skillsUsed: [...experience.skillsUsed],
    externalObservations: [],
  };

  // Scan user text from the experience objective (which contains user messages)
  const userText = experience.objective || "";

  // Check for user corrections
  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(userText)) {
      result.userCorrections.push({
        content: userText.slice(0, 500),
        verbatim: userText.slice(0, 200),
      });
      break; // one correction per experience is enough
    }
  }

  // Check for user statements
  for (const pattern of STATEMENT_PATTERNS) {
    if (pattern.test(userText)) {
      result.userStatements.push({
        content: userText.slice(0, 500),
        verbatim: userText.slice(0, 200),
      });
      break;
    }
  }

  // Tool failures
  result.toolFailures = experience.observations.filter((o) => o.result === "error");

  // Recoveries (observations with recoveryOf set)
  for (const obs of experience.observations) {
    if (obs.recoveryOf) {
      const failed = experience.observations.find((o) => o.id === obs.recoveryOf);
      if (failed) {
        result.recoveries.push({ failed, succeeded: obs });
      }
    }
  }

  // External observations
  result.externalObservations = experience.observations.filter(
    (o) => o.provenance === "external",
  );

  // Has durable signals?
  result.hasDurableSignals =
    result.userCorrections.length > 0 ||
    result.userStatements.length > 0 ||
    result.toolFailures.length > 0 ||
    result.recoveries.length > 0;

  return result;
}

// ---------------------------------------------------------------------------
// Procedure key generation (also used by Task 10 / procedures module)
// ---------------------------------------------------------------------------

/**
 * Derives a stable, filesystem/SQL-safe key from a procedure's trigger,
 * avoid, and prefer text, so the same pattern reported across different
 * experiences upserts the same `procedures` row instead of duplicating it.
 */
export function generateProcedureKey(
  trigger: string,
  avoid: string | null,
  prefer: string | null,
): string {
  const parts = [trigger, avoid || "", prefer || ""]
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
    .filter(Boolean);
  return parts.join("--").slice(0, 100);
}

// ---------------------------------------------------------------------------
// Pass 2: reflective extraction via cognition pool
// ---------------------------------------------------------------------------

interface RawLearnerResponse {
  candidates?: Array<{
    content: string;
    type: string;
    verbatim: string;
    scope?: string;
  }>;
  procedures?: Array<{
    trigger: string;
    avoid?: string;
    prefer?: string;
  }>;
  usageFeedback?: Array<{
    memoryId: number;
    useful: boolean;
    reason?: string;
  }>;
}

const VALID_MEMORY_TYPES: readonly MemoryType[] = ["fact", "preference", "decision", "lesson"];

/**
 * Pass 2: Reflective extraction via cognition pool.
 * Only called when pass1.hasDurableSignals is true.
 * Sends the ExperiencePacket to a cognition worker, parses structured response.
 * LLM/parse failures are swallowed — the deterministic recovery-derived
 * procedure updates below still get returned so learning degrades
 * gracefully rather than crashing the pipeline.
 */
export async function reflectiveExtract(
  experience: Experience,
  pass1: DeterministicPass1Result,
  pool: CognitionPool,
  config: BrainConfig,
): Promise<LearningResult> {
  const prompt = gatePrompt(experience);

  const result: LearningResult = {
    memories: [],
    procedureUpdates: [],
    usageRecords: [],
  };

  try {
    const raw = await pool.runLearner(prompt, config.learning.gateTimeoutMs);

    // Parse JSON response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as RawLearnerResponse;

      // Process memory candidates
      if (Array.isArray(parsed.candidates)) {
        for (const c of parsed.candidates.slice(0, config.learning.maxMemoriesPerRun)) {
          if (!c.content?.trim()) continue;
          const type = (VALID_MEMORY_TYPES.includes(c.type as MemoryType)
            ? c.type
            : "fact") as MemoryType;
          const scope = (c.scope === "project" ? "project" : "global") as MemoryScope;

          result.memories.push({
            type,
            content: c.content.trim().slice(0, 500),
            source: "agent", // will be overridden by validateCandidates
            confidence: 0.7, // will be bounded by validateCandidates
            scope,
            projectKey: scope === "project" ? experience.projectKey : null,
            verbatim: c.verbatim?.trim().slice(0, 200) || null,
            supersedesId: null,
          });
        }
      }

      // Process procedure candidates
      if (Array.isArray(parsed.procedures)) {
        for (const p of parsed.procedures) {
          if (!p.trigger?.trim()) continue;
          result.procedureUpdates.push({
            key: generateProcedureKey(p.trigger, p.avoid || null, p.prefer || null),
            triggerText: p.trigger.trim(),
            avoidText: p.avoid?.trim() || null,
            preferText: p.prefer?.trim() || null,
            outcome: "success",
            experienceId: experience.id,
            observationId: null,
          });
        }
      }

      // Process usage feedback
      if (Array.isArray(parsed.usageFeedback)) {
        for (const f of parsed.usageFeedback) {
          if (typeof f.memoryId !== "number") continue;
          result.usageRecords.push({
            memoryId: f.memoryId,
            useful: f.useful ?? null,
            contradicted: false,
          });
        }
      }
    }
  } catch {
    // LLM call failed, timed out, or returned unparseable JSON — return
    // whatever we have from the deterministic pass. Don't crash the
    // learning pipeline over a cognition-worker hiccup.
  }

  // Also add procedure updates from pass1 recoveries — these are
  // deterministic (no LLM needed) so they survive even a total pool failure.
  for (const { failed, succeeded } of pass1.recoveries) {
    result.procedureUpdates.push({
      key: generateProcedureKey(
        `${failed.tool} fails on ${failed.targetKey}`,
        `${failed.tool}`,
        `${succeeded.tool}`,
      ),
      triggerText: `${failed.tool} fails on target like ${failed.targetKey}`,
      avoidText: failed.tool,
      preferText: succeeded.tool,
      outcome: "success",
      experienceId: experience.id,
      observationId: succeeded.id,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Candidate validation (trust boundary)
// ---------------------------------------------------------------------------

/**
 * Validate candidates from reflective extraction.
 * Overrides LLM-chosen source with deterministic provenance.
 * Bounds confidence by source type.
 * Infers scope conservatively.
 *
 * KERNEL INVARIANT: the LLM proposes meaning but never chooses its own
 * authority — provenance and the confidence ceiling it implies are always
 * decided here, deterministically, regardless of what pass 2 claimed.
 */
export function validateCandidates(
  candidates: LearningResult,
  experience: Experience,
  config: BrainConfig,
): LearningResult {
  const validated: LearningResult = {
    memories: [],
    procedureUpdates: [...candidates.procedureUpdates],
    usageRecords: [...candidates.usageRecords],
  };

  for (const mem of candidates.memories) {
    // Default: agent-inferred. Only promoted to "user" when the candidate's
    // verbatim quote actually appears in the experience's own objective text.
    let source: ProvenanceSource = "agent";

    if (experience.objective && mem.verbatim && experience.objective.includes(mem.verbatim)) {
      source = "user";
    }

    // Bound confidence by source type
    const maxConf = confidenceForSource(source, config);
    const confidence = Math.min(mem.confidence, maxConf);

    validated.memories.push({
      ...mem,
      source,
      confidence,
    });
  }

  return validated;
}

// ---------------------------------------------------------------------------
// Memory usage feedback recording
// ---------------------------------------------------------------------------

/**
 * Record memory usage feedback — which recalled memories were useful/not useful.
 * Called after learning to track memory effectiveness.
 * Usefulness itself is `null` here — it's filled in later by the reflective
 * pass's usageFeedback, once we know whether the recalled memory actually
 * helped this experience.
 */
export function recordMemoryUsage(experience: Experience, store: BrainStore): void {
  for (const memId of experience.recalledMemoryIds) {
    store.recordMemoryUsage(memId, experience.id, null, false);
  }
}
