/**
 * waywiser-*llmcall — the ONLY model-call primitive in the pack.
 * One-shot `pi --mode rpc` child with core-only args (same pattern as
 * kanban's worker spawn, extensions/kanban.ts:135). Run the child, deliver
 * one prompt, collect the final assistant text, kill. Shared by the memory
 * gate (B) and consolidation pass 2 (D). Single-flight: one child at a time;
 * concurrent callers get a rejection, never a queue (spec §4 "≤ 1 concurrent gate").
 */
import { createPiRpcClient, type PiRpcClient } from "./rpc.js";

export const LEAF_ARGS: readonly string[] = [
	"--no-session",
	"--no-context-files",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-extensions",
];

let inFlight = 0;

export async function runChild(opts: { prompt: string; totalMs?: number; cwd?: string }): Promise<string> {
	if (inFlight > 0) throw new Error("llmcall: child already running");
	const totalMs = opts.totalMs ?? 15_000;
	inFlight++;
	let state: PiRpcClient | undefined;
	try {
		state = await createPiRpcClient({ cwd: opts.cwd ?? process.cwd(), args: [...LEAF_ARGS] });
		const t0 = Date.now();
		const res0 = await state.command({ type: "prompt", message: opts.prompt }, Math.max(1000, totalMs - 1500));
		if (res0.success) {
			const remain = Math.max(500, totalMs - (Date.now() - t0) - 500);
			await state.waitAgentEnd(remain).catch(() => void state.abort());
			return (await state.getLastAssistantText(1000).catch(() => "")) || "(no reply captured)";
		}
		return `(llmcall error: child rejected the prompt: ${JSON.stringify(res0).slice(0, 200)})`;
	} catch (e) {
		return `(llmcall error: ${String(e).split("\n")[0]})`;
	} finally {
		state?.stop();
		inFlight--;
	}
}
