import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-signals-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { mobileSignals, mobileDiscretion } = jiti(
	"../../extensions/mobile/signals.ts",
) as typeof import("../../extensions/mobile/signals.ts");
const { __setMobileContextForTests } = jiti(
	"../../extensions/mobile/context.ts",
) as typeof import("../../extensions/mobile/context.ts");

// Note on injection: signals.ts imports `lastMobileContext` from context.ts,
// and both modules are loaded through the same jiti instance so they share
// the module-scope `cached` binding. Setting the cache here is visible to the
// live `lastMobileContext()` call inside signals.ts.

beforeEach(() => {
	__setMobileContextForTests(null);
});

describe("mobile signals — mobileSignals()", () => {
	test("returns [] when context unavailable", () => {
		__setMobileContextForTests({ available: false, atMs: Date.now() });
		assert.deepEqual(mobileSignals(), []);
	});

	test("battery <=10% and not charging → P0 critical", () => {
		__setMobileContextForTests({
			available: true,
			atMs: Date.now(),
			battery: { percentage: 8, temperatureC: 30, charging: false, status: "DISCHARGING" },
		});
		const s = mobileSignals();
		const crit = s.find((x) => x.key === "mobile-battery-critical");
		assert.ok(crit);
		assert.equal(crit.priority, 0);
		assert.equal(crit.requiresLLM, false);
	});

	test("battery <=10% but charging → no critical signal", () => {
		__setMobileContextForTests({
			available: true,
			atMs: Date.now(),
			battery: { percentage: 5, temperatureC: 30, charging: true, status: "CHARGING" },
		});
		assert.equal(mobileSignals().find((s) => s.key === "mobile-battery-critical"), undefined);
	});

	test("battery temperature >= 43°C → P2 thermal signal", () => {
		__setMobileContextForTests({
			available: true,
			atMs: Date.now(),
			battery: { percentage: 60, temperatureC: 44.5, charging: false, status: "DISCHARGING" },
		});
		const s = mobileSignals();
		const thermal = s.find((x) => x.key === "mobile-thermal-high");
		assert.ok(thermal);
		assert.equal(thermal.priority, 2);
	});

	test("NaN temperature does not emit thermal signal", () => {
		__setMobileContextForTests({
			available: true,
			atMs: Date.now(),
			battery: { percentage: 60, temperatureC: Number.NaN, charging: false, status: "UNKNOWN" },
		});
		assert.equal(mobileSignals().find((s) => s.key === "mobile-thermal-high"), undefined);
	});
});

describe("mobile signals — mobileDiscretion()", () => {
	const s = (priority: number, requiresLLM: boolean, key = `k${priority}`) => ({
		key,
		priority,
		requiresLLM,
		title: key,
		body: key,
	});

	test("battery <20% not-charging drops P2/P3, keeps P0/P1", () => {
		__setMobileContextForTests({
			available: true,
			atMs: Date.now(),
			battery: { percentage: 15, temperatureC: 30, charging: false, status: "DISCHARGING" },
		});
		const kept = mobileDiscretion([s(0, false), s(1, true), s(2, false), s(3, false)]).map((x) => x.priority);
		assert.deepEqual(kept, [0, 1]);
	});

	test("hot device (>42°C) drops LLM signals except P0", () => {
		__setMobileContextForTests({
			available: true,
			atMs: Date.now(),
			battery: { percentage: 80, temperatureC: 43, charging: false, status: "DISCHARGING" },
		});
		const kept = mobileDiscretion([s(0, true), s(1, true), s(2, false)]).map((x) => x.key);
		assert.deepEqual(kept, ["k0", "k2"]);
	});

	test("cool + charged → no filtering", () => {
		__setMobileContextForTests({
			available: true,
			atMs: Date.now(),
			battery: { percentage: 90, temperatureC: 30, charging: true, status: "CHARGING" },
		});
		const inp = [s(0, false), s(1, true), s(2, true), s(3, false)];
		assert.equal(mobileDiscretion(inp).length, inp.length);
	});

	test("no context → passthrough", () => {
		__setMobileContextForTests(null);
		const inp = [s(0, false), s(3, true)];
		assert.deepEqual(mobileDiscretion(inp), inp);
	});
});
