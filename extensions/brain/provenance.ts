import type { ProvenanceSource, BrainConfig } from "./types.ts";

const ENVIRONMENT_TOOLS = new Set([
  "read", "edit", "write", "grep", "find", "ls", "bash",
]);

const EXTERNAL_TOOLS = new Set([
  "web_search", "web_fetch",
]);

export function classifyToolProvenance(toolName: string): ProvenanceSource {
  if (ENVIRONMENT_TOOLS.has(toolName)) return "environment";
  if (EXTERNAL_TOOLS.has(toolName)) return "external";
  if (toolName.startsWith("mcp__")) return "external";
  return "agent";
}

export function classifyEventProvenance(
  eventType: string,
  role?: string,
): ProvenanceSource {
  if (eventType === "turn_end" && role === "user") return "user";
  if (eventType === "turn_end" && role === "assistant") return "agent";
  if (eventType === "tool_result") return "environment";
  return "agent";
}

export function confidenceForSource(
  source: ProvenanceSource,
  config: BrainConfig,
): number {
  switch (source) {
    case "user": return config.provenance.userConfidence;
    case "agent": return config.provenance.agentConfidence;
    case "external": return config.provenance.externalConfidence;
    case "environment": return config.provenance.environmentConfidence;
    case "existing-memory": return 0.5;
    default: return 0.5;
  }
}

export function isCallFromUser(ctx: Record<string, unknown>): boolean {
  return ctx?.inputSource === "command" || ctx?.isCommand === true;
}
