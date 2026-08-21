import * as fs from "node:fs";
import * as path from "node:path";
import type { BrainConfig, MemoryScope, Procedure, EvalVerdict } from "./types.ts";

// ── Safety Boundaries (hardcoded, never configurable) ─────────────────
export const SAFETY_BOUNDARIES: readonly string[] = Object.freeze([
  "Brain kernel files cannot be modified by the agent",
  "SOUL constitutional rules cannot be modified by the agent",
  "Evaluation policy cannot be modified by the agent",
  "Provenance classification cannot be overridden by LLM output",
  "Active skills cannot be hot-swapped mid-session",
]);

// ── Global scope indicators ──────────────────────────────────────────
const GLOBAL_INDICATORS = [
  /\balways\b/i,
  /\beverywhere\b/i,
  /\bin general\b/i,
  /\bfor all\b/i,
  /\buniversally\b/i,
  /\bglobal(?:ly)?\b/i,
];

// ── Project scope indicators ─────────────────────────────────────────
const PROJECT_INDICATORS = [
  /\bthis project\b/i,
  /\bthis repo\b/i,
  /\bhere\b/i,
  /\bin this (?:codebase|directory|folder)\b/i,
  /\bfor this\b/i,
];

export function inferScope(
  userText: string,
  cwd: string,
  config: BrainConfig,
): MemoryScope {
  // Check for explicit global indicators
  for (const pattern of GLOBAL_INDICATORS) {
    if (pattern.test(userText)) return "global";
  }

  // Check for explicit project indicators
  for (const pattern of PROJECT_INDICATORS) {
    if (pattern.test(userText)) return "project";
  }

  // Check if user text mentions the project name
  const projectKey = detectProjectKey(cwd, config);
  if (projectKey) {
    const projectName = path.basename(projectKey);
    if (userText.toLowerCase().includes(projectName.toLowerCase())) {
      return "project";
    }
  }

  // Use configured default
  const defaultScope = config.scoping.defaultScope;
  if (defaultScope === "infer") {
    // Conservative: default to project if we can detect one, else global
    return projectKey ? "project" : "global";
  }
  return defaultScope;
}

export function detectProjectKey(
  cwd: string,
  config: BrainConfig,
): string | null {
  switch (config.scoping.projectDetection) {
    case "git-root": {
      // Walk up from cwd looking for .git
      let dir = path.resolve(cwd);
      const root = path.parse(dir).root;
      while (dir !== root) {
        if (fs.existsSync(path.join(dir, ".git"))) {
          return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return null;
    }

    case "package-json": {
      // Walk up from cwd looking for package.json
      let dir = path.resolve(cwd);
      const root = path.parse(dir).root;
      while (dir !== root) {
        const pkg = path.join(dir, "package.json");
        if (fs.existsSync(pkg)) {
          try {
            const json = JSON.parse(fs.readFileSync(pkg, "utf-8"));
            return json.name || dir;
          } catch {
            return dir;
          }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return null;
    }

    case "cwd":
      return cwd;

    case "explicit":
      // Only use project scope when explicitly stated
      return null;

    default:
      return null;
  }
}

export function isPromotionEligible(
  proc: Procedure,
  evalResult: EvalVerdict,
  config: BrainConfig,
): boolean {
  // Must pass all eval cases
  if (!evalResult.pass) return false;

  // Must have hard checks all passing
  if (evalResult.hardCheckResults.some(c => !c.passed)) return false;

  // Must meet success ratio
  const total = proc.successCount + proc.failureCount;
  if (total > 0 && proc.successCount / total < config.evolution.maturity.minSuccessRatio) {
    return false;
  }

  // Must not be contradicted (if required)
  if (config.evolution.maturity.requireNoContradictions && proc.status === "contradicted") {
    return false;
  }

  return true;
}
