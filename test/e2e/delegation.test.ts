// test/e2e/delegation.test.ts
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createTestHome, requireModel, EXTENSION_PATH } from "./helpers.ts";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
let home: string;
let cleanup: () => void = () => {};

before(() => {
	if (!process.env.WAYWISER_E2E_MODEL) return;
	({ home, cleanup } = createTestHome());
	process.env.WAYWISER_HOME = home;
});
after(() => cleanup());

test("e2e: delegate_task spawn and collect", { skip: !process.env.WAYWISER_E2E_MODEL }, async () => {
	requireModel();
	const { createPiRpcClient } = jiti("../../extensions/utils/rpc.js") as any;
	const client = await createPiRpcClient({
		cwd: process.cwd(),
		args: ["--extension", EXTENSION_PATH, "--no-session", "--no-context-files",
			"--no-skills", "--no-prompt-templates", "--no-themes"],
		env: { ...process.env, WAYWISER_HOME: home },
	});

	try {
		await client.command({
			type: "prompt",
			message: "Use delegate_task: action=spawn, goal='List the files in the current directory and report the count.', role=leaf. " +
				"Then use delegate_task: action=list to check on it. " +
				"Wait 30 seconds, then use delegate_task: action=collect on the subagent id to get its report.",
		}, 30_000);
		await client.waitAgentEnd(120_000);

		const text = await client.getLastAssistantText(5_000);
		// The subagent should have reported something — at minimum the word "report" or a file count.
		assert.ok(
			text.includes("report") || text.includes("DONE") || text.includes("file"),
			`Expected delegation report, got: ${text.slice(0, 300)}`
		);
	} finally {
		client.stop();
	}
}, { timeout: 180_000 });
