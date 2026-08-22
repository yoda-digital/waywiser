/**
 * waywiser-*delegate — delegate_task with waywiser-* semantics.
 *
 * - action: spawn (default) | collect | list | steer | stop
 * - spawn: backgrounded in TUI (report surfaced on agent_end); blocking in
 *   print/RPC mode where there is no UI to poll.
 * - Leaves (role="leaf", default) run WITHOUT the waywiser-* extensions -> they
 *   cannot delegate, no clarify, no memory. role="orchestrator" runs WITH the
 *   extensions and may spawn children (depth-capped at 2).
 * - Concurrent child cap: ~/.waywiser/config.json { "maxConcurrentChildren": n }
 *   or WAYWISER_MAX_CHILDREN (default 3) — waywiser-* delegation.max_concurrent_children.
 * - Children are `pi --mode rpc --no-session --no-context-files --no-skills`;
 *   reports parsed from the "WAYWISER_REPORT: DONE|FAILED" marker line.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSubagentPrompt, waywiserHome, readJSON, registry_, shortId } from "./utils/state.js";
import { createPiRpcClient, createPiRpcPool, type PiRpcClient } from "./utils/rpc.js";

const MAX_DEPTH = 2;
const RETAIN_FINISHED = 10;
const OUR_EXTENSION = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

interface Child {
	id: string;
	goal: string;
	role: "leaf" | "orchestrator";
	lane: string;
	status: "running" | "done" | "failed" | "stopped";
	startedAt: number;
	finishedAt?: number;
	report?: string;
	exitNote?: string;
	rpc?: PiRpcClient;
}

/**
 * Warm pool for subagent children. Lanes are versioned by role AND parent
 * depth: a child inherits its WAYWISER_DEPTH from the pi env at spawn time, so
 * an idle client spawned for a depth-0 parent must never serve a depth-1 parent
 * (that would silently grant one extra nesting level). Semantics preserved:
 * action=stop still KILLs the child (stop() + release() unwires pool
 * bookkeeping, which re-detects the dead client and drops it from the lane).
 */
let delegatePool: ReturnType<typeof createPiRpcPool> | null = null;
function getDelegatePool(): ReturnType<typeof createPiRpcPool> {
	if (!delegatePool) {
		delegatePool = createPiRpcPool({
			maxIdle: 1,
			idleTtlMs: 5 * 60_000,
			spawn: (lane, cwd) => {
				const sep = lane.lastIndexOf("@d");
				const role = sep >= 0 ? lane.slice(0, sep) : lane;
				const dpart = sep >= 0 ? lane.slice(sep + 2) : "1";
				const args = role === "orche" ? ORCHESTRATOR_ARGS : LEAF_ARGS;
				return createPiRpcClient({
					cwd,
					args,
					env: { ...process.env, WAYWISER_DEPTH: dpart },
				});
			},
		});
	}
	return delegatePool;
}

const LEAF_ARGS = ["--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"];
const ORCHESTRATOR_ARGS = ["--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--extension", OUR_EXTENSION];

function maxConcurrent(): number {
	try {
		const cfg = readJSON<{ maxConcurrentChildren?: number }>(path.join(waywiserHome(), "config.json"), {});
		if (cfg.maxConcurrentChildren && cfg.maxConcurrentChildren > 0) return cfg.maxConcurrentChildren;
	} catch {
		/* ignore */
	}
	const env = Number(process.env.WAYWISER_MAX_CHILDREN);
	return Number.isFinite(env) && env > 0 ? env : 3;
}

