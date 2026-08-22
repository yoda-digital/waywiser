/**
 * Prompt Budget Manager — coordinates system-prompt injections.
 *
 * Each extension registers its injection once (at session_start or
 * before_agent_start time). The manager sorts by priority, places
 * cacheable blocks first (stable prefix), and trims low-priority
 * blocks when the total exceeds the configured budget.
 *
 * A single before_agent_start handler in index.ts calls
 * buildSystemPrompt() to assemble the final system prompt.
 */
import { createHash } from "node:crypto";

// ── Public interface ──────────────────────────────────────────────

/** A block of text to inject into the system prompt. */
export interface PromptInjection {
  /**
   * Unique key for this injection (e.g. "soul", "memory-digest",
   * "kanban"). Used for dedup and config overrides.
   */
  key: string;

  /**
   * Priority: lower number = higher priority = trimmed last.
   * 0 = identity (SOUL.md), 9 = optional nice-to-have.
   */
  priority: number;

  /**
   * The text block to inject. Empty string = nothing to inject
   * (the injection is silently skipped).
   */
  content: string;

  /**
   * True when the content is session-stable (doesn't change between
   * turns). Cacheable blocks are placed BEFORE volatile blocks to
   * maximize prompt-cache prefix reuse.
   */
  cacheable: boolean;
}

/** Priority assignments (lower = higher priority). */
export const PRIORITIES = {
  SOUL:           0,  // identity — never trimmed
  MEMORY_DIGEST:  1,  // session-stable memory snapshot
  GOALS:          2,  // active goal tree
  MEMORY_RECALL:  3,  // per-turn selective recall
  BRAIN_CONTEXT:  3,  // per-turn Brain RRF recall (same level as core recall)
  PA_CATALOG:     4,  // PA playbook catalog
  KANBAN:         5,  // open kanban cards summary
  PERMISSIONS:    6,  // permission reminders
} as const;

// ── Registry ──────────────────────────────────────────────────────

const injections = new Map<string, PromptInjection>();

/**
 * Register (or update) a prompt injection.
 * Call this from session_start (for session-stable blocks) or
 * before_agent_start (for per-turn blocks). Re-registering with
 * the same key replaces the previous content.
 */
export function registerInjection(injection: PromptInjection): void {
  injections.set(injection.key, injection);
}

/**
 * Remove an injection by key. Use when the source data is empty
 * (e.g. no active goals, no open kanban cards).
 */
export function removeInjection(key: string): void {
  injections.delete(key);
}

/**
 * Clear all injections. Call at session_start to reset for the
 * new session.
 */
export function clearInjections(): void {
  injections.clear();
}

// ── Builder ───────────────────────────────────────────────────────

/** Default budget: 12,000 chars (~3,000 tokens). Appropriate for
 *  Qwen 3.8 (27B) with a 32K context window. */
const DEFAULT_BUDGET_CHARS = 12_000;

/**
 * Assemble the final system prompt from all registered injections.
 *
 * Order:
 *   1. Cacheable blocks, sorted by priority (ascending = highest first)
 *   2. Volatile blocks, sorted by priority
 *
 * Trimming: when total exceeds budgetChars, the lowest-priority
 * blocks (highest priority number) are dropped. A trimmed block
 * is logged to stderr with its key and size.
 *
 * @param base  The original event.systemPrompt from Pi
 * @param budgetChars  Max chars for waywiser injections (not counting base)
 * @returns The assembled system prompt: cacheable prefix + base + volatile suffix
 */
export function buildSystemPrompt(
  base: string,
  budgetChars: number = DEFAULT_BUDGET_CHARS,
): string {
  const all = [...injections.values()].filter(i => i.content.length > 0);

  // Sort: priority ascending (0 first)
  const cacheable = all.filter(i => i.cacheable).sort((a, b) => a.priority - b.priority);
  const volatile  = all.filter(i => !i.cacheable).sort((a, b) => a.priority - b.priority);

  // Compute total injection size
  const totalSize = all.reduce((sum, i) => sum + i.content.length, 0);

  let prefix = "";   // cacheable, prepended to base (stable prefix for cache)
  let suffix = "";   // volatile, appended after base

  if (totalSize <= budgetChars) {
    // Everything fits — no trimming
    prefix = cacheable.map(i => i.content).join("");
    suffix = volatile.map(i => i.content).join("");
  } else {
    // Trim from the bottom (lowest priority = highest number)
    let remaining = budgetChars;

    for (const inj of cacheable) {
      if (inj.content.length <= remaining) {
        prefix += inj.content;
        remaining -= inj.content.length;
      } else {
        logTrimmed(inj);
      }
    }

    for (const inj of volatile) {
      if (inj.content.length <= remaining) {
        suffix += inj.content;
        remaining -= inj.content.length;
      } else {
        logTrimmed(inj);
      }
    }
  }

  // Track cache prefix hash
  trackCachePrefix(prefix);

  // Assembly: cacheable prefix + Pi's base + volatile suffix
  return prefix + base + suffix;
}

function logTrimmed(inj: PromptInjection): void {
  process.stderr.write(
    `waywiser/prompt-budget: trimmed "${inj.key}" (${inj.content.length} chars, priority ${inj.priority})\n`
  );
}

// ── Cache telemetry ───────────────────────────────────────────────

let lastPrefixHash = "";
let cacheHits = 0;
let cacheMisses = 0;

function trackCachePrefix(prefix: string): void {
  if (!prefix) return;
  // Hash first 2000 chars of the cacheable prefix — this is the
  // segment that should stay identical across turns
  const hash = createHash("sha256")
    .update(prefix.slice(0, 2000))
    .digest("hex")
    .slice(0, 16);

  if (hash === lastPrefixHash) {
    cacheHits++;
  } else {
    cacheMisses++;
    lastPrefixHash = hash;
  }
}

/** Reset cache stats. Call at session_start. */
export function resetCacheStats(): void {
  lastPrefixHash = "";
  cacheHits = 0;
  cacheMisses = 0;
}

/** Format cache stats for /waywiser status. */
export function cacheStatsLine(): string {
  const total = cacheHits + cacheMisses;
  const rate = total > 0 ? Math.round((cacheHits / total) * 100) : 0;
  return `prompt-cache: ${cacheHits} hits, ${cacheMisses} misses (${rate}% hit rate, prefix hash: ${lastPrefixHash || "none"})`;
}

/**
 * Return the current registered injection count and total size
 * (for /waywiser status and diagnostics).
 */
export function injectionStats(): { count: number; totalChars: number; keys: string[] } {
  const all = [...injections.values()].filter(i => i.content.length > 0);
  return {
    count: all.length,
    totalChars: all.reduce((sum, i) => sum + i.content.length, 0),
    keys: all.map(i => `${i.key}(${i.content.length})`),
  };
}
