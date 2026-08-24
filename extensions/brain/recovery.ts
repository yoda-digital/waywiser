/**
 * waywiser-brain — deterministic recovery linking.
 *
 * Pure functions used by the trace module (and later by the learner) to
 * turn a flat list of tool observations into a graph where a successful
 * tool call that touches the same target as a prior failure is marked as
 * that failure's recovery. Everything here is deterministic — no model
 * calls, no heuristics beyond string/path comparison — so it can run
 * synchronously inline with tool events (spec §4.4).
 */
import * as os from "node:os";
import * as path from "node:path";
import type { Observation } from "./types.js";

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a file path: resolve `.`, `..`, `~`, relative paths.
 * Returns an absolute path.
 */
export function normalizePath(p: string, cwd: string): string {
  let expanded = p;
  if (expanded === "~") {
    expanded = os.homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  // path.resolve ignores `cwd` whenever `expanded` is already absolute, and
  // normalizes `.`/`..` segments either way — one call handles both cases.
  return path.resolve(cwd, expanded);
}

// ---------------------------------------------------------------------------
// Bash target extraction (conservative — spec §4.4)
// ---------------------------------------------------------------------------

const FILE_COMMANDS = new Set([
  "cat", "rm", "cp", "mv", "mkdir", "chmod", "chown", "touch",
  "head", "tail", "less", "more", "wc", "stat", "file",
]);

function extractBashTarget(command: string, cwd: string): string {
  const trimmed = command.trim();
  // Strip leading env vars (FOO=bar cmd ...)
  const withoutEnv = trimmed.replace(/^(\w+=\S+\s+)*/, "");
  const parts = withoutEnv.split(/\s+/);
  const cmd = parts[0]?.replace(/^.*\//, ""); // basename of command

  if (cmd && FILE_COMMANDS.has(cmd)) {
    // Find first non-flag argument
    for (let i = 1; i < parts.length; i++) {
      if (!parts[i].startsWith("-")) {
        return normalizePath(parts[i], cwd);
      }
    }
  }

  return trimmed.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Target key extraction
// ---------------------------------------------------------------------------

/**
 * Extract a canonical target key from a tool call's input.
 * Deterministic per tool — see target key table in spec §4.4.
 */
export function extractTargetKey(toolName: string, input: Record<string, unknown>, cwd: string): string {
  switch (toolName) {
    case "read":
    case "edit":
    case "write": {
      // Pi's built-in read/edit/write tools use `path`; accept `file_path`
      // for compatibility with other harnesses. Fall back to a sentinel key
      // rather than normalizing "" to cwd — otherwise every pathless failure
      // (e.g. edit blocked on a permission error) would all share one target.
      const p = input.path ?? input.file_path;
      return p !== undefined && p !== null
        ? normalizePath(String(p), cwd)
        : `${toolName}:?`;
    }

    case "grep": {
      const pattern = String(input.pattern ?? "");
      const targetPath = input.path !== undefined ? normalizePath(String(input.path), cwd) : "";
      return `${pattern}@${targetPath}`;
    }

    case "find":
    case "ls":
      return normalizePath(String(input.path ?? ""), cwd);

    case "bash":
      return extractBashTarget(String(input.command ?? ""), cwd);

    case "web_search":
      return String(input.query ?? "");

    case "web_fetch":
      return String(input.url ?? "");

    default: {
      const firstStringArg = Object.values(input).find((v): v is string => typeof v === "string");
      return firstStringArg !== undefined ? `${toolName}:${firstStringArg}` : toolName;
    }
  }
}

// ---------------------------------------------------------------------------
// Recovery linking
// ---------------------------------------------------------------------------

/**
 * Given a list of observations (in chronological order), link recoveries:
 * when a success observation shares a target key with a prior error,
 * set `recoveryOf` on the success observation.
 * Returns a new array with recovery links set (does not mutate input).
 */
export function linkRecoveries(observations: Observation[]): Observation[] {
  const result = observations.map((o) => ({ ...o }));
  // Tracks error ids already claimed as some success's recovery target, so
  // a single failure is credited as "recovered" at most once even when
  // several later successes touch the same target key.
  const claimedErrorIds = new Set<string>();

  for (let i = 0; i < result.length; i++) {
    const obs = result[i];
    if (obs.result !== "success" || !obs.targetKey) continue;

    for (let j = i - 1; j >= 0; j--) {
      const prior = result[j];
      if (prior.result === "error" && prior.targetKey === obs.targetKey && !claimedErrorIds.has(prior.id)) {
        obs.recoveryOf = prior.id;
        claimedErrorIds.add(prior.id);
        break; // link to most recent matching failure only
      }
    }
  }

  return result;
}
