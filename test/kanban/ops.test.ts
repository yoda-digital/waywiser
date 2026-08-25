import { describe, it, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ww-kanban-ops-test-"));
process.env.WAYWISER_HOME = tmp;

const { cardLine } = jiti("../../extensions/kanban/ops.js") as {
  cardLine: (c: Record<string, unknown>) => string;
};

after(() => {
  delete process.env.WAYWISER_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("cardLine todo age", () => {
  it("includes age for todo status", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const line = cardLine({
      id: "K-1",
      title: "some task",
      status: "todo",
      priority: "med",
      type: "task",
      updated_at: twoHoursAgo,
    });
    // The age suffix appears inside the [status …] brackets.
    assert.match(line, /\[todo\s+.+?\]/);
  });

  it("still excludes age for done status", () => {
    const line = cardLine({
      id: "K-2",
      title: "done task",
      status: "done",
      priority: "med",
      type: "task",
      updated_at: new Date().toISOString(),
    });
    assert.match(line, /\[done\]/);
  });
});
