// Unit tests for buildWebhookPayload in notify.ts
// Run: node --test test/notify.test.ts

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildWebhookPayload } = jiti("../extensions/notify.js") as {
	buildWebhookPayload: (title: string, body: string, level: string, nowMs?: number) => Record<string, unknown>;
};

describe("buildWebhookPayload", () => {
	it("includes iso, human, and age fields", () => {
		const now = Date.parse("2026-08-25T14:23:00.000Z");
		const p = buildWebhookPayload("test", "hello", "info", now);
		assert.equal(typeof p.iso, "string");
		assert.equal(typeof p.human, "string");
		assert.equal(typeof p.age, "string");
		assert.ok((p.iso as string).includes("2026-08-25"), `iso should contain 2026-08-25, got: ${p.iso}`);
	});

	it("preserves timestamp and source fields for downstream consumers", () => {
		const now = Date.parse("2026-08-25T14:23:00.000Z");
		const p = buildWebhookPayload("test", "hello", "normal", now);
		assert.equal(typeof p.timestamp, "string", "timestamp field must exist");
		assert.equal(p.source, "waywiser", "source must be waywiser");
	});

	it("iso and timestamp are the same ISO string", () => {
		const now = Date.parse("2026-08-25T14:23:00.000Z");
		const p = buildWebhookPayload("test", "hello", "normal", now);
		assert.equal(p.iso, p.timestamp, "iso and timestamp must be equal");
		assert.equal(p.iso, new Date(now).toISOString());
	});

	it("threads level into payload", () => {
		const now = Date.parse("2026-08-25T14:23:00.000Z");
		const p = buildWebhookPayload("alert", "something", "critical", now);
		assert.equal(p.level, "critical");
	});

	it("includes title and body verbatim", () => {
		const now = Date.parse("2026-08-25T14:23:00.000Z");
		const p = buildWebhookPayload("My Title", "My Body", "normal", now);
		assert.equal(p.title, "My Title");
		assert.equal(p.body, "My Body");
	});
});
