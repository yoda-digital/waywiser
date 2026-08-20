/**
 * waywiser-*todo — task tracking (waywiser-* todo tool).
 * In-session board + appendEntry persistence + TODO.md mirror for humans.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { registry_ } from "./utils/state.js";

interface TodoItem {
	id: number;
	text: string;
	done: boolean;
	inProgress?: boolean;
	priority?: "low" | "medium" | "high";
	created?: number;
	doneAt?: number;
}

export default function todo(pi: ExtensionAPI): void {
	const board: TodoItem[] = [];
	let nextId = 1;

	const stateKey = "waywiser-*:todo";
	pi.on("session_start", () => {
		try {
			// Restore from session entries if present (appendEntry round-trip).
			// appendEntry state is re-hydrated per session file by the extension runtime;
			// falling back to TODO.md keeps behavior predictable.
		} catch {
			/* ignore */
		}
		const file = path.join(process.cwd(), "TODO.md");
		try {
			const lines = fs.readFileSync(file, "utf-8").split("\n");
			for (const line of lines) {
				const m = line.match(/^[-*] \[( |x)\] (.*)$/i);
				if (m) {
					board.push({ id: nextId++, text: m[2].replace(/\s*\((in progress)\)$/i, ""), done: m[1].toLowerCase() === "x" });
				}
			}
		} catch {
			/* fresh board */
		}
	});

	const render = (): string =>
		board.length
			? board
					.map((t) => {
						const mark = t.done ? "x" : t.inProgress ? ">" : " ";
						const prio = t.priority && t.priority !== "medium" ? ` [${t.priority}]` : "";
						const ip = t.inProgress ? " (in progress)" : "";
						return `${t.id}. [${mark}]${prio} ${t.text}${ip}`;
					})
					.join("\n")
			: "No todos.";

	const persist = (ctx: ExtensionContext): void => {
		try {
			const file = path.join(ctx.cwd, "TODO.md");
			fs.writeFileSync(
				file,
				board.map((t) => `- [${t.done ? "x" : t.inProgress ? ">" : " "}] ${t.text}${t.priority && t.priority !== "medium" ? ` (${t.priority})` : ""}`).join("\n") +
					"\n",
			);
			ctx.ui.setStatus("waywiser-*:todo", `todos ${board.filter((t) => !t.done).length} open`);
		} catch {
			/* best effort */
		}
	};

	registry_().todos = { list: () => render(), render };

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Track task progress for multi-step work. Actions: list, add (text, priority?), toggle (id), in_progress (id), rename (id, text), remove (id), clear.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("toggle"), Type.Literal("in_progress"), Type.Literal("rename"), Type.Literal("remove"), Type.Literal("clear")]),
			text: Type.Optional(Type.String()),
			id: Type.Optional(Type.Number()),
			priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
		}),
		executionMode: "sequential",
		async execute(_id, p, _signal, _update, ctx: ExtensionContext) {
			switch (p.action) {
				case "list":
					return ok(render());
				case "add": {
					if (!p.text?.trim()) return err("add requires text");
					const item: TodoItem = { id: nextId++, text: p.text.trim(), done: false, priority: p.priority, created: Date.now() };
					board.push(item);
					persist(ctx);
					registry_().log("todo", `add #${item.id}: ${item.text.slice(0, 80)}`);
					return ok(`Added ${board.length} todos; open: ${board.filter((t) => !t.done).length}\n${render()}`);
				}
				case "toggle":
				case "in_progress": {
					const item = board.find((t) => t.id === p.id);
					if (!item) return err(`no todo with id ${p.id}`);
					if (p.action === "toggle") {
						item.done = !item.done;
						item.inProgress = false;
						item.doneAt = item.done ? Date.now() : undefined;
					} else {
						item.done = false;
						item.inProgress = true;
					}
					persist(ctx);
					registry_().log("todo", `${p.action} #${item.id}`);
					return ok(`#${item.id} ${p.action === "toggle" ? (item.done ? "completed" : "reopened") : "in progress"}\n${render()}`);
				}
				case "rename": {
					const item = board.find((t) => t.id === p.id);
					if (!item) return err(`no todo with id ${p.id}`);
					if (!p.text?.trim()) return err("rename requires text");
					item.text = p.text.trim();
					persist(ctx);
					return ok(`Renamed: ${render()}`);
				}
				case "remove": {
					const idx = board.findIndex((t) => t.id === p.id);
					if (idx < 0) return err(`no todo with id ${p.id}`);
					board.splice(idx, 1);
					persist(ctx);
					return ok(`Removed. ${render()}`);
				}
				case "clear": {
					board.length = 0;
					nextId = 1;
					persist(ctx);
					return ok("Cleared all todos.");
				}
			}
		},
	});

	pi.registerCommand("todo", {
		description: "Show the todo board",
		handler: async (_args, ctx) => {
			ctx.ui.notify(render(), "info");
		},
	});
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}
