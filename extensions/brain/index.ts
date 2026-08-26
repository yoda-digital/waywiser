/**
 * waywiser-brain — root extension entry.
 *
 * Composes all 16 Brain modules (config, store, trace, cognition, recall,
 * prompts, learner, procedures, consolidate, skills, evolve, vault, policy,
 * eval, provenance, recovery) into a single Pi extension: event lifecycle,
 * the `evolve` tool, and the `/brain` command. Follows the same composition
 * philosophy as `waywiser/extensions/index.ts` — every handler contains its
 * own failures (try/catch → stderr) so one broken module never takes the
 * rest of Brain down, let alone the host session.
 *
 * Event lifecycle:
 *   resources_discover  → expose active skills to Pi's discovery
 *   session_start        → reload config, promote pending skills, vault-sync in
 *   before_agent_start    → seed the experience trace's objective, inject recall
 *   agent_start           → begin a fresh observation buffer
 *   tool_call/tool_result → buffer observations
 *   turn_end              → capture the completing assistant message
 *   <learning boundary>   → two-pass learning, procedure evidence, evolution
 *   session_shutdown      → consolidate, vault-sync out, tear down cognition pool
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBrainConfig, reloadBrainConfig } from "./config.ts";
import { openBrainStore, type BrainStore } from "./store.ts";
import { ExperienceTrace } from "./trace.ts";
import { createCognitionPool, type CognitionPool } from "./cognition.ts";
import { recall } from "./recall.ts";
import { embed, vecToBlob } from "./embeddings.ts";
import { renderBrainContext } from "./prompts.ts";
import { deterministicExtract, reflectiveExtract, validateCandidates, recordMemoryUsage } from "./learner.ts";
import { updateProcedureEvidence } from "./procedures.ts";
import { consolidate } from "./consolidate.ts";
import {
  ensureSkillDirs,
  getSkillDiscoverPaths,
  listActiveSkills,
  listCandidates,
  promoteCandidate,
  rejectCandidate,
  rollbackSkill,
} from "./skills.ts";
import { checkEvolutionTriggers, promotePending } from "./evolve.ts";
import { vaultSyncInbound, vaultSyncOutbound } from "./vault.ts";
import { detectProjectKey } from "./policy.ts";
import type { BrainConfig, RecallResult } from "./types.ts";
import { fmtDateTime, fmtAge } from "../utils/time.ts";

function errMsg(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * Render RecallResult items in the compact `#id [type] content (score: N)`
 * form used by the RecallProvider's tool-facing text. Shared by the fresh
 * and cache-hit paths so both stay byte-identical.
 */
function formatRecallItems(items: RecallResult["items"]): string {
  return items
    .map((item) =>
      item.type === "memory"
        ? `#${item.id} [memory] ${item.content} (score: ${item.score.toFixed(3)})`
        : `[procedure] ${item.content} (score: ${item.score.toFixed(3)})`,
    )
    .join("\n");
}

