// test/e2e/memory-roundtrip.test.ts
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

test("e2e: remember a preference, then recall it", { skip: !process.env.WAYWISER_E2E_MODEL }, async () => {
	requireModel();
	const { createPiRpcClient } = jiti("../../extensions/utils/rpc.js") as any;

	const client = await createPiRpcClient({
		cwd: process.cwd(),
		args: [
			"--extension", EXTENSION_PATH,
			"--no-session", "--no-context-files", "--no-skills",
			"--no-prompt-templates", "--no-themes",
		],
		env: { ...process.env, WAYWISER_HOME: home },
	});

	try {
		// Step 1: remember.
		const r1 = await client.command({
			type: "prompt",
			message:
				"Use the memory tool with action=remember to store: type=preference, content='I prefer dark mode in all editors'.",
		}, 30_000);
		assert.ok(r1.success, `prompt rejected: ${JSON.stringify(r1)}`);
		await client.waitAgentEnd(60_000);

		// Step 2: recall.
		const r2 = await client.command({
			type: "follow_up",
			message: "Now use the memory tool with action=recall, query='editor preferences'.",
		}, 30_000);
		assert.ok(r2.success);
		await client.waitAgentEnd(60_000);

		const text = await client.getLastAssistantText(5_000);
		assert.ok(
			text.includes("dark mode") || text.includes("preference"),
			`Expected recall to mention dark mode, got: ${text.slice(0, 300)}`
		);

		// Step 3: verify DB state directly.
		const { db_, closeDb } = jiti("../../extensions/utils/state.js") as any;
		const d = db_();
		const rows = d
			.prepare("SELECT content FROM memories WHERE content LIKE '%dark mode%'")
			.all();
		assert.ok(rows.length >= 1, "Memory should be persisted in SQLite");
		closeDb();
	} finally {
		client.stop();
	}
}, { timeout: 120_000 });
