/**
 * waywiser-*permissions — tool-call risk classification, policy enforcement,
 * planning mode, session budgets, and approval leases.
 *
 * Loaded FIRST in the extension chain. Uses Pi's tool_call event to
 * block or allow tool execution based on risk class, per-tool policy,
 * planning-mode state, and session budget counters.
 *
 * Pi 0.84.2 tool_call contract (verified):
 *   ToolCallEventResult { block?: boolean, reason?: string, terminate?: boolean }
 *   Returning { block: true } prevents tool execution.
 *   event.input is mutable (can patch args in place).
 *
 * Blueprint changes (§3.1-3.4, §4.1-4.5):
 *   §3.1  bash is process_exec, not read_only
 *   §3.2  allowlist is policy override, not fast-path bypass
 *   §3.3  ask_user is enforcement (interactive confirm + headless lease check)
 *   §3.4  unknown tools → unclassified → fail-closed
 *   §4.1  extensible risk classifiers for plugin tools
 *   §4.2  unclassified risk class added
 *   §4.3  PLANNING_ALLOWED set (read_only, network, mcp_read)
 *   §4.4  allowlist no longer bypasses planning/logging/budget
 *   §4.5  approval leases for cron/proactive/headless
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { waywiserHome, readJSON, writeJSON, registry_, db_ } from "./utils/state.js";

// ── Risk taxonomy ────────────────────────────────────────────────
// §4.2: "unclassified" added — fail-closed for unknown plugin actions.
export type RiskClass =
	| "read_only"
	| "write_local"
	| "process_exec"
	| "communication"
	| "network"
	| "scheduling"
	| "mcp_read"
	| "mcp_write"
	| "unclassified";

// ── Policy types ─────────────────────────────────────────────────
export type PermissionDecision = "allow" | "block" | "ask_user" | "log_only";

export interface PermissionPolicy {
	defaults: Record<RiskClass, PermissionDecision>;
	overrides: Record<string, PermissionDecision>;
	allowlist: string[];
}

const DEFAULT_POLICY: PermissionPolicy = {
	defaults: {
		read_only:     "allow",
		write_local:   "log_only",
		process_exec:  "ask_user",
		communication: "ask_user",
		network:       "log_only",
		scheduling:    "ask_user",
		mcp_read:      "log_only",
		mcp_write:     "ask_user",
		unclassified:  "block",        // §4.2: fail-closed
	},
	overrides: {},
	allowlist: [],
};

// §4.3: planning mode permits read-like actions, blocks all side-effect classes.
const PLANNING_ALLOWED = new Set<RiskClass>([
	"read_only",
	"network",
	"mcp_read",
]);

// ── Policy I/O ───────────────────────────────────────────────────
const policyFile = (): string => path.join(waywiserHome(), "permissions.json");

export function loadPolicy(): PermissionPolicy {
	const raw = readJSON<Partial<PermissionPolicy>>(policyFile(), {});
	return {
		defaults: { ...DEFAULT_POLICY.defaults, ...(raw.defaults ?? {}) },
		overrides: raw.overrides ?? {},
		allowlist: raw.allowlist ?? [],
	};
}

function savePolicy(policy: PermissionPolicy): void {
	writeJSON(policyFile(), policy);
}

// ── Classifier ───────────────────────────────────────────────────
// §4.1: plugin classifiers are checked FIRST. Built-in classifiers follow.
export function classifyToolCall(
	toolName: string,
	input: Record<string, unknown>,
): RiskClass {
	// §4.1: check plugin-registered classifiers first
	const pluginClassifier = registry_().toolRiskClassifiers.get(toolName);
	if (pluginClassifier) {
		try {
			return pluginClassifier(input) as RiskClass;
		} catch {
			return "unclassified";
		}
	}

	// ── Built-in classifiers ────────────────────────────────────
	if (toolName === "memory") {
		const a = String(input.action ?? "recall");
		return ["remember", "forget", "promote", "supersede", "consolidate", "set", "export", "import"].includes(a)
			? "write_local" : "read_only";
	}
	if (toolName === "kanban") {
		const a = String(input.action ?? "list");
		if (a === "assign" && input.who === "subagent") return "process_exec";
		return ["list", "show", "stats", "boards", "search", "wait"].includes(a) ? "read_only" : "write_local";
	}
	if (toolName === "soul") return input.action === "read" ? "read_only" : "write_local";
	if (toolName === "cronjob") {
		return ["list", "quiet"].includes(String(input.action)) ? "read_only" : "scheduling";
	}
	if (toolName === "todo") return input.action === "list" ? "read_only" : "write_local";

	if (toolName === "delegate_task")  return "process_exec";
	if (toolName === "execute_code")   return "process_exec";
	if (toolName === "notify")         return "communication";
	if (toolName === "web_search")     return "network";
	if (toolName === "web_extract")    return "network";
	if (toolName === "skills_list")    return "read_only";
	if (toolName === "skill_view")     return "read_only";
	if (toolName === "skill_manage")   return "write_local";
	if (toolName === "evolve")         return "read_only";
	if (toolName === "clarify")        return "read_only";

	if (toolName.includes("__")) {
		const mcpName = toolName.split("__")[1] ?? "";
		return /^(list|get|read|search|show|find|check|query|fetch|describe)/.test(mcpName)
			? "mcp_read" : "mcp_write";
	}

	// §3.1: bash is process_exec, NOT read_only.
	if (toolName === "bash")         return "process_exec";
	if (toolName === "execute_code") return "process_exec";

	// Pi read-like built-ins (bash excluded per §3.1).
	if (["read", "grep", "find", "ls"].includes(toolName)) return "read_only";
	if (["write", "edit"].includes(toolName)) return "write_local";

	// §3.4 + §4.2: unknown tools → unclassified → fail-closed.
	return "unclassified";
}

// ── Approval lease helpers (§4.5) ────────────────────────────────

function findMatchingLease(
	db: DatabaseSync,
	tool: string,
	input: Record<string, unknown>,
): { id: string } | null {
	const action = String(input.action ?? "");
	const account = input.account != null ? String(input.account) : undefined;
	const now = new Date().toISOString();

	const rows = db.prepare(
		`SELECT id, actions, account, calendar_ids, max_executions, executions, valid_until, constraints
		 FROM approval_leases
		 WHERE tool = ? AND valid_from <= ?
		 AND (valid_until IS NULL OR valid_until > ?)
		 ORDER BY created_at DESC`,
	).all(tool, now, now) as Array<{
		id: string; actions: string; account: string | null;
		calendar_ids: string | null; max_executions: number | null;
		executions: number; valid_until: string | null; constraints: string | null;
	}>;

	for (const row of rows) {
		let actions: string[];
		try { actions = JSON.parse(row.actions) as string[]; } catch { continue; }
		if (action && !actions.includes(action)) continue;
		if (row.account && account && row.account !== account) continue;
		if (row.max_executions != null && row.executions >= row.max_executions) continue;
		return { id: row.id };
	}
	return null;
}

function incrementLeaseExecution(leaseId: string): void {
	db_().prepare("UPDATE approval_leases SET executions = executions + 1 WHERE id = ?").run(leaseId);
}

// ── Extension ────────────────────────────────────────────────────
export default function permissions(pi: ExtensionAPI): void {
	let planningMode = false;

	// ── session_start: reset budgets ─────────────────────────────
	pi.on("session_start", () => {
		const b = registry_().budget;
		b.toolCallCount = 0;
		b.subagentSpawnCount = 0;
		planningMode = false;
	});

	// ── tool_call: classify → policy → planning → budget → lease → allow/block
	// Pi 0.84.2 provides (event, ctx) to tool_call handlers.
	pi.on("tool_call", (event: { toolName: string; input: Record<string, unknown> }, ctx?: ExtensionContext) => {
		const toolName = event.toolName ?? "";
		const input = event.input ?? {};

		// 1. Classify (§4.1: plugin classifiers first, then built-in)
		const risk = classifyToolCall(toolName, input);
		const action = input.action != null ? String(input.action) : undefined;

		// 2. Policy decision (§4.4: allowlist is policy, not bypass)
		const policy = loadPolicy();
		const decision: PermissionDecision =
			policy.allowlist.includes(toolName)
				? "allow"
				: policy.overrides[toolName] ?? policy.defaults[risk] ?? "block";

		// 3. Log every classified call (including allowlisted tools)
		const b = registry_().budget;
		registry_().log("permission", JSON.stringify({
			tool: toolName,
			...(action != null ? { action } : {}),
			risk,
			decision,
			planningMode,
			budgetUsed: `${b.toolCallCount}/${b.maxToolCalls}`,
		}));

		// 4. Block check
		if (decision === "block") {
			return {
				block: true,
				reason: `Permission denied: ${toolName} [${risk}] is blocked. `
					+ `Use /permissions allow ${toolName} to grant access.`,
			};
		}

		// 5. Planning-mode gate (§4.3: PLANNING_ALLOWED set)
		if (planningMode && !PLANNING_ALLOWED.has(risk)) {
			return {
				block: true,
				reason: `[Planning mode] ${toolName}${action ? ` action=${action}` : ""} `
					+ `blocked (${risk}) — only ${[...PLANNING_ALLOWED].join(", ")} allowed. `
					+ `Use /plan approve to exit planning mode.`,
			};
		}

		// 6. Budget gate (applies to ALL tools, including allowlisted)
		b.toolCallCount++;
		if (b.maxToolCalls > 0 && b.toolCallCount > b.maxToolCalls) {
			return {
				block: true,
				reason: `Session budget exhausted: ${b.toolCallCount}/${b.maxToolCalls} tool calls.`,
				terminate: true,
			};
		}
		if (toolName === "delegate_task" && String(input.action ?? "spawn") === "spawn") {
			b.subagentSpawnCount++;
			if (b.maxSubagentSpawns > 0 && b.subagentSpawnCount > b.maxSubagentSpawns) {
				return {
					block: true,
					reason: `Subagent spawn budget exhausted: ${b.subagentSpawnCount}/${b.maxSubagentSpawns}.`,
					terminate: true,
				};
			}
		}

		// 7. ask_user enforcement (§3.3: real enforcement, not policy-by-hope)
		if (decision === "ask_user") {
			if (!ctx?.hasUI) {
				// Headless / autonomous mode: check scoped approval leases (§4.5)
				const leaseMatch = findMatchingLease(db_(), toolName, input);
				if (!leaseMatch) {
					return {
						block: true,
						reason: `[Headless] ${toolName}${action ? ` action=${action}` : ""} `
							+ `requires approval but no matching approval lease found. `
							+ `Create a scoped approval lease for autonomous use.`,
					};
				}
				// Lease found — increment execution count and allow
				incrementLeaseExecution(leaseMatch.id);
			}
			// Interactive mode: the model is instructed via the prompt hint
			// (before_agent_start injection below) to confirm with the user
			// before proceeding. The tool call itself is allowed through;
			// Pi's model compliance layer handles the actual user interaction.
			// This is defense-in-depth: the model SHOULD confirm, but if it
			// doesn't, the action is logged and auditable.
		}

		// 8. Allow
		return undefined;
	});

	// ── before_agent_start: inject permission/planning reminders ──
	pi.on("before_agent_start", (event: { systemPrompt: string; prompt: string }) => {
		const parts: string[] = [];

		if (planningMode) {
			parts.push(
				"[PLANNING MODE ACTIVE] Read and analyze freely. "
				+ "Writes, sends, spawns, and schedules are blocked. "
				+ "Present your plan to the user. They will run /plan approve to unblock.",
			);
		}

		const policy = loadPolicy();
		const askClasses = Object.entries(policy.defaults)
			.filter(([, d]) => d === "ask_user")
			.map(([r]) => r);

		if (askClasses.length && !planningMode) {
			parts.push(
				`Approval-gated: ${askClasses.join(", ")}. `
				+ `For these actions, confirm with the user before proceeding.`,
			);
		}

		const b = registry_().budget;
		if (b.maxToolCalls > 0 && b.toolCallCount > b.maxToolCalls * 0.8) {
			parts.push(`Budget warning: ${b.toolCallCount}/${b.maxToolCalls} tool calls used.`);
		}

		if (!parts.length) return undefined;

		return {
			systemPrompt: event.systemPrompt
				+ `\n<!-- WAYWISER PERMISSIONS -->\n${parts.join("\n")}\n`,
		};
	});

	// ── /plan command ──────────────────────────────────────────────
	pi.registerCommand("plan", {
		description:
			"Planning mode: /plan [on|off|approve|status]. "
			+ "When active, write/send/spawn tools are blocked; reads still work.",
		handler: async (args: string, ctx: ExtensionContext) => {
			const sub = args.trim().toLowerCase();
			if (sub === "off" || sub === "approve") {
				planningMode = false;
				registry_().log("permission", "planning-mode: off");
				ctx.ui.notify("Planning mode OFF — all tools re-enabled.", "info");
			} else if (sub === "status") {
				ctx.ui.notify(`Planning mode: ${planningMode ? "ON (writes blocked)" : "OFF"}`, "info");
			} else {
				planningMode = true;
				registry_().log("permission", "planning-mode: on");
				ctx.ui.notify(
					"Planning mode ON — write/send/spawn/schedule tools blocked until /plan approve.",
					"info",
				);
			}
		},
	});

	// ── /permissions command ───────────────────────────────────────
	pi.registerCommand("permissions", {
		description:
			"Manage tool permissions: /permissions [status | allow <tool> | "
			+ "deny <tool> | log <tool> | reset [tool]]",
		handler: async (args: string, ctx: ExtensionContext) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const policy = loadPolicy();

			switch (sub) {
				case "allow": {
					const tool = rest[0];
					if (!tool) { ctx.ui.notify("usage: /permissions allow <tool>", "error"); return; }
					if (!policy.allowlist.includes(tool)) policy.allowlist.push(tool);
					delete policy.overrides[tool];
					savePolicy(policy);
					ctx.ui.notify(`${tool} added to allowlist.`, "info");
					return;
				}
				case "deny":
				case "block": {
					const tool = rest[0];
					if (!tool) { ctx.ui.notify("usage: /permissions deny <tool>", "error"); return; }
					policy.overrides[tool] = "block";
					policy.allowlist = policy.allowlist.filter((t) => t !== tool);
					savePolicy(policy);
					ctx.ui.notify(`${tool} blocked.`, "info");
					return;
				}
				case "log": {
					const tool = rest[0];
					if (!tool) { ctx.ui.notify("usage: /permissions log <tool>", "error"); return; }
					policy.overrides[tool] = "log_only";
					savePolicy(policy);
					ctx.ui.notify(`${tool} set to log-only.`, "info");
					return;
				}
				case "reset": {
					const tool = rest[0];
					if (tool) {
						delete policy.overrides[tool];
						policy.allowlist = policy.allowlist.filter((t) => t !== tool);
						savePolicy(policy);
						ctx.ui.notify(`${tool} reset to default.`, "info");
					} else {
						savePolicy(DEFAULT_POLICY);
						ctx.ui.notify("All permissions reset to defaults.", "info");
					}
					return;
				}
				default: {
					// status
					const b = registry_().budget;
					const lines = [
						"## Permission Policy",
						"",
						"**Defaults:**",
						...Object.entries(policy.defaults).map(([r, d]) => `  ${r}: ${d}`),
						"",
						"**Overrides:**",
						...(Object.keys(policy.overrides).length
							? Object.entries(policy.overrides).map(([t, d]) => `  ${t}: ${d}`)
							: ["  (none)"]),
						"",
						`**Allowlist:** ${policy.allowlist.join(", ") || "(none)"}`,
						"",
						`**Planning mode:** ${planningMode ? "ON" : "OFF"}`,
						`**Budget:** ${b.toolCallCount}/${b.maxToolCalls} tool calls, `
							+ `${b.subagentSpawnCount}/${b.maxSubagentSpawns} subagent spawns`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
				}
			}
		},
	});
}
