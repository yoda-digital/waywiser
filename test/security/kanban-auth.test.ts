import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolated home for tests
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waywiser-kanban-auth-"));
process.env.WAYWISER_HOME = tmp;

import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { startBoardServer, getBoardToken } = jiti("../../extensions/kanban-server.ts") as {
  startBoardServer: (port?: number) => Promise<{ port: number; close: () => void }>;
  getBoardToken: () => string;
};
const { db_ } = jiti("../../extensions/utils/state.ts") as { db_: () => unknown };
// Force DB init so tables exist
db_();

let server: { port: number; close: () => void };
let baseUrl: string;

before(async () => {
  server = await startBoardServer(0); // random port
  baseUrl = `http://localhost:${server.port}`;
});

after(() => {
  server?.close();
});

describe("kanban server auth", () => {
  test("GET / serves HTML without auth (public)", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("__WAYWISER_TOKEN"), "HTML should embed the token");
  });

  test("GET /api/cards rejects without auth", async () => {
    const res = await fetch(`${baseUrl}/api/cards`);
    assert.equal(res.status, 401);
  });

  test("GET /api/cards rejects wrong token", async () => {
    const res = await fetch(`${baseUrl}/api/cards`, {
      headers: { Authorization: "Bearer wrong-token-here" },
    });
    assert.equal(res.status, 401);
  });

  test("GET /api/cards accepts correct token", async () => {
    const token = getBoardToken();
    const res = await fetch(`${baseUrl}/api/cards`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  test("POST /api/cards rejects without auth", async () => {
    const res = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "test" }),
    });
    assert.equal(res.status, 401);
  });

  test("GET /events rejects without token query param", async () => {
    const res = await fetch(`${baseUrl}/events`);
    assert.equal(res.status, 401);
  });

  test("no Access-Control-Allow-Origin header on responses", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});
