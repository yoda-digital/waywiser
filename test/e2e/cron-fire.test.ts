// test/e2e/cron-fire.test.ts
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

test("e2e: schedule one-shot cron and verify it fires", { skip: !process.env.WAYWISER_E2E_MODEL }, async () => {
	requireModel();
	const { createPiRpcClient } = jiti("../../extensions/utils/rpc.js") as any;
	const client = await createPiRpcClient({
		cwd: process.cwd(),
		args: ["--extension", EXTENSION_PATH, "--no-session", "--no-context-files",
			"--no-skills", "--no-prompt-templates", "--no-themes"],
		env: { ...process.env, WAYWISER_HOME: home },
	});

	try {
		// Schedule a one-shot 5 seconds from now.
		const at = new Date(Date.now() + 5_000).toISOString();
		await client.command({
			type: "prompt",
			message: `Use the cronjob tool: action=schedule, schedule='@${at}', prompt='Say CRON_FIRED_OK', name='test-oneshot'.`,
		}, 30_000);
		await client.waitAgentEnd(60_000);

		// Verify the job was scheduled by checking the DB directly.
		const { db_, closeDb } = jiti("../../extensions/utils/state.js") as any;
		const d = db_();
		const jobs = d.prepare("SELECT id, schedule FROM cronjobs WHERE name = 'test-oneshot'").all();
		assert.ok(jobs.length >= 1, "Cron job should be in DB");
		closeDb();
	} finally {
		client.stop();
	}
}, { timeout: 90_000 });
