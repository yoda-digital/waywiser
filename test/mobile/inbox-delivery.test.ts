import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { _receivedPrefix } = jiti("../../extensions/mobile/index.js") as {
  _receivedPrefix: (receivedAtMs: number) => string;
};

describe("mobile _receivedPrefix", () => {
  it("wraps receivedAtMs in a [received … · … ago] prefix ending in a space", () => {
    const p = _receivedPrefix(Date.now() - 3600_000);
    assert.match(p, /^\[received .+? · .+? ago\]\s$/);
  });
});
