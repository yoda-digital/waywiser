/**
 * waywiser-brain — recall module.
 *
 * Retrieves memories and procedures relevant to the current prompt using
 * reciprocal rank fusion (RRF) across five signals: lexical relevance
 * (FTS5/BM25), scope match (same project > global > other project), usage
 * history (useful - not_useful / success - failure), confidence, and
 * recency. Fixes three bugs present in the pre-brain Waywiser recall:
 *
 *   1. ASCII-only tokenizer (`/[a-z0-9_]{2,}/g`) produced zero tokens for
 *      non-Latin scripts (Romanian, Russian, etc.) — replaced with a
 *      unicode-aware tokenizer below.
 *   2. `recall.mode === "off"` still injected memories in some code paths —
 *      `recall()` here returns empty immediately when off.
 *   3. Automatic (non-interactive) recall paths never bumped access_count —
 *      `recall()` here bumps access_count for every returned memory,
 *      regardless of caller.
 */
import type { BrainConfig, BrainMemory, MemoryScope, Procedure, RecallItem, RecallResult } from "./types.ts";
import type { BrainStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "have", "has", "had",
  "was", "were", "are", "you", "your", "about", "into", "onto", "than", "then",
  "when", "what", "which", "who", "how", "why", "where", "there", "their",
  "they", "them", "just", "only", "still", "again", "because", "while",
  "after", "before", "over", "under", "please", "could", "would", "should",
  "can", "not", "but", "also", "been", "being", "will", "does", "did", "in",
]);

/**
 * Unicode-aware tokenizer. Extracts tokens of 2+ unicode letters/numbers
 * (any script — Latin, Cyrillic, etc.), lowercased, stopwords removed,
 * deduplicated, capped at 12 terms.
 */
