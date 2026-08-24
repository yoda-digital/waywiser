import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

// WAYWISER_HOME isolation: point config reads at a temp dir.
// Import AFTER env is set (state module reads env lazily via waywiserHome()).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ww-time-test-"));
process.env.WAYWISER_HOME = tmp;

const time = jiti("../extensions/utils/time.js") as {
  parseTs: (v: string | number) => number;
  fmtTime: (v: string | number) => string;
  fmtDate: (v: string | number) => string;
  fmtDateTime: (v: string | number) => string;
  fmtStamp: (v: string | number) => string;
  fmtDateOnly: (v: string | number) => string;
  fmtIso: (v: string | number) => string;
  fmtDuration: (ms: number) => string;
  fmtAge: (v: string | number) => string;
  userTz: () => string;
  isValidTz: (tz: string) => boolean;
  nowIso: () => string;
  nowEpoch: () => number;
};

after(() => {
  delete process.env.WAYWISER_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Helper: write a config with a specific timezone. */
function setTz(tz: string): void {
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ timezone: tz }));
}
/** Helper: remove config so userTz falls back to system. */
function clearTz(): void {
  try { fs.unlinkSync(path.join(tmp, "config.json")); } catch { /* ok */ }
}

describe("parseTs", () => {
  it("parses JS ISO format", () => {
    const ms = time.parseTs("2026-08-24T14:23:00.000Z");
    assert.equal(ms, Date.parse("2026-08-24T14:23:00.000Z"));
  });

  it("parses SQLite format as UTC", () => {
    const ms = time.parseTs("2026-08-24 14:23:00");
    assert.equal(ms, Date.parse("2026-08-24T14:23:00Z"));
  });

  it("passes through epoch numbers", () => {
    assert.equal(time.parseTs(1724509380000), 1724509380000);
  });

  it("throws on invalid input", () => {
    assert.throws(() => time.parseTs("not-a-date"), /invalid timestamp/);
  });
});

describe("fmtTime", () => {
  before(() => setTz("UTC"));
  after(() => clearTz());

  it("formats as HH:MM in user TZ", () => {
    assert.equal(time.fmtTime("2026-08-24T14:23:00.000Z"), "14:23");
  });
});

describe("fmtStamp", () => {
  before(() => setTz("UTC"));
  after(() => clearTz());

  it("returns time-only for same-day timestamps", () => {
    const todayIso = new Date().toISOString();
    const result = time.fmtStamp(todayIso);
    assert.match(result, /^\d{2}:\d{2}$/);
  });

  it("includes date for cross-day timestamps", () => {
    const result = time.fmtStamp("2020-01-15T09:30:00.000Z");
    assert.match(result, /Jan 15,? \d{2}:\d{2}/);
  });
});

describe("fmtDuration", () => {
  it("formats seconds", () => {
    assert.equal(time.fmtDuration(5000), "5s");
    assert.equal(time.fmtDuration(45000), "45s");
  });

  it("formats minutes and seconds", () => {
    assert.equal(time.fmtDuration(150_000), "2m 30s");
  });

  it("formats hours and minutes", () => {
    assert.equal(time.fmtDuration(4_500_000), "1h 15m");
  });

  it("formats days and hours", () => {
    assert.equal(time.fmtDuration(97_200_000), "1d 3h");
  });

  it("handles zero", () => {
    assert.equal(time.fmtDuration(0), "0s");
  });
});

describe("fmtDateOnly", () => {
  before(() => setTz("UTC"));
  after(() => clearTz());

  it("returns YYYY-MM-DD", () => {
    assert.equal(time.fmtDateOnly("2026-08-24T14:23:00.000Z"), "2026-08-24");
  });
});

describe("fmtAge", () => {
  it("returns human-readable age", () => {
    const twoMinAgo = Date.now() - 120_000;
    const result = time.fmtAge(twoMinAgo);
    assert.match(result, /2m.*ago/);
  });
});

describe("userTz", () => {
  it("returns configured timezone", () => {
    setTz("Europe/Chisinau");
    assert.equal(time.userTz(), "Europe/Chisinau");
  });

  it("falls back to system timezone when not configured", () => {
    clearTz();
    const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(time.userTz(), sysTz);
  });

  it("falls back to system timezone for invalid IANA string", () => {
    setTz("Not/A/Zone");
    const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(time.userTz(), sysTz);
    clearTz();
  });
});

describe("isValidTz", () => {
  it("accepts valid IANA timezone", () => {
    assert.equal(time.isValidTz("America/New_York"), true);
  });

  it("rejects invalid timezone", () => {
    assert.equal(time.isValidTz("Fake/Zone"), false);
  });
});
