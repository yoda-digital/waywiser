/**
 * waywiser-brain — experience trace.
 *
 * `ExperienceTrace` is the experience spine: it listens to Pi's `tool_call`,
 * `tool_result`, and `turn_end` events during an agent run, buffers them as
 * `Observation`s, and produces a complete `Experience` record when the run
 * settles (`agent_settled`). Target-key extraction and recovery linking are
 * delegated to the pure functions in `./recovery.js`; provenance
 * classification is delegated to `./provenance.js`. This module owns only
 * the stateful bookkeeping and the (deterministic, heuristic) objective /
 * outcome inference described in spec §4.
 */
import { randomUUID } from "node:crypto";
// NOTE: these two are real (value) imports, not type-only, so they need an
// extension Node's built-in type-stripping loader can actually resolve at
// run time (there is no build step in this package) — ".ts", matching the
// on-disk file, not ".js".
import { classifyToolProvenance } from "./provenance.ts";
import { extractTargetKey, linkRecoveries } from "./recovery.ts";
import type { BrainConfig, Experience, ExperienceOutcome, Observation, RecallResult } from "./types.js";
import { nowIso } from "../utils/time.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const OBJECTIVE_MAX_CHARS = 200;

/** Extracts plain text from a turn_end `content`, which may be a bare
 * string or a Pi-style content-block array (`[{ type: "text", text: "..." }]`). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => extractText(block))
      .filter((s) => s.length > 0)
      .join("\n");
  }
  if (content && typeof content === "object" && "text" in (content as Record<string, unknown>)) {
    const text = (content as Record<string, unknown>).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

/** Best-effort, deterministic classification of an error's content into a
 * short label. Purely a convenience for later reflection/learning passes —
 * never blocks or throws. */
function inferErrorClass(content: unknown): string {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const patterns: Array<[RegExp, string]> = [
    [/ENOENT|no such file|not found/i, "not_found"],
    [/EACCES|permission denied/i, "permission_denied"],
    [/EEXIST|already exists/i, "already_exists"],
    [/time(d)?\s*out/i, "timeout"],
    [/too large|too big|too many/i, "too_large"],
    [/invalid|malformed|syntax error/i, "invalid_input"],
  ];
  for (const [re, cls] of patterns) {
    if (re.test(text)) return cls;
  }
  return "unknown_error";
}

/** Deterministic outcome inference from a (recovery-linked) observation list. */
function inferOutcome(observations: Observation[]): ExperienceOutcome {
  if (observations.length === 0) {
    return { status: "unknown", confidence: "unknown", summary: "No tool observations were recorded." };
  }

  const errors = observations.filter((o) => o.result === "error");
  const successes = observations.filter((o) => o.result === "success");
  const unrecovered = errors.filter((e) => !observations.some((o) => o.recoveryOf === e.id));

  if (unrecovered.length === 0) {
    return {
      status: "success",
      confidence: "inferred",
      summary: `${successes.length} tool call(s) succeeded; ${errors.length} error(s), all recovered.`,
    };
  }

  if (successes.length === 0) {
    return {
      status: "failure",
      confidence: "inferred",
      summary: `${unrecovered.length} tool call(s) failed with no recovery.`,
    };
  }

  return {
    status: "partial",
    confidence: "inferred",
    summary: `${successes.length} tool call(s) succeeded; ${unrecovered.length} error(s) unrecovered.`,
  };
}

