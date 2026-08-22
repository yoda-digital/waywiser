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
import { registerInjection, removeInjection, PRIORITIES } from "./utils/prompt-budget.js";

export default function soul(pi: ExtensionAPI): void {
	let soulContent = "";

	const loadSoul = (): void => {
		try {
			soulContent = fs.readFileSync(homeFile("SOUL.md"), "utf-8").trim();
		} catch {
			soulContent = "";
		}
	};

	// Register (or refresh) the SOUL injection with the budget manager.
	// Priority 0, cacheable: always the first block of the assembled prompt,
	// which preserves the prompt-cache-friendly stable prefix.
	const registerSoul = (): void => {
		if (soulContent) {
			registerInjection({
				key: "soul",
				priority: PRIORITIES.SOUL,
				cacheable: true,
				content: `\n<!-- WAYWISER SOUL BEGIN -->\n${soulContent}\n<!-- WAYWISER SOUL END -->\n`,
			});
		} else {
			removeInjection("soul");
		}
	};

	pi.on("session_start", () => {
		loadSoul();
		registerSoul();
	});

	pi.registerTool({
		name: "soul",
		label: "Soul",
		description:
			"Manage your persistent identity (SOUL.md). Read it, or append durable user preferences and dated lessons learned. Appends only — never rewrite.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("read"),
					Type.Literal("append_preference"),
					Type.Literal("append_lesson"),
					Type.Literal("consolidate"),
				],
				{ description: "read | append_preference | append_lesson | consolidate" },
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
			if (params.action === "consolidate") {
				let content: string;
				try {
					content = fs.readFileSync(file, "utf-8");
				} catch {
					return err("SOUL.md not found.");
				}

				// Count items in each section
				const prefLines = extractBullets(content, "## Preferences");
				const lessLines = extractBullets(content, "## Lessons learned");
				const total = prefLines.length + lessLines.length;

				if (total < 15) {
					return ok(
						`SOUL.md has ${prefLines.length} preferences and ${lessLines.length} lessons — ` +
						`no consolidation needed yet (threshold: 15).`,
					);
				}

				// Detect potential contradictions within preferences
				const contradictions: string[] = [];
				for (let i = 0; i < prefLines.length; i++) {
					for (let j = i + 1; j < prefLines.length; j++) {
						// Check if two preferences reference the same subject but
						// contain opposing verbs (prefer/avoid, use/never, always/never)
						const a = prefLines[i].toLowerCase();
						const b = prefLines[j].toLowerCase();
						if (
							((a.includes("never") && b.includes("always")) || (a.includes("always") && b.includes("never"))) ||
							((a.includes("prefer") && b.includes("avoid")) || (a.includes("avoid") && b.includes("prefer"))) ||
							((a.includes("use ") && b.includes("don't use")) || (a.includes("don't use") && b.includes("use ")))
						) {
							// Crude heuristic — surface for human review, not auto-resolve
							contradictions.push(`  ? "${prefLines[i].slice(2, 80)}" vs "${prefLines[j].slice(2, 80)}"`);
						}
					}
				}

				const parts = [
					`SOUL.md consolidation report:`,
					`  Preferences: ${prefLines.length}`,
					`  Lessons: ${lessLines.length}`,
					`  Total: ${total}`,
				];
				if (contradictions.length) {
					parts.push(`\nPotential contradictions (review manually):`);
					parts.push(...contradictions.slice(0, 10));
					if (contradictions.length > 10) {
						parts.push(`  ... and ${contradictions.length - 10} more`);
					}
				}
				parts.push(
					`\nTo consolidate: edit ~/.waywiser/SOUL.md directly.`,
					`Keep the latest version of contradictory preferences.`,
					`Remove outdated lessons. The agent will not edit SOUL.md itself.`,
				);

				return ok(parts.join("\n"));
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
			registerSoul();
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

/** Extract bullet lines ("- ...") from a section of SOUL.md, up to the next "## " header. */
export function extractBullets(content: string, sectionHeader: string): string[] {
	const lines = content.split("\n");
	const idx = lines.findIndex((l) => l.trimStart() === sectionHeader);
	if (idx < 0) return [];
	const bullets: string[] = [];
	for (let i = idx + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) break; // next section
		if (lines[i].startsWith("- ")) bullets.push(lines[i]);
	}
	return bullets;
}
