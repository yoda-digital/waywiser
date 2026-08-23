import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolated WAYWISER_HOME (before importing anything that reads it).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-inbox-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const {
	issueToken,
	redeemToken,
	sweepExpiredTokens,
	enqueueMessage,
	drainMessages,
	tokensDir,
	msgsDir,
} = jiti("../../extensions/mobile/inbox.ts") as typeof import("../../extensions/mobile/inbox.ts");

describe("mobile inbox — token issue/redeem", () => {
	test("issueToken persists intent and returns a hex token >= 16 chars", () => {
		const tok = issueToken({ kind: "prompt", prompt: "hi" }, 60_000);
		assert.match(tok, /^[a-f0-9]{16,}$/);
		const file = path.join(tokensDir(), `${tok}.json`);
		assert.equal(fs.existsSync(file), true);
	});

	test("redeemToken returns the intent and deletes the token file (one-shot)", () => {
		const tok = issueToken({ kind: "dismiss" }, 60_000);
		const file = path.join(tokensDir(), `${tok}.json`);
		const first = redeemToken(tok);
		assert.ok(first, "first redeem must succeed");
		assert.equal(first.intent.kind, "dismiss");
		assert.equal(fs.existsSync(file), false, "file must be deleted after first redeem");
		const second = redeemToken(tok);
		assert.equal(second, null, "double-redeem must fail — token is one-shot");
	});

	test("redeemToken returns null for expired tokens (still deletes file)", () => {
		const tok = issueToken({ kind: "dismiss" }, 60_000);
		// Rewrite expiresAtMs to the past.
		const file = path.join(tokensDir(), `${tok}.json`);
		const rec = JSON.parse(fs.readFileSync(file, "utf-8"));
		rec.expiresAtMs = Date.now() - 1;
		fs.writeFileSync(file, JSON.stringify(rec));
		assert.equal(redeemToken(tok), null);
		assert.equal(fs.existsSync(file), false);
	});

	test("sweepExpiredTokens removes expired but keeps live", () => {
		const live = issueToken({ kind: "dismiss" }, 60_000);
		const dead = issueToken({ kind: "dismiss" }, 60_000);
		const deadFile = path.join(tokensDir(), `${dead}.json`);
		const rec = JSON.parse(fs.readFileSync(deadFile, "utf-8"));
		rec.expiresAtMs = Date.now() - 1_000;
		fs.writeFileSync(deadFile, JSON.stringify(rec));
		const removed = sweepExpiredTokens();
		assert.ok(removed >= 1);
		assert.equal(fs.existsSync(path.join(tokensDir(), `${live}.json`)), true);
		assert.equal(fs.existsSync(deadFile), false);
	});

	test("redeemToken returns null for unknown token", () => {
		assert.equal(redeemToken("deadbeefdeadbeef"), null);
	});
});

describe("mobile inbox — message queue", () => {
	test("enqueueMessage + drainMessages roundtrips and clears queue", () => {
		enqueueMessage({ token: "a".repeat(16), kind: "do" });
		enqueueMessage({ token: "b".repeat(16), kind: "reply", payload: "hello" });
		const drained = drainMessages();
		assert.equal(drained.length >= 2, true);
		const tokens = drained.map((m) => m.token);
		assert.ok(tokens.includes("a".repeat(16)));
		assert.ok(tokens.includes("b".repeat(16)));
		// Second drain should be empty (all messages deleted).
		const second = drainMessages().filter((m) => m.token === "a".repeat(16) || m.token === "b".repeat(16));
		assert.deepEqual(second, []);
	});

	test("drainMessages returns messages in receivedAtMs order", async () => {
		enqueueMessage({ token: "1".repeat(16), kind: "do" });
		await new Promise((r) => setTimeout(r, 5));
		enqueueMessage({ token: "2".repeat(16), kind: "do" });
		const drained = drainMessages();
		const idx1 = drained.findIndex((m) => m.token === "1".repeat(16));
		const idx2 = drained.findIndex((m) => m.token === "2".repeat(16));
		assert.ok(idx1 >= 0 && idx2 >= 0);
		assert.ok(idx1 < idx2, "older message must sort first");
	});

	test("drainMessages tolerates malformed JSON (deletes and skips)", () => {
		const bad = path.join(msgsDir(), `bad-${Date.now()}.json`);
		fs.writeFileSync(bad, "{not json");
		const drained = drainMessages();
		void drained;
		assert.equal(fs.existsSync(bad), false, "malformed file must be removed on drain");
	});
});