export default function delegate(pi: ExtensionAPI): void {
	const children = new Map<string, Child>();
	const depth = Number(process.env.WAYWISER_DEPTH || 0) || 0;
	const notified = new Set<string>();

	const running = (): number => [...children.values()].filter((c) => c.status === "running").length;

	const trimFinished = (): void => {
		const done = [...children.values()]
			.filter((c) => c.status !== "running")
			.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
		for (const c of done.slice(RETAIN_FINISHED)) children.delete(c.id);
	};

	const normalizeRole = (r?: string): "leaf" | "orchestrator" => (r === "orchestrator" ? "orchestrator" : "leaf");

	const childReport = (c: Child): string => `Subagent ${c.id} [${c.status.toUpperCase()}] goal: "${c.goal}"\nReport:\n${c.report ?? c.exitNote ?? "(none)"}`;

	const killChild = (child: Child): void => {
		if (child.status === "running") {
			child.status = "stopped";
			child.finishedAt = Date.now();
			try {
				child.rpc?.stop();
			} catch {
				/* ignore */
			}
			registry_().log("delegate", `${child.id} stopped`);
		}
	};

	const runChild = (child: Child, context: string | undefined, role: "leaf" | "orchestrator", cwd: string): void => {
		void (async () => {
			let rpc: PiRpcClient;
			try {
				const lane = `${role === "orchestrator" ? "orche" : "leaf"}@d${depth + 1}`;
				child.lane = lane;
				rpc = await getDelegatePool().acquire(lane, { cwd });
				child.rpc = rpc;
			} catch (e) {
				child.status = "failed";
				child.finishedAt = Date.now();
				child.exitNote = String(e);
				child.report = `Subagent ${child.id} FAILED: child could not start: ${String(e)}`;
				return;
			}
			const prompt = buildSubagentPrompt({ goal: child.goal, context, reportLine: "WAYWISER_REPORT: DONE" });
			let text = "";
			try {
				const res = await rpc.command({ type: "prompt", message: prompt }, 60_000);
				if (!res.success) throw new Error(`prompt rejected: ${JSON.stringify(res).slice(0, 200)}`);
				await rpc.waitAgentEnd(30 * 60_000);
				text = await rpc.getLastAssistantText(5_000);
				child.status = "done";
			} catch (e) {
				child.status = "failed";
				child.exitNote = String(e);
			} finally {
				child.finishedAt = Date.now();
				child.rpc = undefined;
				getDelegatePool().release(child.lane, rpc);
			}
			// Parse the report marker (waywiser-* report contract).
			const idx = text.lastIndexOf("WAYWISER_REPORT:");
			if (idx >= 0) {
				const lineEnd = text.indexOf("\n", idx);
				const marker = text.slice(idx, lineEnd < 0 ? text.length : lineEnd).trim();
				const body = lineEnd < 0 ? "" : text.slice(lineEnd + 1).trim();
				if (/FAILED/i.test(marker)) {
					child.status = "failed";
					child.exitNote = child.exitNote || "subagent reported failure";
				}
				child.report = body || text.trim() || "(empty report)";
			} else if (child.status === "done") {
				child.report = text.trim() || "(no final text)";
			}
			registry_().log("delegate", `${child.id} ${child.status}: ${child.goal.slice(0, 80)}`);
		})();
	};

	pi.on("session_start", () => {
		notified.clear();
	});

	// Surface completed backgrounded children to the parent, after the current turn.
	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("waywiser-*:delegate", `subagents ${running()} running`);
		const fresh = [...children.values()].filter((c) => c.status !== "running" && c.finishedAt && !notified.has(c.id));
		for (const c of fresh) notified.add(c.id);
		if (fresh.length === 0) return;
		try {
			pi.sendUserMessage(`[waywiser-*] ${fresh.length} delegated subagent(s) finished:\n\n${fresh.map(childReport).join("\n\n---\n\n")}`, {
				deliverAs: "followUp",
			});
		} catch {
			/* parent shutting down */
		}
	});

	pi.on("session_shutdown", () => {
		// 1. Kill any still-running children.
		for (const [, child] of children) {
			if (child.status === "running") killChild(child);
		}
		// 2. Shut down idle pool clients (only if a pool was ever created —
		//    avoids spinning one up just to tear it down).
		if (delegatePool) {
			delegatePool.shutdownAll();
			delegatePool = null;
		}
	});

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate",
		description:
			"Delegate work to isolated subagents (separate pi sessions with their own context windows). Actions: spawn (default; backgrounded in TUI with auto report delivery, blocking when non-interactive), collect (wait for a child and get its report), list (live + recent children), steer (send message to a running child), stop (kill a child). role=leaf (default; cannot delegate further) or orchestrator (may spawn children; depth capped at 2). Provide goal + optional context.",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([Type.Literal("spawn"), Type.Literal("collect"), Type.Literal("list"), Type.Literal("steer"), Type.Literal("stop")]),
			),
			goal: Type.Optional(Type.String({ description: "For spawn: the task goal" })),
			context: Type.Optional(Type.String({ description: "For spawn: supporting briefing/context" })),
			role: Type.Optional(Type.Union([Type.Literal("leaf"), Type.Literal("orchestrator")])),
			cwd: Type.Optional(Type.String({ description: "Working directory for the child (default: current)" })),
			subagent_id: Type.Optional(Type.String({ description: "For collect/steer/stop: child id from spawn/list" })),
			message: Type.Optional(Type.String({ description: "For steer: the steering message" })),
			timeout: Type.Optional(Type.Number({ description: "For collect: max ms to wait (default 900000)" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, signal, _update, ctx: ExtensionContext) {
			const action = p.action ?? "spawn";

			switch (action) {
				case "spawn": {
					if (depth >= MAX_DEPTH) {
						return mk("delegate_task: max nesting depth reached (2). You are too deep to spawn further subagents.", true);
					}
					const goal = (p.goal ?? "").trim();
					if (!goal) return mk("delegate_task spawn requires goal", true);
					if (running() >= maxConcurrent()) {
						return mk(`delegate_task: at max concurrent children (${maxConcurrent()}). action=list to inspect; wait, collect, or stop some first.`, true);
					}
					const id = shortId("sa");
					const child: Child = { id, goal, role: normalizeRole(p.role), lane: "", status: "running", startedAt: Date.now() };
					children.set(id, child);
					trimFinished();
					const cwd = p.cwd && fs.existsSync(p.cwd) ? p.cwd : ctx.cwd;
					runChild(child, p.context, child.role, cwd);
					registry_().log("delegate", `spawn ${id} [${child.role}]: ${goal.slice(0, 80)}`);
					if (ctx.hasUI) {
						ctx.ui.setStatus("waywiser-*:delegate", `subagents ${running()} running`);
						return mk(
							`Spawned subagent ${id} [${child.role}] for: "${goal.slice(0, 120)}"\n` +
								`It is running in the BACKGROUND. Its report will be sent to you automatically when it finishes.\n` +
								`Manage: action=collect subagent_id=${id} (wait for it now), action=list, action=steer, action=stop.`,
						);
					}
					// Non-interactive: block until done so the result is in-band.
					const deadline = Date.now() + (p.timeout ?? 900_000);
					while (child.status === "running" && Date.now() < deadline) {
						if (signal?.aborted) {
							killChild(child);
							return mk("aborted", true);
						}
						await sleep(1000);
					}
					if (child.status === "running") {
						return mk(`subagent ${id} still running after ${p.timeout ?? 900_000}ms; check later with action=list.`, true);
					}
					return mk(childReport(child));
				}
				case "collect": {
					const child = children.get((p.subagent_id ?? "").trim());
					if (!child) return mk(`no subagent with id "${p.subagent_id ?? "(none)"}" (use action=list)`, true);
					if (child.status !== "running") return mk(childReport(child));
					const deadline = Date.now() + (p.timeout ?? 900_000);
					while (child.status === "running" && Date.now() < deadline) {
						if (signal?.aborted) {
							killChild(child);
							return mk("aborted", true);
						}
						await sleep(1000);
					}
					if (child.status === "running") return mk(`subagent ${child.id} still running after ${p.timeout ?? 900_000}ms.`, true);
					return mk(childReport(child));
				}
				case "list": {
					const all = [...children.values()].sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
					if (!all.length) return mk("No subagents (none spawned or finished recently).");
					return mk(
						all
							.map((c) => {
								const age = Math.max(0, Math.round(((c.finishedAt ?? Date.now()) - c.startedAt) / 1000));
								const note = c.status !== "running" && c.report ? `\n    report: ${c.report.slice(0, 200).replace(/\n/g, " ")}` : "";
								return `[${c.id}] ${c.status.toUpperCase()} [${c.role}] ${age}s — ${c.goal.slice(0, 100)}${note}`;
							})
							.join("\n"),
					);
				}
				case "steer": {
					const child = children.get((p.subagent_id ?? "").trim());
					if (!child) return mk(`no subagent with id "${p.subagent_id ?? "(none)"}"`, true);
					if (child.status !== "running") return mk(`subagent ${child.id} is not running (status: ${child.status})`, true);
					const msg = (p.message ?? "").trim();
					if (!msg) return mk("steer requires message", true);
					const okd = (await child.rpc?.steer(msg)) ?? false;
					if (!okd) return mk(`could not steer ${child.id} (child not accepting input)`, true);
					registry_().log("delegate", `steer ${child.id}: ${msg.slice(0, 80)}`);
					return mk(`Steering message sent to ${child.id} (delivered before its next LLM call).`);
				}
				case "stop": {
					const child = children.get((p.subagent_id ?? "").trim());
					if (!child) return mk(`no subagent with id "${p.subagent_id ?? "(none)"}"`, true);
					killChild(child);
					ctx.ui?.notify?.(`Stopped subagent ${child.id}`, "info");
					return mk(`Stopped subagent ${child.id}.`);
				}
			}
		},
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function mk(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}
