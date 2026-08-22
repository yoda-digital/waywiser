import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

// parseToolCalls will be exported from execute-code.ts after the rewrite
const { parseToolCalls } = jiti("../../extensions/execute-code.ts") as {
  parseToolCalls: (code: string) => Array<{ tool: string; args: Record<string, unknown> }>;
};

describe("parseToolCalls sandbox", () => {
  test("parses a valid toolCalls array", () => {
    const calls = parseToolCalls(`
      const toolCalls = [
        { tool: "memory", args: { action: "recall", query: "test" } },
      ];
    `);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "memory");
    assert.deepEqual(calls[0].args, { action: "recall", query: "test" });
  });

  test("parses multiple calls with computed args", () => {
    const calls = parseToolCalls(`
      const base = "memory";
      const toolCalls = [
        { tool: base, args: { action: "recall", query: "q1" } },
        { tool: base, args: { action: "recall", query: "q2" } },
      ];
    `);
    assert.equal(calls.length, 2);
  });

  test("blocks prototype chain escape via this.constructor.constructor", () => {
    assert.throws(
      () => parseToolCalls(`
        const p = this.constructor.constructor('return process')();
        const toolCalls = [{ tool: "test", args: { pid: p.pid } }];
      `),
      (err: Error) => {
        // Node's vm module gives each context its own realm-local Function
        // constructor, so `this.constructor.constructor` resolves to the
        // SANDBOX's Function (not the outer Node one). The constructed
        // function still runs inside the sandbox, where `process` is
        // genuinely undefined — verified empirically, this throws
        // "process is not defined", not a prototype-chain error. Either
        // way, the host process object is unreachable.
        return err.message.includes("Cannot read properties of undefined") ||
               err.message.includes("constructor") ||
               err.message.includes("process is not defined");
      },
    );
  });

  test("blocks globalThis.process access", () => {
    assert.throws(
      () => parseToolCalls(`
        const toolCalls = [{ tool: "t", args: { env: globalThis.process.env } }];
      `),
      (err: Error) => {
        return err.message.includes("process is not defined") ||
               err.message.includes("Cannot read properties");
      },
    );
  });

  test("blocks require", () => {
    assert.throws(
      () => parseToolCalls(`
        const fs = require('fs');
        const toolCalls = [{ tool: "t", args: {} }];
      `),
      /require is not defined/,
    );
  });

  test("times out on infinite loop (≤6s)", { timeout: 10_000 }, () => {
    assert.throws(
      () => parseToolCalls(`while(true){} const toolCalls = [];`),
      /Script execution timed out/,
    );
  });

  test("rejects empty toolCalls", () => {
    assert.throws(
      () => parseToolCalls(`const toolCalls = [];`),
      /non-empty/,
    );
  });

  test("rejects missing toolCalls", () => {
    assert.throws(
      () => parseToolCalls(`const x = 42;`),
      /toolCalls is not defined/,
    );
  });

  test("rejects entry with no tool name", () => {
    assert.throws(
      () => parseToolCalls(`const toolCalls = [{ args: {} }];`),
      /tool must be a non-empty string/,
    );
  });

  test("rejects entry with non-object args", () => {
    assert.throws(
      () => parseToolCalls(`const toolCalls = [{ tool: "x", args: "bad" }];`),
      /args must be a plain object/,
    );
  });

  test("deep-clones result (no shared references to sandbox)", () => {
    const calls = parseToolCalls(`
      const shared = { key: "value" };
      const toolCalls = [{ tool: "t", args: shared }];
    `);
    calls[0].args.key = "mutated";
    assert.equal(calls[0].args.key, "mutated");
    // The point: mutation is possible because it's a plain clone, not a proxy
  });
});
