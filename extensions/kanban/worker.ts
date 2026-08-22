/**
 * kanban/worker.ts — subagent card-worker spawn/wait (SQLite-backed).
 *
 * `spawnCard` starts a detached leaf pi child that works one card and files
 * its report back onto it; `waitCard` blocks (bounded) until that worker
 * finishes. `inFlight` tracks which cards currently have a worker running —
 * read by ops.ts (show/move guards) and the TUI widget in index.ts.
 *
 * Note: spawnCard calls scheduleRefresh() from ops.ts, and ops.assign() calls
 * spawnCard() from here — see the circular-import note at the top of ops.ts.
 */
import { shortId, db_, registry_ } from "../utils/state.js";
import { createPiRpcClient, type PiRpcClient } from "../utils/rpc.js";
import { broadcastEvent } from "../kanban-server.js";
import { getCard, type CardRow, type Status, type OpResult } from "./shared.js";
import { scheduleRefresh } from "./ops.js";

export const inFlight = new Map<string, "running">(); // cardId → in-flight worker

export async function spawnCard(c: CardRow, cwd: string, timeoutMs: number): Promise<OpResult> {
	if (inFlight.has(c.id)) {
		return { ok: false, msg: `${c.id} already has a worker running (${c.worker_child ?? "?"}) — one worker per card` };
	}
	const briefing =
		`You are a leaf worker on the Waywiser kanban board. Work card ${c.id}: "${c.title}"` +
		(c.notes ? `\nNotes: ${c.notes}` : "") +
		(c.report ? `\nPrevious report: ${c.report}` : "") +
		`\nDo the work with your tools. When finished, reply in AT MOST 10 lines: what you did, what files/commands touched (if anything), and anything blocked.\n` +
		`Prefix your first line with "WAYWISER_REPORT: ".\nReply honestly; if you could not do it, say exactly what failed.`;
	let state: PiRpcClient;
	try {
		state = await createPiRpcClient({ cwd, args: ["--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"] });
	} catch (e) {
		return { ok: false, msg: `could not start worker child: ${String(e)}` };
	}
	inFlight.set(c.id, "running");
	const workerChild = shortId("kc");
	db_().prepare("UPDATE cards SET worker_child = ?, status = 'doing', updated_at = datetime('now') WHERE id = ?").run(workerChild, c.id);
	broadcastEvent("card_updated", getCard(c.id));
	scheduleRefresh();
	const run = async (): Promise<void> => {
		let report = "(no report captured)";
		try {
			const res0 = await state.command({ type: "prompt", message: briefing }, Math.min(timeoutMs, 120_000));
			if (res0.success) {
				await state.waitAgentEnd(timeoutMs).catch(() => void state.abort());
				report = (await state.getLastAssistantText(15_000).catch(() => "")) || "(no report captured)";
			} else {
				report = `worker child rejected the prompt: ${JSON.stringify(res0).slice(0, 300)}`;
			}
			if (!state.isAlive()) report += `\n(worker child exited mid-task)`;
		} catch (e) {
			report = `worker child error: ${String(e)}\n${state.stderrTail() || ""}`.trim();
		} finally {
			state.stop();
			inFlight.delete(c.id);
			// Re-read the card (not the stale copy): it may have moved since spawn.
			const c2 = getCard(c.id);
			if (c2) {
				const nextStatus: Status = c2.status === "doing" ? (report.startsWith("WAYWISER_REPORT:") ? "review" : "doing") : (c2.status as Status);
				db_().prepare("UPDATE cards SET report = ?, worker_child = NULL, status = ?, updated_at = datetime('now') WHERE id = ?").run(report, nextStatus, c.id);
				broadcastEvent("card_updated", getCard(c.id));
				registry_().log("kanban", `${c.id} worker finished → ${nextStatus}`);
			}
			scheduleRefresh();
		}
	};
	void run(); // detached; progress is on the card, report written on completion
	return { ok: true, msg: `worker ${workerChild} spawned for ${c.id} (detached) — report will land on the card on completion; use action=wait or list to check` };
}

// Wait for a card's worker (bounded). Used by tool action=wait.
export async function waitCard(id: string, timeoutMs: number): Promise<{ report?: string; stillRunning: boolean }> {
	const t0 = Date.now();
	while (inFlight.has(id) && Date.now() - t0 < timeoutMs) {
		await new Promise((r) => setTimeout(r, 1000));
	}
	if (inFlight.has(id)) return { stillRunning: true };
	const c = getCard(id);
	return { report: c?.report ?? undefined, stillRunning: false };
}
