/**
 * waywiser-*clarify — user interaction mid-task.
 * `clarify` tool: ask the user a question (optionally multiple-choice).
 * Interactive TUI: dialogs. Print/RPC mode (-p, --mode rpc/json): graceful
 * degradation with an explicit unavailable message (waywiser-* semantics).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function clarify(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "clarify",
		label: "Clarify",
		description:
			"Ask the user a question mid-task and wait for the answer. Use when intent is ambiguous and the cost of guessing is higher than the cost of asking. Provide options for multiple choice.",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Optional; if given, the user chooses one (may still type free text)" })),
			rationale: Type.Optional(Type.String({ description: "One line on why you need this before proceeding" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, _signal, _update, ctx: ExtensionContext) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: `clarify unavailable in this mode (non-interactive print/RPC/session). Question was: ${p.question}\nProceed with your best-informed assumption and label it as an assumption in your output.`,
						},
					],
					details: {},
					isError: true,
				};
			}
			const q = p.rationale ? `${p.question}\n(${p.rationale})` : p.question;
			let answer: string | undefined;
			if (p.options && p.options.length) {
				answer = await ctx.ui.select(q, [...p.options, "Other… (type it)"]);
				if (answer === "Other… (type it)") {
					answer = await ctx.ui.input(q, "Type your answer");
				}
			} else {
				answer = await ctx.ui.input(q, "Type your answer");
			}
			if (!answer) {
				return {
					content: [{ type: "text" as const, text: "User did not answer (empty response). Proceed with your best-informed assumption and label it as an assumption." }],
					details: {},
					isError: true,
				};
			}
			return { content: [{ type: "text" as const, text: `User answered: ${answer}` }], details: {} };
		},
	});
}