export function buildRecallQuery(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Unicode-aware: match sequences of 2+ letters or digits (any script)
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}_]{2,}/gu)) {
    const w = match[0];
    if (STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length === 12) break; // reasonable limit
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reciprocal rank fusion
// ---------------------------------------------------------------------------

/**
 * Reciprocal rank fusion across multiple ranked lists.
 * score = Σ (weight_i / (k + rank_i))  where k = 60 by default.
 */
export function reciprocalRankFusion(
  rankings: Array<Map<string, number>>,
  weights: number[],
  k: number = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();

  for (let i = 0; i < rankings.length; i++) {
    const ranking = rankings[i];
    const weight = weights[i] ?? 1.0;
    for (const [id, rank] of ranking) {
      const current = scores.get(id) ?? 0;
      scores.set(id, current + weight / (k + rank));
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Main recall
// ---------------------------------------------------------------------------

export interface RecallOpts {
  prompt: string;
  cwd: string;
  projectKey: string | null;
  config: BrainConfig["recall"];
  scopingConfig: BrainConfig["scoping"];
  store: BrainStore;
}

const EMPTY_RESULT: RecallResult = { items: [], memoryIds: [], procedureIds: [], revision: 0 };

/**
 * Main recall function. Returns ranked memories and procedures fused across
 * lexical, scope, usage, confidence, and recency signals.
 *
 * Bumps access_count for ALL returned memories (bug fix: every recall path —
 * automatic or interactive — must bump access_count, not just some).
 *
 * Returns empty immediately if mode === "off" (bug fix: off truly means off).
 */
export function recall(opts: RecallOpts): RecallResult {
  const { prompt, projectKey, config, store } = opts;

  // BUG FIX: recall=off truly means off
  if (config.mode === "off") {
    return EMPTY_RESULT;
  }

  const terms = buildRecallQuery(prompt);
  if (!terms.length) {
    return EMPTY_RESULT;
  }

  // 1. Lexical ranking (FTS5/BM25).
  //
  // BrainStore#searchMemories/#searchProcedures wrap whatever string they're
  // given as a single FTS5 phrase (see store.ts's ftsPhrase()), so passing
  // `terms.join(" OR ")` would search for the literal phrase
  // "term1 OR term2 OR term3" (the word "OR" included) instead of matching
  // any one of the terms — it would almost never match real content. Search
  // once per term instead (each term alone is always a syntactically safe
  // single-word phrase query) and fuse the per-term FTS5 rankings with RRF
  // into one lexical ranking, so any single strong term can surface a memory.
  const memoryPool = new Map<number, BrainMemory>();
  const procedurePool = new Map<string, Procedure>();
  const termRankings: Array<Map<string, number>> = [];

  for (const term of terms) {
    const memResults = store.searchMemories(term, config.maxItems * 3);
    const procResults = store.searchProcedures(term, config.maxItems);
    if (!memResults.length && !procResults.length) continue;

    const termRanking = new Map<string, number>();
    memResults.forEach((m, i) => {
      memoryPool.set(m.id, m);
      termRanking.set(`mem_${m.id}`, i + 1);
    });
    procResults.forEach((p, i) => {
      procedurePool.set(p.id, p);
      termRanking.set(`proc_${p.id}`, i + 1);
    });
    termRankings.push(termRanking);
  }

  const memories = [...memoryPool.values()];
  const procedures = [...procedurePool.values()];

  if (!memories.length && !procedures.length) {
    return EMPTY_RESULT;
  }

  // Build ranking maps for each signal
  const allIds: string[] = [
    ...memories.map((m) => `mem_${m.id}`),
    ...procedures.map((p) => `proc_${p.id}`),
  ];

  // Lexical ranking: fuse the per-term FTS5 rankings into one ranking.
  const lexicalFused = reciprocalRankFusion(
    termRankings,
    termRankings.map(() => 1),
  );
  const lexicalRanking = new Map<string, number>();
  lexicalFused.forEach(({ id }, i) => lexicalRanking.set(id, i + 1));

  // Scope ranking (project match -> rank 1, else rank by distance)
  const scopeRanking = new Map<string, number>();
  for (const id of allIds) {
    const isMemory = id.startsWith("mem_");
    const item = isMemory
      ? memories.find((m) => `mem_${m.id}` === id)
      : procedures.find((p) => `proc_${p.id}` === id);
    if (!item) continue;

    const itemScope = isMemory ? (item as BrainMemory).scope : (item as Procedure).scope;
    const itemProject = isMemory ? (item as BrainMemory).projectKey : (item as Procedure).projectKey;

    if (itemScope === "project" && itemProject === projectKey) {
      scopeRanking.set(id, 1); // best: same project
    } else if (itemScope === "global") {
      scopeRanking.set(id, 2); // good: global
    } else {
      scopeRanking.set(id, 3); // other project
    }
  }

  // Usage ranking (useful_count - not_useful_count, higher is better)
  const usageRanking = new Map<string, number>();
  const usageScores: Array<{ id: string; score: number }> = [];
  for (const m of memories) {
    usageScores.push({ id: `mem_${m.id}`, score: m.usefulCount - m.notUsefulCount });
  }
  for (const p of procedures) {
    usageScores.push({ id: `proc_${p.id}`, score: p.successCount - p.failureCount });
  }
  usageScores.sort((a, b) => b.score - a.score);
  usageScores.forEach((s, i) => usageRanking.set(s.id, i + 1));

  // Confidence ranking
  const confRanking = new Map<string, number>();
  const confScores: Array<{ id: string; score: number }> = [];
  for (const m of memories) confScores.push({ id: `mem_${m.id}`, score: m.confidence });
  for (const p of procedures) confScores.push({ id: `proc_${p.id}`, score: p.confidence });
  confScores.sort((a, b) => b.score - a.score);
  confScores.forEach((s, i) => confRanking.set(s.id, i + 1));

  // Recency ranking (by lastAccessed for memories, updatedAt for procedures)
  const recencyRanking = new Map<string, number>();
  const recencyScores: Array<{ id: string; ts: number }> = [];
  for (const m of memories) recencyScores.push({ id: `mem_${m.id}`, ts: Date.parse(m.lastAccessed) || 0 });
  for (const p of procedures) recencyScores.push({ id: `proc_${p.id}`, ts: Date.parse(p.updatedAt) || 0 });
  recencyScores.sort((a, b) => b.ts - a.ts);
  recencyScores.forEach((s, i) => recencyRanking.set(s.id, i + 1));

  // Fuse
  const fused = reciprocalRankFusion(
    [lexicalRanking, scopeRanking, usageRanking, confRanking, recencyRanking],
    [
      config.fusionWeights.lexical,
      config.fusionWeights.scope,
      config.fusionWeights.usage,
      config.fusionWeights.confidence,
      config.fusionWeights.recency,
    ],
  );

  // Bound results
  const bounded = fused.slice(0, config.maxItems);
  let totalChars = 0;
  const items: RecallItem[] = [];

  for (const { id, score } of bounded) {
    const isMemory = id.startsWith("mem_");
    const numId = isMemory ? Number(id.slice(4)) : id.slice(5);

    let content: string;
    let scope: MemoryScope;

    if (isMemory) {
      const m = memories.find((mem) => mem.id === Number(numId))!;
      content = m.content;
      scope = m.scope;
    } else {
      const p = procedures.find((proc) => proc.id === numId)!;
      content = `When ${p.triggerText}${p.avoidText ? `, avoid: ${p.avoidText}` : ""}${p.preferText ? `, prefer: ${p.preferText}` : ""}`;
      scope = p.scope;
    }

    if (totalChars + content.length > config.maxChars) break;
    totalChars += content.length;

    const fusionBreakdown: RecallItem["fusionBreakdown"] = {
      lexical: lexicalRanking.get(id) ?? 0,
      scope: scopeRanking.get(id) ?? 0,
      usage: usageRanking.get(id) ?? 0,
      confidence: confRanking.get(id) ?? 0,
      recency: recencyRanking.get(id) ?? 0,
    };

    items.push({
      type: isMemory ? "memory" : "procedure",
      id: isMemory ? Number(numId) : String(numId),
      content,
      score,
      scope,
      fusionBreakdown,
    });
  }

  // BUG FIX: ALL recall paths bump access_count
  const memoryIds = items.filter((i) => i.type === "memory").map((i) => i.id as number);
  const procedureIds = items.filter((i) => i.type === "procedure").map((i) => i.id as string);

  if (memoryIds.length) {
    store.bumpAccessCount(memoryIds);
  }

  return { items, memoryIds, procedureIds, revision: Date.now() };
}
