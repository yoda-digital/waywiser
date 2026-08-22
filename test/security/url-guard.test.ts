import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { checkUrl } = jiti("../../extensions/utils/url-guard.ts") as typeof import("../../extensions/utils/url-guard.ts");

describe("URL guard", () => {
  // ── Blocked URLs ──
  const blocked = [
    ["http://localhost/secret", "localhost"],
    ["http://127.0.0.1:7749/api/cards", "loopback"],
    ["http://127.0.0.2/", "loopback range"],
    ["http://0.0.0.0/", "zero address"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://10.0.0.1/admin", "RFC1918 10.x"],
    ["http://172.16.0.1/", "RFC1918 172.16"],
    ["http://172.31.255.255/", "RFC1918 172.31"],
    ["http://192.168.1.1/admin", "RFC1918 192.168"],
    ["http://169.254.169.254/latest/meta-data/", "link-local"],
    ["file:///etc/passwd", "file scheme"],
    ["ftp://example.com/file", "ftp scheme"],
    ["data:text/html,<h1>xss</h1>", "data scheme"],
    ["not a url at all", "unparseable"],
  ] as const;

  for (const [url, label] of blocked) {
    test(`blocks ${label}: ${url}`, () => {
      const result = checkUrl(url);
      assert.equal(result.allowed, false, `expected blocked: ${url}`);
      assert.ok(result.reason, "should include reason");
    });
  }

  // ── Allowed URLs ──
  const allowed = [
    "https://example.com/page",
    "http://duckduckgo.com/html/?q=test",
    "https://api.github.com/repos/test/test",
    "https://1.1.1.1/dns-query",
    "https://8.8.8.8/",
    "https://wikipedia.org/wiki/Moldova",
  ];

  for (const url of allowed) {
    test(`allows ${url}`, () => {
      assert.equal(checkUrl(url).allowed, true, `expected allowed: ${url}`);
    });
  }
});