export default function brain(pi: ExtensionAPI): void {
  let config: BrainConfig;
  let store: BrainStore;
  let trace: ExperienceTrace;
  let cognitionPool: CognitionPool;

  let sessionReflectionCount = 0;
  let gateAccum: string[] = [];

  // ── Per-turn recall cache (eliminates duplicate recall() calls) ──
  // `before_agent_start` fires exactly once per user turn, before any tool
  // call can run, so its recall() is always the *first* recall of the turn —
  // it populates this cache. If the agent later calls `memory action=recall`
  // (routed through the RecallProvider below) with the same query in that
  // same turn, the provider reuses this result instead of re-running
  // embed() + FTS5 + RRF. One-shot: consuming it clears it, so a second,
  // different-query tool call in the same turn still gets a fresh recall,
  // and the next turn's before_agent_start always overwrites it before
  // anything could read a stale entry.
  let cachedRecall: { prompt: string; maxItems: number; result: RecallResult } | null = null;

  // ── Embedding bookkeeping (#24 failure logging, #31 concurrency cap) ──
  let embedInFlight = 0;
  let embedFailures = 0;
  let embedSuccesses = 0;
  const EMBED_CONCURRENCY = 3;
  const MAX_EMBED_LOG = 3; // log first N failures per session to stderr

  async function boundedEmbed(content: string, memId: number): Promise<void> {
    if (embedInFlight >= EMBED_CONCURRENCY) return; // skip; picked up again next session
    embedInFlight++;
    try {
      const vec = await embed(content, config);
      if (vec) {
        store.setEmbedding(memId, vecToBlob(vec));
        embedSuccesses++;
      }
    } catch (e) {
      embedFailures++;
      if (embedFailures <= MAX_EMBED_LOG) {
        process.stderr.write(
          `brain: embedding failed (${embedFailures}): ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    } finally {
      embedInFlight--;
    }
  }

  // ── Initialize ──────────────────────────────────────────────
  try {
    config = loadBrainConfig();
    store = openBrainStore(config);
    trace = new ExperienceTrace(config);
    cognitionPool = createCognitionPool(config);
    if (config.modules.skills) ensureSkillDirs(config);
  } catch (err) {
    process.stderr.write(`brain: failed to initialize: ${errMsg(err)}\n`);
    return; // Brain is disabled if init fails — the rest of Pi still runs.
  }

  // ── Skill discovery ─────────────────────────────────────────
  if (config.modules.skills) {
    pi.on("resources_discover", async () => {
      try {
        return { skillPaths: getSkillDiscoverPaths(config) };
      } catch (err) {
        process.stderr.write(`brain: resources_discover error: ${errMsg(err)}\n`);
        return undefined;
      }
    });
  }

  // ── Session start ───────────────────────────────────────────
  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      config = reloadBrainConfig();
      sessionReflectionCount = 0;
      gateAccum = []; // reset accumulation across sessions
      embedInFlight = 0;
      embedFailures = 0;
      embedSuccesses = 0;
      cachedRecall = null; // never leak a previous session's recall across the boundary

      trace.resetSession(ctx.sessionManager);

      // Promote pending candidates at the session boundary — never mid-session.
      if (config.modules.evolve) {
        promotePending(store, config);
      }

      if (config.modules.vault && config.vault.syncOnStart) {
        await vaultSyncInbound(store, config);
      }

      store.beginSession(ctx.sessionManager.getSessionId?.() ?? "unknown");

      // ── Register recall provider on the shared registry ─────────
      // This eliminates the dynamic-import hack in core memory.ts.
      // `store` is the already-open BrainStore — no new connection.
      try {
        const { registry_ } = await import("../utils/state.js");
        const embeddingsEnabled = config.embeddings?.enabled !== false;

        registry_().recallProvider = {
          async recall(query: string, limit: number): Promise<{ text: string }> {
            if (config.recall.mode === "off") {
              return { text: "No memories matched." };
            }

            // Reuse this turn's before_agent_start recall when the query
            // matches exactly and it covered at least `limit` items — saves
            // a duplicate embed() call + FTS5 + RRF pass (see cachedRecall
            // doc comment above).
            if (cachedRecall && cachedRecall.prompt === query && cachedRecall.maxItems >= limit) {
              const { result } = cachedRecall;
              cachedRecall = null; // one-shot — avoid stale reuse later in the turn
              if (!result.items.length) return { text: "No memories matched." };
              return { text: formatRecallItems(result.items.slice(0, limit)) };
            }

            const projectKey = detectProjectKey(ctx.cwd, config);
            const result = await recall({
              prompt: query,
              cwd: ctx.cwd,
              projectKey,
              config: { ...config.recall, maxItems: limit },
              scopingConfig: config.scoping,
              store,
              embedFn: embeddingsEnabled
                ? (text: string) => embed(text, config)
                : undefined,
              embeddingsConfig: config.embeddings,
            });
            if (!result.items.length) {
              return { text: "No memories matched." };
            }
            return { text: formatRecallItems(result.items) };
          },
        };
      } catch (err) {
        process.stderr.write(`brain: failed to register recall provider: ${errMsg(err)}\n`);
      }

      // Backfill embeddings for memories that don't have them yet
      if (config.embeddings?.enabled !== false) {
        const unembedded = store.getMemoriesWithoutEmbeddings(20);
        for (const mem of unembedded) {
          void boundedEmbed(mem.content, mem.id);
        }
      }
    } catch (err) {
      process.stderr.write(`brain: session_start error: ${errMsg(err)}\n`);
    }
  });

  // ── Before agent start (objective capture + recall injection) ──
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      // Seed the experience trace with this run's raw user prompt.
      // `turn_end` only ever carries the *completing* assistant message (see
      // TurnEndEvent — same reason `extensions/memrules.ts`'s lastUserEntry
      // walks session entries for the user side), so `event.prompt` here is
      // the one reliable place to capture the objective text that
      // `ExperienceTrace.finalize()` reads back from `userTexts[0]`.
      if (config.modules.trace) {
        trace.turnEnd({ role: "user", content: event.prompt ?? "" });
      }

      if (config.recall.mode === "off") return; // truly off — no recall path runs

      const projectKey = detectProjectKey(ctx.cwd, config);
      const embeddingsEnabled = config.embeddings?.enabled !== false;
      const recalled = await recall({
        prompt: event.prompt ?? "",
        cwd: ctx.cwd,
        projectKey,
        config: config.recall,
        scopingConfig: config.scoping,
        store,
        embedFn: embeddingsEnabled ? (text: string) => embed(text, config) : undefined,
        embeddingsConfig: config.embeddings,
      });

      trace.noteRecall(recalled);

      // Cache for the RecallProvider (see cachedRecall doc comment above) —
      // refreshed on every turn, so a tool call from a *previous* turn can
      // never read a stale entry here.
      cachedRecall = { prompt: event.prompt ?? "", maxItems: config.recall.maxItems, result: recalled };

      if (!recalled.items.length) return;

      if (config.recall.useCustomMessage) {
        return {
          message: {
            customType: "waywiser/brain-context",
            content: renderBrainContext(recalled),
            display: false,
            details: {
              memoryIds: recalled.memoryIds,
              procedureIds: recalled.procedureIds,
              brainRevision: recalled.revision,
            },
          },
        };
      }

      // Brain is loaded as a separate Pi extension AFTER core (see
      // bin/waywiser), so Pi's before_agent_start handlers already ran
      // core's assembly pass by the time this handler fires — the shared
      // prompt-budget injection registry has already been consumed into
      // event.systemPrompt. Brain is therefore the one extension that
      // bypasses that registry entirely: it appends its recall context
      // directly on top of the already-assembled prompt.
      return {
        systemPrompt: (event.systemPrompt ?? "") + "\n" + renderBrainContext(recalled),
      };
    } catch (err) {
      process.stderr.write(`brain: recall error: ${errMsg(err)}\n`);
    }
  });

  // ── Event observation ───────────────────────────────────────
  if (config.modules.trace) {
    pi.on("agent_start", () => {
      try {
        trace.beginRun();
      } catch (err) {
        process.stderr.write(`brain: agent_start error: ${errMsg(err)}\n`);
      }
    });

    pi.on("tool_call", (event: any) => {
      try {
        trace.toolCall(event);
      } catch (err) {
        process.stderr.write(`brain: tool_call error: ${errMsg(err)}\n`);
      }
    });

    pi.on("tool_result", (event: any) => {
      try {
        trace.toolResult(event);
      } catch (err) {
        process.stderr.write(`brain: tool_result error: ${errMsg(err)}\n`);
      }
    });

    pi.on("turn_end", (event: any) => {
      try {
        // `event.message` is the assistant message that completed this turn;
        // the user side was already captured in before_agent_start.
        trace.turnEnd({ role: event.message?.role ?? "assistant", content: event.message?.content });
      } catch (err) {
        process.stderr.write(`brain: turn_end error: ${errMsg(err)}\n`);
      }
    });
  }

  // ── Learning boundary ───────────────────────────────────────
  const learnBoundary = config.learning.boundary; // default: agent_settled

  pi.on(learnBoundary, async (_event: unknown, ctx: any) => {
    try {
      if (!config.modules.learner) return;
      if (sessionReflectionCount >= config.learning.maxReflectionsPerSession) return;

      const experience = trace.finalize({
        sessionManager: ctx.sessionManager,
        cwd: ctx.cwd,
      });

      // Persist provenance anchor as a Pi custom entry.
      pi.appendEntry("waywiser/experience", {
        experienceId: experience.id,
        outcome: experience.outcome,
        observationCount: experience.observations.length,
        memoryIdsRecalled: experience.recalledMemoryIds,
      });

      // Persist the experience in the Brain DB.
      store.recordExperience(experience);
      if (experience.observations.length) {
        store.recordObservations(experience.id, experience.observations);
      }

      // Two-pass learning.
      const pass1 = deterministicExtract(experience, config);

      if (pass1.hasDurableSignals) {
        sessionReflectionCount++;

        const candidates = await reflectiveExtract(experience, pass1, cognitionPool, config);

        // Validate and store — the trust boundary between LLM proposal and
        // deterministic provenance/confidence.
        const validated = validateCandidates(candidates, experience, config);
        store.storeLearningResults(validated, experience.id);

        // Update procedure evidence.
        if (config.modules.procedures) {
          updateProcedureEvidence(experience, validated, store, config);
        }

        // Record memory usage feedback.
        recordMemoryUsage(experience, store);

        // Check for evolution triggers.
        if (config.modules.evolve) {
          await checkEvolutionTriggers(store, cognitionPool, config);
        }

        // Embed new memories in background (don't block the learning path)
        if (config.embeddings?.enabled !== false) {
          for (const mem of validated.memories) {
            const stored = store.searchMemories(mem.content.slice(0, 50), 1);
            if (stored.length) {
              void boundedEmbed(stored[0].content, stored[0].id);
            }
          }
        }

        // Episode accumulation.
        gateAccum.push(...validated.memories.map((m) => m.content));
        if (gateAccum.length >= 5) {
          store.appendEpisode(experience.sessionId, gateAccum.join("\n---\n"));
          gateAccum = [];
        }
      }
    } catch (err) {
      process.stderr.write(`brain: learning error: ${errMsg(err)}\n`);
    }
  });

  // ── Session shutdown ────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    try {
      if (config.modules.consolidate && config.consolidation.runOnShutdown) {
        await Promise.race([
          consolidate(store, cognitionPool, config),
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]).catch((err) => {
          process.stderr.write(`brain: shutdown consolidation timed out or failed: ${errMsg(err)}\n`);
        });
      }

      if (config.modules.vault && config.vault.syncOnShutdown) {
        await vaultSyncOutbound(store, config);
      }
    } catch (err) {
      process.stderr.write(`brain: shutdown error: ${errMsg(err)}\n`);
    }

    try {
      cognitionPool.shutdown();
    } catch (err) {
      process.stderr.write(`brain: cognition pool shutdown error: ${errMsg(err)}\n`);
    }
  });

  // ── Tool: evolve ────────────────────────────────────────────
  pi.registerTool({
    name: "evolve",
    label: "Brain Evolution",
    description: "Inspect Brain's self-evolution system: status, candidates, skill history, and policy.",
    // Raw JSON Schema — not a TypeBox schema. Pi's ToolDefinition types this
    // generically as TSchema, but a plain JSON Schema object validates the
    // same shape at runtime and keeps this package free of a typebox dep.
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "candidates", "inspect", "history", "policy"],
          description: "What to show",
        },
        target: {
          type: "string",
          description: "Skill name or version ID for inspect/history",
        },
      },
      required: ["action"],
    },
    executionMode: "parallel",
    async execute(_id: string, params: any, _signal: any, _update: any, _ctx: any) {
      try {
        const text = handleEvolveAction(params.action, params.target, store, config);
        return { content: [{ type: "text" as const, text }], details: {} };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `evolve tool error: ${errMsg(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── Commands: /brain ────────────────────────────────────────
  pi.registerCommand("brain", {
    description: "Brain observability and management: status, sync, consolidate, evolve, experience, procedure, memory, config",
    async handler(args: string, ctx: any) {
      try {
        const parts = args.trim().split(/\s+/);
        const sub = parts[0] || "status";

        switch (sub) {
          case "status":
            ctx.ui.notify(handleBrainStatus(store, config, { successes: embedSuccesses, failures: embedFailures, inFlight: embedInFlight }), "info");
            return;
          case "sync":
            await vaultSyncOutbound(store, config);
            await vaultSyncInbound(store, config);
            ctx.ui.notify("Vault sync complete.", "info");
            return;
          case "consolidate": {
            const report = await consolidate(store, cognitionPool, config);
            ctx.ui.notify(report.report, "info");
            return;
          }
          case "evolve": {
            const action = parts[1] || "status";
            const target = parts.slice(2).join(" ");
            if (["promote", "reject", "rollback", "evaluate"].includes(action)) {
              ctx.ui.notify(handleEvolveCommand(action, target, store, config), "info");
              return;
            }
            ctx.ui.notify(handleEvolveAction(action, target, store, config), "info");
            return;
          }
          case "experience":
            ctx.ui.notify(handleExperienceInspect(parts[1], store), "info");
            return;
          case "procedure":
            ctx.ui.notify(handleProcedureInspect(parts[1], store), "info");
            return;
          case "memory":
            ctx.ui.notify(handleMemoryInspect(parts[1], store), "info");
            return;
          case "config":
            ctx.ui.notify(JSON.stringify(config, null, 2), "info");
            return;
          default:
            ctx.ui.notify(
              `Unknown brain command: ${sub}. Available: status, sync, consolidate, evolve, experience, procedure, memory, config`,
              "error",
            );
        }
      } catch (err) {
        process.stderr.write(`brain: /brain command error: ${errMsg(err)}\n`);
        ctx.ui.notify(`brain: command failed: ${errMsg(err)}`, "error");
      }
    },
  });
}

// ── Helper functions for tools/commands ────────────────────────

function handleEvolveAction(action: string, target: string | undefined, store: BrainStore, config: BrainConfig): string {
  switch (action) {
    case "status": {
      const active = listActiveSkills(config);
      const candidates = listCandidates(config);
      const memStats = store.getMemoryStats();
      const procStats = store.getProcedureStats();
      return [
        "## Brain Evolution Status",
        "",
        `**Memories:** ${memStats.active} active, ${memStats.frozen} frozen, ${memStats.archived} archived`,
        `**Procedures:** ${procStats.tentative} tentative, ${procStats.reinforced} reinforced, ${procStats.mature} mature`,
        `**Active learned skills:** ${active.length}${active.length ? " (" + active.map((s) => s.name).join(", ") + ")" : ""}`,
        `**Candidate skills:** ${candidates.length}${candidates.length ? " (" + candidates.map((s) => s.name).join(", ") + ")" : ""}`,
      ].join("\n");
    }
    case "candidates":
      return JSON.stringify(listCandidates(config), null, 2);
    case "inspect":
      if (!target) return "Usage: evolve inspect <skill-name>";
      return JSON.stringify(store.db.prepare("SELECT * FROM skill_versions WHERE name = ? ORDER BY created_at DESC").all(target), null, 2);
    case "history":
      if (!target) return "Usage: evolve history <skill-name>";
      return JSON.stringify(
        store.db
          .prepare(
            "SELECT er.* FROM evolution_runs er JOIN skill_versions sv ON er.skill_version_id = sv.id WHERE sv.name = ? ORDER BY er.created_at DESC LIMIT 10",
          )
          .all(target),
        null,
        2,
      );
    case "policy":
      return JSON.stringify(config.evolution, null, 2);
    default:
      return `Unknown evolve action: ${action}. Available: status, candidates, inspect, history, policy`;
  }
}

function handleBrainStatus(
  store: BrainStore,
  config: BrainConfig,
  embedStats?: { successes: number; failures: number; inFlight: number },
): string {
  const memStats = store.getMemoryStats();
  const procStats = store.getProcedureStats();
  const active = listActiveSkills(config);
  const candidates = listCandidates(config);
  const recentLogs = store.getRecentLogs(3);

  return [
    "## Brain Status",
    "",
    "### Memories",
    `  Active: ${memStats.active} | Frozen: ${memStats.frozen} | Archived: ${memStats.archived}`,
    "",
    "### Procedures",
    `  Tentative: ${procStats.tentative} | Reinforced: ${procStats.reinforced} | Mature: ${procStats.mature}`,
    "",
    "### Evolution",
    `  Active skills: ${active.length}${active.length ? " (" + active.map((s) => s.name).join(", ") + ")" : ""}`,
    `  Candidates: ${candidates.length}`,
    "",
    "### Vault",
    `  Location: ${config.markdownRoot}`,
    "",
    ...(embedStats
      ? [`### Embeddings`, `  ${embedStats.successes} ok, ${embedStats.failures} failed, ${embedStats.inFlight} in-flight`, ""]
      : []),
    "### Recent Activity",
    ...recentLogs.map((l) => `  [${l.createdAt}] ${l.kind}: ${l.details.slice(0, 100)}`),
  ].join("\n");
}

/** Mutating evolution operations — reachable only from the `/brain evolve` slash
 * command, never from the `evolve` tool (which is read-only observability). */
function handleEvolveCommand(action: string, target: string, store: BrainStore, config: BrainConfig): string {
  switch (action) {
    case "promote": {
      if (!target) return "Usage: /brain evolve promote <skill-name>";
      const candidates = listCandidates(config).filter((c) => c.name === target);
      if (!candidates.length) return `No candidate found for "${target}"`;
      try {
        promoteCandidate(target, candidates[0].versionHash, config, store);
        return `Promoted ${target} (${candidates[0].versionHash})`;
      } catch (err) {
        return `Promotion failed: ${errMsg(err)}`;
      }
    }
    case "reject": {
      if (!target) return "Usage: /brain evolve reject <skill-name>";
      const candidates = listCandidates(config).filter((c) => c.name === target);
      if (!candidates.length) return `No candidate found for "${target}"`;
      try {
        rejectCandidate(target, candidates[0].versionHash, config, store);
        return `Rejected ${target} (${candidates[0].versionHash})`;
      } catch (err) {
        return `Rejection failed: ${errMsg(err)}`;
      }
    }
    case "rollback": {
      if (!target) return "Usage: /brain evolve rollback <skill-name>";
      try {
        const restored = rollbackSkill(target, config, store);
        return restored ? `Rolled back ${target} to version ${restored.versionHash}` : `Cannot rollback ${target}: no parent version`;
      } catch (err) {
        return `Rollback failed: ${errMsg(err)}`;
      }
    }
    case "evaluate":
      return "Manual evaluation not yet implemented. Use automatic evaluation via mature procedures.";
    default:
      return `Unknown evolve command: ${action}`;
  }
}

export function handleExperienceInspect(id: string | undefined, store: BrainStore): string {
  if (!id) return "Usage: /brain experience <id>";
  const exp = store.getExperience(id);
  if (!exp) return `Experience "${id}" not found`;
  const enriched = {
    ...exp,
    startedAtHuman: exp.startedAt ? fmtDateTime(exp.startedAt) : undefined,
    settledAtHuman: exp.settledAt ? fmtDateTime(exp.settledAt) : undefined,
    age: fmtAge(exp.startedAt),
  };
  return JSON.stringify(enriched, null, 2);
}

function handleProcedureInspect(key: string | undefined, store: BrainStore): string {
  if (!key) return "Usage: /brain procedure <key>";
  const proc = store.getProcedure(key);
  if (!proc) return `Procedure "${key}" not found`;
  return JSON.stringify(proc, null, 2);
}

export function handleMemoryInspect(idStr: string | undefined, store: BrainStore): string {
  if (!idStr) return "Usage: /brain memory <id>";
  const id = Number(idStr);
  if (isNaN(id)) return `Invalid memory ID: ${idStr}`;
  const mem = store.getMemory(id);
  if (!mem) return `Memory #${id} not found`;
  const evidence = store.getMemoryEvidence(id);
  const enriched = {
    ...mem,
    evidence,
    createdAtHuman: mem.createdAt ? fmtDateTime(mem.createdAt) : undefined,
    lastAccessedHuman: mem.lastAccessed ? fmtDateTime(mem.lastAccessed) : undefined,
    age: fmtAge(mem.lastAccessed ?? mem.createdAt),
  };
  return JSON.stringify(enriched, null, 2);
}
