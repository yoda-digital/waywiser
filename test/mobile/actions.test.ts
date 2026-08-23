import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-actions-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const actionsMod = jiti("../../extensions/mobile/actions.ts") as typeof import("../../extensions/mobile/actions.ts");
const inboxMod = jiti("../../extensions/mobile/inbox.ts") as typeof import("../../extensions/mobile/inbox.ts");

const { makeActionBuilder } = actionsMod;

// Absolute paths inside the isolated tmp are guaranteed safe (no whitespace, no shell chars).
const bins = {
	do: path.join(tmp, "waywiser-do"),
	reply: path.join(tmp, "waywiser-reply"),
	approve: path.join(tmp, "waywiser-approve"),
};

describe("mobile action builder — path safety", () => {
	test("relative bin paths are rejected", () => {
		assert.throws(() => makeActionBuilder({ do: "waywiser-do", reply: bins.reply, approve: bins.approve }));
	});
	test("bin paths with shell metacharacters are rejected", () => {
		for (const bad of [
			"/tmp/waywiser do", // whitespace
			"/tmp/way;iser-do", // ;
			"/tmp/way$iser-do", // $
			"/tmp/way`iser-do", // backtick
			"/tmp/way|iser-do", // |
			'/tmp/way"iser-do', // "
			"/tmp/way'iser-do", // '
			"/tmp/way&iser-do", // &
		]) {
			assert.throws(() => makeActionBuilder({ do: bad, reply: bins.reply, approve: bins.approve }), new RegExp(""), `must reject ${JSON.stringify(bad)}`);
		}
	});
});

describe("mobile action builder — fixed-shape action strings", () => {
	test("plain action → `<do-bin> <token>`, token is valid hex", () => {
		const b = makeActionBuilder(bins);
		const args = b.buildArgs([{ label: "Do", intent: { kind: "prompt", prompt: "pwn && rm -rf ~" } }], 60_000);
		// argv shape: [--button1, "Do", --button1-action, "<do> <tok>"]
		assert.equal(args[0], "--button1");
		assert.equal(args[1], "Do");
		assert.equal(args[2], "--button1-action");
		const actionStr = args[3];
		const m = actionStr.match(/^(\S+) ([a-f0-9]{16,})$/);
		assert.ok(m, `action string must be '<bin> <hex-token>', got: ${actionStr}`);
		assert.equal(m[1], bins.do);
		// The evil user-controlled prompt must NOT appear in the action string.
		assert.equal(actionStr.includes("pwn"), false, "user text must never leak into shell-executed action");
		assert.equal(actionStr.includes("rm -rf"), false);
	});

	test("reply action → `<reply-bin> <token> \"$REPLY\"`", () => {
		const b = makeActionBuilder(bins);
		const args = b.buildArgs([{ label: "Reply", intent: { kind: "reply", prompt: "$(evil)" }, directReply: true }], 60_000);
		const actionStr = args[3];
		const m = actionStr.match(/^(\S+) ([a-f0-9]{16,}) "\$REPLY"$/);
		assert.ok(m, `reply action must be '<bin> <tok> "$REPLY"', got: ${actionStr}`);
		assert.equal(m[1], bins.reply);
		// $REPLY is the ONLY env-expansion; nothing else may leak in.
		assert.equal(actionStr.includes("evil"), false);
	});

	test("biometric approve action follows exact short-circuit shape", () => {
		const b = makeActionBuilder(bins);
		const args = b.buildArgs(
			[{ label: "Approve", intent: { kind: "approve", requestId: "req-1", requiresBiometric: true } }],
			60_000,
		);
		const actionStr = args[3];
		const shape = new RegExp(
			`^termux-fingerprint -t 'Approve ([a-f0-9]{16,})' \\| grep -q '"success":true' && ${bins.approve.replace(/[.\-]/g, "\\$&")} \\1 yes \\|\\| ${bins.approve.replace(/[.\-]/g, "\\$&")} \\1 no$`,
		);
		assert.match(actionStr, shape);
	});

	test("token is issued in the inbox and matches the one embedded in the action string", () => {
		const b = makeActionBuilder(bins);
		const args = b.buildArgs([{ label: "Do", intent: { kind: "dismiss" } }], 60_000);
		const tok = args[3].split(" ")[1];
		// The token must be redeemable exactly once from the inbox.
		const first = inboxMod.redeemToken(tok);
		assert.ok(first, "token embedded in action string must resolve in the inbox");
		assert.equal(inboxMod.redeemToken(tok), null, "second redeem must fail");
	});

	test("more than 3 actions get truncated (Android limit)", () => {
		const b = makeActionBuilder(bins);
		const actions = Array.from({ length: 5 }, (_, i) => ({
			label: `A${i}`,
			intent: { kind: "dismiss" as const },
		}));
		const args = b.buildArgs(actions, 60_000);
		// Exactly 3 button pairs → 12 args (2 args per button + 2 args per action).
		assert.equal(args.length, 12);
		assert.equal(args[0], "--button1");
		assert.equal(args[4], "--button2");
		assert.equal(args[8], "--button3");
	});
});
