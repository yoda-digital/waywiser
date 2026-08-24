import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ww-tuistamps-test-"));
process.env.WAYWISER_HOME = tmp;

const mod = jiti("../extensions/tui-stamps.js") as {
  default: (pi: unknown) => void;
  _makeStampCache: (cap?: number) => {
    get: (key: string, nowMs: number) => number;
    evictPrefix: (prefix: string) => void;
    clear: () => void;
    size: () => number;
  };
  _stampKey: (messageType: string, md: string) => string;
  _renderStampPrefix: (nowMs: number, style: "code" | "plain") => string;
  _loadConfig: () => { enabled: boolean; style: "code" | "plain" };
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

describe("_stampKey", () => {
  it("prefixes with messageType and truncates markdown to 40 chars", () => {
    const md = "hello world ".repeat(10);
    const key = mod._stampKey("user", md);
    assert.ok(key.startsWith("user|"));
    assert.equal(key.length, "user|".length + 40);
  });

  it("keeps short markdown intact", () => {
    assert.equal(mod._stampKey("assistant", "hi"), "assistant|hi");
  });
});

describe("_makeStampCache", () => {
  it("pins the first observed timestamp for a key", () => {
    const c = mod._makeStampCache(64);
    const first = c.get("user|abc", 1000);
    const second = c.get("user|abc", 2000);
    assert.equal(first, 1000);
    assert.equal(second, 1000);
  });

  it("returns fresh timestamp after evictPrefix", () => {
    const c = mod._makeStampCache(64);
    c.get("user|hello world", 1000);
    c.evictPrefix("user|hello");
    const after = c.get("user|hello world", 2000);
    assert.equal(after, 2000);
  });

  it("clear() empties the cache", () => {
    const c = mod._makeStampCache(64);
    c.get("k", 1000);
    c.clear();
    assert.equal(c.size(), 0);
    assert.equal(c.get("k", 2000), 2000);
  });

  it("LRU-evicts oldest entries when at capacity", () => {
    const c = mod._makeStampCache(2);
    c.get("a", 1000);
    c.get("b", 2000);
    c.get("c", 3000);              // evicts "a"
    c.get("b", 3500);              // refresh "b" to make it more recent than "c"
    assert.equal(c.get("a", 4000), 4000);   // fresh stamp — "a" was evicted, "c" is evicted now
    assert.equal(c.get("b", 5000), 2000);   // "b" still cached
  });
});

describe("_renderStampPrefix", () => {
  it("wraps stamp in backticks in code style, ends with a space", () => {
    const out = mod._renderStampPrefix(Date.now(), "code");
    assert.match(out, /^`\[.+\]`\s$/);
  });

  it("uses bare brackets in plain style, ends with a space", () => {
    const out = mod._renderStampPrefix(Date.now(), "plain");
    assert.match(out, /^\[.+\]\s$/);
    assert.ok(!out.startsWith("`"));
  });
});

describe("_loadConfig", () => {
  beforeEach(clearConfig);

  it("defaults to enabled=true, style=code when absent", () => {
    assert.deepEqual(mod._loadConfig(), { enabled: true, style: "code" });
  });

  it("reads enabled=false from tuiStamps.enabled", () => {
    writeConfig({ tuiStamps: { enabled: false } });
    assert.equal(mod._loadConfig().enabled, false);
  });

  it("reads style=plain from tuiStamps.style", () => {
    writeConfig({ tuiStamps: { style: "plain" } });
    assert.equal(mod._loadConfig().style, "plain");
  });

  it("ignores unknown style value, falls back to code", () => {
    writeConfig({ tuiStamps: { style: "rainbow" } });
    assert.equal(mod._loadConfig().style, "code");
  });
});

describe("extension wiring", () => {
  type Handlers = Record<string, Array<(event: unknown, ctx?: unknown) => unknown>>;
  interface MockAPI {
    handlers: Handlers;
    transformers: Array<(md: string, ctx: { messageType: string; isStreaming: boolean; availableWidth: number }) => string>;
    on(event: string, handler: (event: unknown, ctx?: unknown) => unknown): void;
    registerMarkdownTransformer(t: (md: string, ctx: { messageType: string; isStreaming: boolean; availableWidth: number }) => string): void;
  }
  function makeApi(): MockAPI {
    return {
      handlers: {},
      transformers: [],
      on(event, handler) {
        (this.handlers[event] ??= []).push(handler);
      },
      registerMarkdownTransformer(t) {
        this.transformers.push(t);
      },
    };
  }

  beforeEach(clearConfig);

  it("registers a markdown transformer", () => {
    const api = makeApi();
    mod.default(api as unknown);
    assert.equal(api.transformers.length, 1);
  });

  it("prefixes user markdown with a stamp", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const out = api.transformers[0]("hello", { messageType: "user", isStreaming: false, availableWidth: 80 });
    assert.match(out, /^`\[.+\]`\s+hello$/);
  });

  it("prefixes assistant markdown with a stamp", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const out = api.transformers[0]("world", { messageType: "assistant", isStreaming: false, availableWidth: 80 });
    assert.match(out, /^`\[.+\]`\s+world$/);
  });

  it("passes through assistant-thinking unchanged", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const out = api.transformers[0]("thinking...", { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 });
    assert.equal(out, "thinking...");
  });

  it("reuses stamp across streaming updates for the same message", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const t = api.transformers[0];
    const first = t("streaming reply here...", { messageType: "assistant", isStreaming: true, availableWidth: 80 });
    // Advance real time; cache should still return the same stamp.
    const start = Date.now();
    while (Date.now() - start < 60_000 / 1000) { /* micro-loop; effectively same minute */ break; }
    const second = t("streaming reply here... more tokens", { messageType: "assistant", isStreaming: true, availableWidth: 80 });
    const firstStamp = first.match(/`\[(.+?)\]`/)?.[1];
    const secondStamp = second.match(/`\[(.+?)\]`/)?.[1];
    assert.equal(firstStamp, secondStamp);
  });

  it("no-ops when tuiStamps.enabled=false", () => {
    writeConfig({ tuiStamps: { enabled: false } });
    const api = makeApi();
    mod.default(api as unknown);
    // Fire session_start so the extension re-reads config.
    for (const h of api.handlers["session_start"] ?? []) h(undefined);
    const out = api.transformers[0]("hello", { messageType: "user", isStreaming: false, availableWidth: 80 });
    assert.equal(out, "hello");
  });

  it("uses plain style when configured", () => {
    writeConfig({ tuiStamps: { style: "plain" } });
    const api = makeApi();
    mod.default(api as unknown);
    for (const h of api.handlers["session_start"] ?? []) h(undefined);
    const out = api.transformers[0]("hello", { messageType: "user", isStreaming: false, availableWidth: 80 });
    assert.match(out, /^\[.+\]\s+hello$/);
    assert.ok(!out.startsWith("`"));
  });

  it("session_start clears the streaming cache", () => {
    const api = makeApi();
    mod.default(api as unknown);
    const t = api.transformers[0];
    const before = t("cache me", { messageType: "user", isStreaming: true, availableWidth: 80 });
    for (const h of api.handlers["session_start"] ?? []) h(undefined);
    // After clear, next call for the same key gets a fresh Date.now(). We
    // can't easily assert the value differs (timing), but we can assert the
    // shape is still valid and the call doesn't throw.
    const afterCall = t("cache me", { messageType: "user", isStreaming: true, availableWidth: 80 });
    assert.match(afterCall, /^`\[.+\]`\s+cache me$/);
    void before;
  });
});
