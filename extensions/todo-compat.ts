/**
 * waywiser-*todo-compat — backward-compatible /todo command backed by kanban.
 *
 * Replaces the old standalone todo.ts. The todo tool is NOT registered —
 * only the /todo command (which delegates to the kanban tool internally).
 * This means `todo` tool calls from the LLM will fail with "unknown tool,"
 * steering the model toward `kanban` instead.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boardOps } from "./kanban/ops.js";

export default function todoCompat(pi: ExtensionAPI): void {
	pi.registerCommand("todo", {
		description:
			"Quick task list (backed by kanban). /todo [add <text> | done <id> | list]. " +
			"For full board control, use /kanban or the kanban tool.",
		handler: async (args, ctx: ExtensionContext) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] ?? "list";
			const rest = parts.slice(1).join(" ");

			switch (sub) {
				case "add": {
					if (!rest) {
						ctx.ui.notify("usage: /todo add <text>", "error");
						return;
					}
					const r = boardOps.newCard(rest);
					ctx.ui.notify(r.msg, r.ok ? "info" : "error");
					return;
				}
				case "done": {
					const id = parts[1];
					if (!id) {
						ctx.ui.notify("usage: /todo done <id>", "error");
						return;
					}
					const r = boardOps.done(id);
					ctx.ui.notify(r.msg, r.ok ? "info" : "error");
					return;
				}
				case "remove": {
					const id = parts[1];
					if (!id) {
						ctx.ui.notify("usage: /todo remove <id>", "error");
						return;
					}
					const r = boardOps.remove(id);
					ctx.ui.notify(r.msg, r.ok ? "info" : "error");
					return;
				}
				case "list":
				default: {
					const r = boardOps.list();
					ctx.ui.notify(r.msg, "info");
					return;
				}
			}
		},
	});
}
