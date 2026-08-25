import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatJobRow } = jiti("../extensions/cronjob.js") as {
  formatJobRow: (job: Record<string, unknown>) => string;
};

describe("formatJobRow", () => {
  it("shows fmtSmart for recent lastRun", () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const line = formatJobRow({
      id: "j1",
      name: "test job",
      mode: "session",
      enabled: 1,
      schedule: "*/5 * * * *",
      prompt: "do something",
      lastRun: oneHourAgo,
    });
    assert.match(line, /last: .+?\)/);
  });

  it("omits last marker when lastRun absent", () => {
    const line = formatJobRow({
      id: "j2",
      name: null,
      mode: "session",
      enabled: 1,
      schedule: "0 * * * *",
      prompt: "do something else",
      lastRun: null,
    });
    assert.ok(!line.includes("last:"), `Expected no 'last:' in: ${line}`);
  });

  it("shows fmtDateTime for nextRun", () => {
    const inOneHour = new Date(Date.now() + 3_600_000).toISOString();
    const line = formatJobRow({
      id: "j3",
      name: "future job",
      mode: "session",
      enabled: 0,
      schedule: "0 * * * *",
      prompt: "check something",
      nextRun: inOneHour,
    });
    assert.match(line, /next: /);
  });
});
