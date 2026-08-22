import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolated home
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-notify-test-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { sendNotification } = jiti("../../extensions/notify.ts") as {
  sendNotification: (title: string, body: string, channels?: string[], opts?: { bypassQuiet?: boolean }) =>
    Promise<{ sent: string[]; failed: string[] }>;
};

describe("notify shell injection prevention", () => {
  test("shell metacharacters in title do not execute as commands", async () => {
    const marker = path.join(tmp, "pwned-" + Date.now());
    // If shell injection works, this would create the marker file
    const result = await sendNotification(
      `$(touch ${marker})`,
      "test body",
      ["desktop"],
      { bypassQuiet: true },
    );
    // notify-send may or may not be installed — we don't care about delivery
    // What matters: the marker file must NOT exist
    assert.equal(fs.existsSync(marker), false, "shell injection must not execute");
  });

  test("backtick injection in body does not execute", async () => {
    const marker = path.join(tmp, "pwned2-" + Date.now());
    await sendNotification(
      "test",
      `\`touch ${marker}\``,
      ["desktop"],
      { bypassQuiet: true },
    );
    assert.equal(fs.existsSync(marker), false, "backtick injection must not execute");
  });

  test("newline in body does not break the command", async () => {
    // With exec(), a newline could terminate the command and start another
    // With spawn(), the entire string is one argument
    const result = await sendNotification(
      "title",
      "line1\nline2\nline3",
      ["desktop"],
      { bypassQuiet: true },
    );
    // Should complete without error (delivery success depends on notify-send)
    assert.ok(result, "should return a result object");
  });
});
