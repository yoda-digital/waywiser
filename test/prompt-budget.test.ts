import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const {
  registerInjection, removeInjection, clearInjections,
  buildSystemPrompt, resetCacheStats, cacheStatsLine, injectionStats, PRIORITIES,
} = jiti("../extensions/utils/prompt-budget.ts") as typeof import("../extensions/utils/prompt-budget.ts");

describe("prompt-budget", () => {
  beforeEach(() => {
    clearInjections();
    resetCacheStats();
  });

  test("builds with all injections when under budget", () => {
    registerInjection({ key: "soul", priority: 0, cacheable: true, content: "[SOUL]" });
    registerInjection({ key: "recall", priority: 3, cacheable: false, content: "[RECALL]" });
    const result = buildSystemPrompt("[BASE]");
    assert.ok(result.includes("[SOUL]"));
    assert.ok(result.includes("[BASE]"));
    assert.ok(result.includes("[RECALL]"));
  });

  test("cacheable blocks appear before base, volatile after", () => {
    registerInjection({ key: "soul", priority: 0, cacheable: true, content: "[SOUL]" });
    registerInjection({ key: "digest", priority: 1, cacheable: true, content: "[DIGEST]" });
    registerInjection({ key: "recall", priority: 3, cacheable: false, content: "[RECALL]" });
    registerInjection({ key: "kanban", priority: 5, cacheable: false, content: "[KANBAN]" });
    const result = buildSystemPrompt("[BASE]");
    const soulIdx = result.indexOf("[SOUL]");
    const digestIdx = result.indexOf("[DIGEST]");
    const baseIdx = result.indexOf("[BASE]");
    const recallIdx = result.indexOf("[RECALL]");
    const kanbanIdx = result.indexOf("[KANBAN]");
    assert.ok(soulIdx < digestIdx, "soul before digest");
    assert.ok(digestIdx < baseIdx, "digest before base");
    assert.ok(baseIdx < recallIdx, "base before recall");
    assert.ok(recallIdx < kanbanIdx, "recall before kanban");
  });

  test("priority ordering within cacheable group", () => {
    registerInjection({ key: "b", priority: 5, cacheable: true, content: "[B]" });
    registerInjection({ key: "a", priority: 0, cacheable: true, content: "[A]" });
    const result = buildSystemPrompt("");
    assert.ok(result.indexOf("[A]") < result.indexOf("[B]"));
  });

  test("trims lowest priority when over budget", () => {
    registerInjection({ key: "soul", priority: 0, cacheable: true, content: "S".repeat(50) });
    registerInjection({ key: "kanban", priority: 5, cacheable: false, content: "K".repeat(60) });
    const result = buildSystemPrompt("", 80); // budget=80, total=110
    assert.ok(result.includes("S".repeat(50)), "soul should survive (priority 0)");
    assert.ok(!result.includes("K".repeat(60)), "kanban should be trimmed (priority 5)");
  });

  test("empty content is skipped", () => {
    registerInjection({ key: "empty", priority: 0, cacheable: true, content: "" });
    registerInjection({ key: "real", priority: 1, cacheable: true, content: "[REAL]" });
    const result = buildSystemPrompt("");
    assert.ok(result.includes("[REAL]"));
    const stats = injectionStats();
    assert.equal(stats.count, 1);
  });

  test("removeInjection removes it", () => {
    registerInjection({ key: "x", priority: 0, cacheable: true, content: "[X]" });
    removeInjection("x");
    const result = buildSystemPrompt("");
    assert.ok(!result.includes("[X]"));
  });

  test("clearInjections empties all", () => {
    registerInjection({ key: "a", priority: 0, cacheable: true, content: "[A]" });
    registerInjection({ key: "b", priority: 1, cacheable: true, content: "[B]" });
    clearInjections();
    const stats = injectionStats();
    assert.equal(stats.count, 0);
  });

  test("cache hit tracking: same prefix = hit", () => {
    registerInjection({ key: "soul", priority: 0, cacheable: true, content: "[SOUL-STABLE]" });
    buildSystemPrompt(""); // first call = miss
    buildSystemPrompt(""); // second call = hit (same cacheable content)
    const line = cacheStatsLine();
    assert.ok(line.includes("1 hits"), `expected 1 hit, got: ${line}`);
    assert.ok(line.includes("1 misses"), `expected 1 miss, got: ${line}`);
  });

  test("cache miss tracking: changed prefix = miss", () => {
    registerInjection({ key: "soul", priority: 0, cacheable: true, content: "[V1]" });
    buildSystemPrompt("");
    registerInjection({ key: "soul", priority: 0, cacheable: true, content: "[V2]" });
    buildSystemPrompt("");
    const line = cacheStatsLine();
    assert.ok(line.includes("2 misses"), `expected 2 misses, got: ${line}`);
  });

  test("injectionStats returns correct counts", () => {
    registerInjection({ key: "a", priority: 0, cacheable: true, content: "1234567890" });
    registerInjection({ key: "b", priority: 1, cacheable: false, content: "abc" });
    const stats = injectionStats();
    assert.equal(stats.count, 2);
    assert.equal(stats.totalChars, 13);
    assert.ok(stats.keys.includes("a(10)"));
    assert.ok(stats.keys.includes("b(3)"));
  });

  test("PRIORITIES constants exist with correct order", () => {
    assert.ok(PRIORITIES.SOUL < PRIORITIES.MEMORY_DIGEST);
    assert.ok(PRIORITIES.MEMORY_DIGEST < PRIORITIES.GOALS);
    assert.ok(PRIORITIES.GOALS < PRIORITIES.PA_CATALOG);
    assert.ok(PRIORITIES.PA_CATALOG < PRIORITIES.KANBAN);
    assert.ok(PRIORITIES.KANBAN < PRIORITIES.PERMISSIONS);
  });

  test("budget=0 trims everything gracefully", () => {
    registerInjection({ key: "soul", priority: 0, cacheable: true, content: "[SOUL]" });
    const result = buildSystemPrompt("[BASE]", 0);
    assert.ok(!result.includes("[SOUL]"));
    assert.ok(result.includes("[BASE]")); // base is never trimmed
  });
});
