import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-ctx-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseBattery, parseWifi, parseAudio, inferNetwork } = jiti(
	"../../extensions/mobile/context.ts",
) as typeof import("../../extensions/mobile/context.ts");

describe("mobile context — parseBattery", () => {
	test("normal shape maps to normalized reading", () => {
		const r = parseBattery({ percentage: 42, temperature: 33.2, status: "CHARGING", plugged: "PLUGGED_AC", health: "GOOD" });
		assert.ok(r);
		assert.equal(r.percentage, 42);
		assert.equal(r.temperatureC, 33.2);
		assert.equal(r.charging, true);
		assert.equal(r.status, "CHARGING");
	});
	test("UNPLUGGED + DISCHARGING → charging=false", () => {
		const r = parseBattery({ percentage: 80, temperature: 31, status: "DISCHARGING", plugged: "UNPLUGGED" });
		assert.equal(r?.charging, false);
	});
	test("missing percentage → undefined (unusable reading)", () => {
		assert.equal(parseBattery({}), undefined);
		assert.equal(parseBattery(null), undefined);
	});
	test("temperature missing → NaN (marker for filters using isFinite)", () => {
		const r = parseBattery({ percentage: 50, status: "FULL" });
		assert.ok(r);
		assert.ok(Number.isNaN(r.temperatureC));
	});
	test("FULL status counts as charging", () => {
		const r = parseBattery({ percentage: 100, temperature: 30, status: "FULL", plugged: "PLUGGED_USB" });
		assert.equal(r?.charging, true);
	});
});

describe("mobile context — parseWifi", () => {
	test("strips surrounding quotes from SSID and passes through fields", () => {
		const r = parseWifi({ ssid: '"HomeNet"', bssid: "aa:bb:cc:dd:ee:ff", rssi: -45, link_speed_mbps: 130, frequency_mhz: 5240 });
		assert.equal(r?.ssid, "HomeNet");
		assert.equal(r?.bssid, "aa:bb:cc:dd:ee:ff");
		assert.equal(r?.rssi, -45);
		assert.equal(r?.linkSpeedMbps, 130);
		assert.equal(r?.frequencyMhz, 5240);
	});
	test("<unknown ssid> is treated as unknown", () => {
		const r = parseWifi({ ssid: "<unknown ssid>", bssid: "02:00:00:00:00:00" });
		assert.equal(r?.ssid, undefined);
		assert.equal(r?.bssid, undefined, "sentinel MAC 02:00:00:00:00:00 must be ignored");
	});
	test("null raw → undefined reading", () => {
		assert.equal(parseWifi(null), undefined);
	});
});

describe("mobile context — parseAudio", () => {
	test("headphone flag detected via regex on flattened JSON", () => {
		const r = parseAudio({ HEADSET: "on" });
		assert.equal(r?.headphonesConnected, true);
		assert.equal(r?.bluetoothConnected, false);
	});
	test("bluetooth flag detected", () => {
		const r = parseAudio({ BLUETOOTH_A2DP_ON: "true" });
		assert.equal(r?.bluetoothConnected, true);
	});
	test("empty audio returns non-null reading with both flags false", () => {
		const r = parseAudio({});
		assert.equal(r?.headphonesConnected, false);
		assert.equal(r?.bluetoothConnected, false);
	});
	test("null → undefined", () => {
		assert.equal(parseAudio(null), undefined);
	});
});

describe("mobile context — inferNetwork", () => {
	test("wifi ssid present → wifi/unmetered", () => {
		const n = inferNetwork({ ssid: "Home" });
		assert.equal(n.type, "wifi");
		assert.equal(n.metered, false);
	});
	test("no wifi → unknown/metered (safe default)", () => {
		const n = inferNetwork(undefined);
		assert.equal(n.type, "unknown");
		assert.equal(n.metered, true);
	});
});
