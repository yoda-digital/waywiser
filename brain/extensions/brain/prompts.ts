/**
 * waywiser-brain — LLM prompt templates and brain context rendering.
 *
 * Contains all prompt templates used by cognition pool workers (learner,
 * consolidation, skill compilation, evaluation judging, recovery suggestion),
 * and renderBrainContext which formats recalled memories/procedures for
 * injection into the agent's context.
 */

import type { Experience, Observation, BrainMemory, Procedure, RecallResult } from "./types.ts";

/**
 * Prompt for reflective extraction (learner pass 2).
 * Extracts durable knowledge from an experience record.
 */
export function gatePrompt(experience: Experience): { system: string; user: string } {
  const system = `You are the BRAIN LEARNER for a personal coding assistant. You receive a structured experience record from a completed agent run. Your job is to extract durable knowledge worth preserving across sessions.

Rules:
1. Extract ONLY knowledge that is durable — useful beyond this one session.
2. For each candidate, provide:
   - "content": one clean line (max 500 chars) stating the durable fact
   - "type": one of "fact" | "preference" | "decision" | "lesson"
   - "verbatim": the EXACT text from the experience this claim rests on (max 200 chars)
   - "scope": "global" or "project" — project if it's specific to the working directory
3. Look for:
   - User-stated preferences or constraints
   - Decisions or commitments made
   - Procedural patterns: when X happens, prefer Y over Z
   - Tool failure/recovery patterns worth remembering
4. For procedural patterns, also output:
   - "trigger": when this pattern applies
   - "avoid": what to avoid doing
   - "prefer": what to do instead
5. If any RECALLED memories were wrong or unhelpful, output:
   - "usageFeedback": [{ "memoryId": <id>, "useful": true|false, "reason": "..." }]
6. MAX 3 candidates. Quality over quantity.

Reply with ONLY one JSON object: {"candidates":[...], "procedures":[...], "usageFeedback":[...]}
Empty arrays when nothing qualifies. No code fences, no commentary.`;

  const observations = experience.observations.map(o => ({
    tool: o.tool,
    target: o.targetKey,
    result: o.result,
    error: o.errorClass || undefined,
    recoveredFrom: o.recoveryOf || undefined,
  }));

  const user = JSON.stringify({
    objective: experience.objective,
    outcome: experience.outcome,
    cwd: experience.cwd,
    projectKey: experience.projectKey,
    observations,
    recalledMemoryIds: experience.recalledMemoryIds,
    recalledProcedureIds: experience.recalledProcedureIds,
  }, null, 2);

  return { system, user };
}

/**
 * Prompt for near-duplicate detection (consolidation).
 * Merges similar memories into one.
 */
export function consolidatePrompt(cluster: BrainMemory[]): { system: string; user: string } {
  const system = `You merge near-duplicate memory lines. Given a cluster of similar memories, determine if they say the same thing. If so, produce one merged line (max 500 chars) preserving ALL facts from ALL memories.

Reply JSON only: {"merged": "...", "keepId": <id of the best source>} or {"merged": null} when they are genuinely different memories. No code fences.`;

  const user = cluster.map(m => `#${m.id} [${m.type}|${m.source}] conf=${m.confidence}: ${m.content}`).join("\n");

  return { system, user };
}

/**
 * Prompt for contradiction detection.
 * Checks if two memories contradict each other.
 */
export function contradictionPrompt(a: BrainMemory, b: BrainMemory): { system: string; user: string } {
  const system = `You judge whether two memory lines CONTRADICT each other (same subject, incompatible claims). Two memories about different subjects are NOT contradictions.

Reply JSON only: {"conflict": true|false, "keepId": <integer id or null>, "reason": "<max 50 chars>"}. No code fences.`;

  const user = `A: #${a.id} [${a.type}] conf=${a.confidence}: ${a.content}\nB: #${b.id} [${b.type}] conf=${b.confidence}: ${b.content}`;

  return { system, user };
}

/**
 * Prompt for procedure → SKILL.md generation.
 * Compiles a mature procedure into a skill definition.
 */
export function compileSkillPrompt(
  proc: Procedure,
  evidence: Array<{ experienceId: string; outcome: string; observationId: string | null }>,
): { system: string; user: string } {
  const system = `You are a SKILL COMPILER. Given a mature procedural pattern with evidence, generate a Pi SKILL.md file that teaches an agent this behavior.

The SKILL.md format:
---
name: <kebab-case-name>
description: <one line — when to use this skill>
---

<Instructions for the agent. Be specific, actionable, concise. Reference the trigger, what to avoid, what to prefer. Max 2000 chars.>

Reply with ONLY the SKILL.md content (including frontmatter). No code fences around the whole thing, no commentary.`;

  const user = JSON.stringify({
    key: proc.key,
    trigger: proc.triggerText,
    avoid: proc.avoidText,
    prefer: proc.preferText,
    confidence: proc.confidence,
    successCount: proc.successCount,
    failureCount: proc.failureCount,
    evidenceSummary: evidence.slice(0, 10).map(e => `${e.outcome} in ${e.experienceId}`),
  }, null, 2);

  return { system, user };
}

/**
 * Prompt for qualitative eval comparison.
 * Judges which of two runs is better.
 */
export function judgePrompt(
  baseline: { output: string; toolCalls: number; errors: number },
  candidate: { output: string; toolCalls: number; errors: number },
): { system: string; user: string } {
  const system = `You are a QUALITATIVE JUDGE comparing two agent runs on the same task. Both passed hard correctness checks. Decide which is better on: correctness, efficiency (fewer tool calls), and output quality.

Reply JSON only: {"winner": "baseline"|"candidate"|"tie", "reason": "<max 100 chars>"}. No code fences.`;

  const user = `BASELINE (${baseline.toolCalls} tool calls, ${baseline.errors} errors):\n${baseline.output.slice(0, 2000)}\n\nCANDIDATE (${candidate.toolCalls} tool calls, ${candidate.errors} errors):\n${candidate.output.slice(0, 2000)}`;

  return { system, user };
}

/**
 * Prompt for reflective recovery linking (ambiguous cases).
 * Identifies recovery relationships in tool observations.
 */
export function recoverySuggestionPrompt(observations: Observation[]): { system: string; user: string } {
  const system = `You identify recovery relationships in a sequence of tool observations. A "recovery" is when a later successful action fixed or worked around an earlier failure.

Given the observations below, identify which successes recovered from which failures.

Reply JSON only: {"recoveries": [{"successId": "...", "failureId": "...", "reason": "..."}]}. Empty array if none. No code fences.`;

  const user = observations.map(o =>
    `${o.id}: ${o.tool} → ${o.targetKey} [${o.result}${o.errorClass ? ` (${o.errorClass})` : ""}]`
  ).join("\n");

  return { system, user };
}

/**
 * Format recalled memories and procedures for context injection.
 * Returns an XML-tagged block suitable for system prompts or context.
 */
export function renderBrainContext(recalled: RecallResult): string {
  if (!recalled.items.length) return "";

  const lines: string[] = ["<waywiser-brain-context>"];

  const memories = recalled.items.filter(i => i.type === "memory");
  const procedures = recalled.items.filter(i => i.type === "procedure");

  if (memories.length) {
    lines.push("## Relevant Memories");
    for (const m of memories) {
      lines.push(`- [${m.scope}] ${m.content}`);
    }
  }

  if (procedures.length) {
    lines.push("## Relevant Procedures");
    for (const p of procedures) {
      lines.push(`- ${p.content}`);
    }
  }

  lines.push("</waywiser-brain-context>");
  return lines.join("\n");
}
