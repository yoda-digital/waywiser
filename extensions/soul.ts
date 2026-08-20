/**
 * waywiser-*soul — living identity.
 *
 * - Injects ~/.waywiser/SOUL.md as the FIRST block of the system prompt (stable
 *   prefix = prompt-cache friendly; content only ever grows via `soul` tool appends).
 * - `soul` tool: read / append preferences / append lessons. Never rewrites —
 *   the cache-sacred rule: rewriting would invalidate the cached prefix.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import { homeFile, registry_ } from "./utils/state.js";

export default function soul(pi: ExtensionAPI): void {
	let soulContent = "";

	const loadSoul = (): void => {
		try {
			soulContent = fs.readFileSync(homeFile("SOUL.md"), "utf-8").trim();
		} catch {
			soulContent = "";
		}
	};

	pi.on("session_start", () => {
		loadSoul();
	});

	pi.on("before_agent_start", (event) => {
		loadSoul();
		if (!soulContent) return;
		const soulBlock = `\n\n<!-- WAYWISER SOUL BEGIN -->\n${soulContent}\n<!-- WAYWISER SOUL END -->\n`;
		// Prepend: identity comes before everything else, and the block is stable
		// across turns (append-only file), so the prefix cache stays warm.
		return { systemPrompt: soulBlock + event.systemPrompt };
	});

	pi.registerTool({
		name: "soul",
		label: "Soul",
		description:
			"Manage your persistent identity (SOUL.md). Read it, or append durable user preferences and dated lessons learned. Appends only — never rewrite.",
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("read"), Type.Literal("append_preference"), Type.Literal("append_lesson")],
				{ description: "read | append_preference | append_lesson" },
			),
			text: Type.Optional(Type.String({ description: "The preference or lesson to append" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
			const file = homeFile("SOUL.md");
			if (params.action === "read") {
				try {
					return ok(fs.readFileSync(file, "utf-8"));
				} catch {
					return err("SOUL.md not found. Run bin/waywiser-* once to bootstrap, or create ~/.waywiser/SOUL.md.");
				}
			}
			const text = (params.text ?? "").trim();
			if (!text) return err("action " + params.action + " requires non-empty text");
			const section = params.action === "append_preference" ? "## Preferences" : "## Lessons learned";
			const stamp = new Date().toISOString().slice(0, 10);
			const line = `- ${text}${section === "## Lessons learned" ? `  (${stamp})` : ""}`;

			let content = "";
			try {
				content = fs.readFileSync(file, "utf-8");
			} catch {
				return err("SOUL.md not found; refusing to create it implicitly — bootstrap waywiser-* first.");
			}
			if (content.includes(line)) return ok(`Already recorded: ${line}`);
			const marker = `${section}\n`;
			if (!content.includes(marker)) {
				content += `\n${marker}\n`;
			}
			// Insert right after the section header (or its HTML comment placeholder).
			const lines = content.split("\n");
			let idx = lines.findIndex((l) => l.trimStart() === section);
			idx = idx >= 0 ? idx : lines.length - 1;
			// skip placeholder comments so new entries sit above old ones? No — chronological append:
			// find last bullet in the section, append after it.
			let cursor = idx + 1;
			while (cursor < lines.length && !lines[cursor].startsWith("## ")) {
				cursor++;
			}
			// insert before end-of-section, trailing at the section's end
			lines.splice(cursor, 0, line);
			fs.writeFileSync(file, lines.join("\n"));
			loadSoul();
			registry_().log("soul", `appended ${section.replace("## ", "")}: ${text.slice(0, 120)}`);
			ctx.ui.setStatus("waywiser-*:soul", `soul: +${params.action === "append_preference" ? "preference" : "lesson"}`);
			return ok(`Appended to SOUL.md under "${section}":\n${line}`);
		},
	});
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}
