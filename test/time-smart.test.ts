import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ww-smart-test-"));
process.env.WAYWISER_HOME = tmp;

const time = jiti("../extensions/utils/time.js") as {
  fmtSmart: (v: string | number, thresholdHours?: number) => string;
  fmtAge: (v: string | number) => string;
  fmtStamp: (v: string | number) => string;
  relativeThresholdHours: () => number;
  _resetTimeCaches: () => void;
};

function writeConfig(cfg: object): void {
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify(cfg));
}
function clearConfig(): void {
  try { fs.unlinkSync(path.join(tmp, "config.json")); } catch { /* ok */ }
}

after(() => {
  delete process.env.WAYWISER_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("fmtSmart", () => {
  it("returns age for recent timestamps (below threshold)", () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    assert.equal(time.fmtSmart(oneHourAgo, 24), time.fmtAge(oneHourAgo));
  });

  it("returns stamp for old timestamps (above threshold)", () => {
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    assert.equal(time.fmtSmart(fiveDaysAgo, 24), time.fmtStamp(fiveDaysAgo));
  });

  it("returns age at exact threshold boundary (tie → age)", () => {
    const exactlyThreshold = Date.now() - 24 * 60 * 60 * 1000;
    assert.equal(time.fmtSmart(exactlyThreshold, 24), time.fmtAge(exactlyThreshold));
  });

  it("returns age for future timestamps", () => {
    const inFiveMin = Date.now() + 5 * 60 * 1000;
    assert.equal(time.fmtSmart(inFiveMin, 24), time.fmtAge(inFiveMin));
  });

  it("uses custom threshold when passed", () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    assert.equal(time.fmtSmart(twoHoursAgo, 1), time.fmtStamp(twoHoursAgo));
    assert.equal(time.fmtSmart(twoHoursAgo, 3), time.fmtAge(twoHoursAgo));
  });
});

describe("relativeThresholdHours", () => {
  before(clearConfig);
  after(clearConfig);

  it("defaults to 24 when config absent", () => {
    clearConfig();
    time._resetTimeCaches();
    assert.equal(time.relativeThresholdHours(), 24);
  });

  it("reads valid positive threshold from config", () => {
    writeConfig({ timeDisplay: { relativeThresholdHours: 48 } });
    time._resetTimeCaches();
    assert.equal(time.relativeThresholdHours(), 48);
  });

  it("falls back to 24 when value is not a positive finite number", () => {
    writeConfig({ timeDisplay: { relativeThresholdHours: -5 } });
    time._resetTimeCaches();
    assert.equal(time.relativeThresholdHours(), 24);
    writeConfig({ timeDisplay: { relativeThresholdHours: "abc" } });
    time._resetTimeCaches();
    assert.equal(time.relativeThresholdHours(), 24);
    writeConfig({ timeDisplay: { relativeThresholdHours: 0 } });
    time._resetTimeCaches();
    assert.equal(time.relativeThresholdHours(), 24);
  });
});
