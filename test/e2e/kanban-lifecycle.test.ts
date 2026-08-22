// test/e2e/kanban-lifecycle.test.ts
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

test("e2e: kanban card lifecycle", { skip: !process.env.WAYWISER_E2E_MODEL }, async () => {
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
			message: "Use the kanban tool: action=new, title='Write unit tests', priority='high'. " +
				"Note the card id returned. Then action=move using that same id, status=doing. " +
				"Then action=done using that same id. " +
				"Report the final card id and status.",
		}, 30_000);
		await client.waitAgentEnd(90_000);

		const text = await client.getLastAssistantText(5_000);
		assert.ok(text.includes("done") || text.includes("DONE"), `Expected done status, got: ${text.slice(0, 300)}`);

		// Card ids are race-safe random hex (crypto.randomUUID-based, fix #30) —
		// no longer sequential K1/K2 — so look the card up by title instead.
		const { db_, closeDb } = jiti("../../extensions/utils/state.js") as any;
		const d = db_();
		const card = d.prepare("SELECT status FROM cards WHERE title = 'Write unit tests'").get() as any;
		assert.equal(card?.status, "done");
		closeDb();
	} finally {
		client.stop();
	}
}, { timeout: 120_000 });
