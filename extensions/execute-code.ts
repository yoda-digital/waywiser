/**
 * waywiser-*execute-code — Programmatic Tool Calling.
 *
 * The model writes a JavaScript snippet that declares `toolCalls = [{tool, args}]`.
 * Waywiser spawns an isolated `pi --mode rpc` subprocess and executes every call in
 * order via the JSONL RPC protocol (prompt + follow_up chained, get_last_assistant_text
 * for the final result). One execute_code call = many tool calls, zero extra LLM turns.
 *
 * Protocol notes (verified against pi source, src/modes/rpc/):
 * - strict JSONL over stdio: split on \n only, strip trailing \r (Node readline is
 *   NOT protocol-compliant: it splits on U+2028/U+2029).
 * - commands: prompt, steer, follow_up, get_last_assistant_text, abort, ...
 * - events stream out as JSON lines; agent_end = turn complete.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiRpcClient, createPiRpcPool, type PiRpcClient } from "./utils/rpc.js";

// Small warm pool for the execute_code lane (fresh per cwd; heavy
// new_session reset on reuse keeps the contract of "isolated agent").
const EXECUTE_CODE_ARGS = ["--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes"];
const execPool = createPiRpcPool({
	maxIdle: 1,
	idleTtlMs: 5 * 60_000,
	spawn: (lane, cwd) => createPiRpcClient({ cwd, args: EXECUTE_CODE_ARGS }),
});
if (typeof process.on === "function") process.on("exit", () => execPool.shutdownAll());

export default function executeCode(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "execute_code",
		label: "Execute Code",
		description:
			"Programmatic tool calling. Provide JavaScript that assigns `toolCalls = [{ tool, args }]` (and any helper computation). Waywiser runs each call in an isolated agent child in the given order and reports the outcomes. Use to batch many mechanical tool calls into one step instead of many LLM turns. No Node APIs are available in your script — only plain JS logic plus the toolCalls array.",
		parameters: Type.Object({
			code: Type.String({
				description:
					"JavaScript snippet; MUST define `const toolCalls = [{ tool: \"<name>\", args: { ... } }, ...]`. Only plain JS (no require). You may compute args from earlier constants in the script.",
			}),
			timeout: Type.Optional(Type.Number({ description: "Overall timeout ms (default 180000)" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, signal, _update, ctx: ExtensionContext) {
			// 1. Parse the script's toolCalls without a shell: extract with a tiny repl.
			let toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
			try {
				// eslint-disable-next-line @typescript-eslint/no-implied-eval
				const fn = new Function(`
					const module = { exports: {} };
					const require = undefined;
					const process = undefined;
					${p.code}
					return toolCalls;
				`) as () => unknown;
				const calls = fn();
				if (!Array.isArray(calls) || calls.length === 0) {
					return mk("execute_code: script must define a non-empty `toolCalls` array.", true);
				}
				toolCalls = calls as Array<{ tool: string; args: Record<string, unknown> }>;
			} catch (e) {
				return mk(`execute_code: script failed to evaluate: ${String(e)}`, true);
			}
			if (toolCalls.length > 25) {
				return mk(`execute_code: refusing ${toolCalls.length} calls (max 25 per call). Split into multiple execute_code calls.`, true);
			}

			// 2. Acquire an isolated rpc child from the execute_code lane.
			let state: PiRpcClient;
			try {
				state = await execPool.acquire("execute-code", { cwd: ctx.cwd });
			} catch (e) {
				return mk(`execute_code: could not start rpc child: ${String(e)}`, true);
			}
			try {
				const list = toolCalls.map((c, i) => `${i + 1}. ${c.tool}(${JSON.stringify(c.args).slice(0, 2000)})`).join("\n");
				const prompt =
					`Execute EXACTLY these tool calls, in order, with exactly these arguments. No commentary between calls. ` +
					`Execute every numbered call yourself - never skip, merge, or reorder. ` +
					`When all finish, reply in at most 8 lines: one line per call, prefixed with its number, marked ok or FAILED(reason); ` +
					`then a final line starting with "SUMMARY: ".\n\n` +
					`Tool calls:\n${list}`;
				const timeout = p.timeout ?? 180_000;
				const per = Math.floor(timeout / Math.max(toolCalls.length, 2));
				const t0 = Date.now();
				const res0 = await state.command({ type: "prompt", message: prompt }, Math.max(5000, Math.min(per, 15000)));
				if (!res0.success) return mk(`execute_code: prompt rejected: ${JSON.stringify(res0).slice(0, 300)}`, true);
				await state.waitAgentEnd(Math.min(timeout, 120_000)).catch(() => { void state.abort(); });

				// Chain remaining calls with follow_up (delivered each time the child stops).
				for (let i = 1; i < toolCalls.length; i++) {
					const remaining = timeout - (Date.now() - t0);
					if (remaining < 10_000) return mk(`execute_code: budget exhausted after ${i} of ${toolCalls.length} calls.`, true);
					const c = toolCalls[i];
					const res = await state.command(
						{ type: "follow_up", message: `Now execute the next tool call exactly: ${c.tool}(${JSON.stringify(c.args).slice(0, 2000)})` },
						remaining,
					);
					if (!res.success) return mk(`execute_code: follow_up ${i + 1} rejected: ${JSON.stringify(res).slice(0, 200)}`, true);
					await state.waitAgentEnd(remaining).catch(() => {});
				}

				const finalText = (await state.getLastAssistantText(10_000).catch(() => "")) || "(no summary captured)";
				// The child is asked for one numbered line per call. If a number is missing,
				// the child most likely skipped a follow_up (weak-model mode). Never report
				// that as a clean success.
				const numbered = finalText.split(/\n/).filter((l) => /^\s*\d+\./.test(l)).length;
				const warned = finalText !== "(no summary captured)" && numbered !== toolCalls.length
					? `WARNING: expected ${toolCalls.length} numbered result lines, child reported ${numbered} - some calls may not have executed. Verify order-sensitive work before trusting.\n\n`
					: "";
				return mk(`${warned}executed ${toolCalls.length} call(s) in isolated agent.\n\n${finalText}`);
			} catch (e) {
				return mk(`execute_code error: ${String(e)}\nchild stderr tail: ${state.stderrTail() || "(none)"}`, true);
			} finally {
				execPool.release("execute-code", state);
			}
		},
	});
}

function mk(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}