function newObservationId(): string {
  return `obs_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function newExperienceId(): string {
  return `exp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function lastPathSegment(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

// ---------------------------------------------------------------------------
// ExperienceTrace
// ---------------------------------------------------------------------------

interface PendingToolCall {
  toolName: string;
  input: Record<string, unknown>;
  timestamp: string;
}

export class ExperienceTrace {
  private readonly config: BrainConfig;

  private sessionManager: { getBranch(): unknown[] } | null = null;

  private pendingToolCalls = new Map<string, PendingToolCall>();
  private observations: Observation[] = [];
  private userTexts: string[] = [];
  private assistantTexts: string[] = [];
  private recalledMemoryIds: number[] = [];
  private recalledProcedureIds: string[] = [];
  private runStartedAt: string = nowIso();

  constructor(config: BrainConfig) {
    this.config = config;
  }

  /** Reset for a new session. */
  resetSession(sessionManager: { getBranch(): unknown[] }): void {
    this.sessionManager = sessionManager;
    this.pendingToolCalls.clear();
    this.observations = [];
    this.userTexts = [];
    this.assistantTexts = [];
    this.recalledMemoryIds = [];
    this.recalledProcedureIds = [];
  }

  /** Begin a new agent run — clears observation buffer. */
  beginRun(): void {
    this.pendingToolCalls.clear();
    this.observations = [];
    this.userTexts = [];
    this.assistantTexts = [];
    this.recalledMemoryIds = [];
    this.recalledProcedureIds = [];
    this.runStartedAt = nowIso();
  }

  /** Record a tool call event. */
  toolCall(event: { toolCallId: string; toolName: string; input: Record<string, unknown> }): void {
    this.pendingToolCalls.set(event.toolCallId, {
      toolName: event.toolName,
      input: event.input,
      timestamp: nowIso(),
    });
  }

  /** Record a tool result event. */
  toolResult(event: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    content: unknown;
    isError: boolean;
    details?: Record<string, unknown>;
  }): void {
    const pending = this.pendingToolCalls.get(event.toolCallId);
    const toolName = pending?.toolName ?? event.toolName;
    const input = pending?.input ?? event.input ?? {};
    const cwd = process.cwd();

    const observation: Observation = {
      id: newObservationId(),
      toolCallId: event.toolCallId,
      tool: toolName,
      targetKey: extractTargetKey(toolName, input, cwd),
      input,
      result: event.isError ? "error" : "success",
      errorClass: event.isError ? inferErrorClass(event.content) : undefined,
      provenance: classifyToolProvenance(toolName),
      detailsJson: event.details ? JSON.stringify(event.details) : undefined,
      timestamp: nowIso(),
    };

    this.observations.push(observation);
    this.pendingToolCalls.delete(event.toolCallId);
  }

  /** Capture assistant/user text from turn_end for objective inference. */
  turnEnd(event: { role?: string; content?: unknown }): void {
    const text = extractText(event.content).trim();
    if (!text) return;
    if (event.role === "user") this.userTexts.push(text);
    else if (event.role === "assistant") this.assistantTexts.push(text);
  }

  /** Note what was recalled (for tracking in the experience). */
  noteRecall(recalled: RecallResult): void {
    this.recalledMemoryIds.push(...recalled.memoryIds);
    this.recalledProcedureIds.push(...recalled.procedureIds);
  }

  /** Finalize the current run into a complete Experience. */
  finalize(ctx: { sessionManager: { getBranch(): unknown[]; getSessionId?(): string }; cwd: string }): Experience {
    const linkedObservations = linkRecoveries(this.observations);
    const outcome = inferOutcome(linkedObservations);

    const branch = ctx.sessionManager.getBranch();
    const leaf = Array.isArray(branch) && branch.length > 0 ? branch[branch.length - 1] : undefined;
    const branchLeaf =
      leaf && typeof leaf === "object" && "id" in (leaf as Record<string, unknown>)
        ? String((leaf as Record<string, unknown>).id)
        : "unknown";

    const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";

    const experience: Experience = {
      id: newExperienceId(),
      sessionId,
      sessionFile: "",
      branchLeaf,
      cwd: ctx.cwd,
      projectKey: lastPathSegment(ctx.cwd),
      objective: (this.userTexts[0] ?? "").slice(0, OBJECTIVE_MAX_CHARS),
      outcome,
      observations: linkedObservations,
      recalledMemoryIds: [...this.recalledMemoryIds],
      recalledProcedureIds: [...this.recalledProcedureIds],
      skillsUsed: [],
      externalSources: [],
      startedAt: this.runStartedAt,
      settledAt: nowIso(),
    };

    // Clear the observation buffer for the next run.
    this.observations = [];

    return experience;
  }
}
