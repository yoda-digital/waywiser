import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, vecToBlob, blobToVec, embed } from "../../extensions/brain/embeddings.ts";
import { BrainStore } from "../../extensions/brain/store.ts";

describe("embeddings", () => {
  describe("cosineSimilarity", () => {
    it("returns 1.0 for identical vectors", () => {
      const v = new Float32Array([1, 2, 3, 4]);
      assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-6);
    });

    it("returns ~0 for orthogonal vectors", () => {
      const a = new Float32Array([1, 0, 0, 0]);
      const b = new Float32Array([0, 1, 0, 0]);
      assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6);
    });

    it("returns -1.0 for opposite vectors", () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([-1, 0, 0]);
      assert.ok(Math.abs(cosineSimilarity(a, b) - (-1.0)) < 1e-6);
    });

    it("returns 0 for mismatched lengths", () => {
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([1, 2]);
      assert.equal(cosineSimilarity(a, b), 0);
    });

    it("returns 0 for zero vectors", () => {
      const a = new Float32Array([0, 0, 0]);
      const b = new Float32Array([1, 2, 3]);
      assert.equal(cosineSimilarity(a, b), 0);
    });

    it("computes correctly for known values", () => {
      // cos([1,2,3], [4,5,6]) = (4+10+18) / (sqrt(14) * sqrt(77)) = 32 / sqrt(1078) ≈ 0.9746
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([4, 5, 6]);
      const sim = cosineSimilarity(a, b);
      assert.ok(Math.abs(sim - 0.9746) < 0.001, `expected ~0.9746, got ${sim}`);
    });
  });

  describe("vecToBlob / blobToVec round-trip", () => {
    it("round-trips correctly for a simple vector", () => {
      const original = new Float32Array([1.5, -2.3, 0, 999.999, -0.001]);
      const blob = vecToBlob(original);
      const recovered = blobToVec(blob);

      assert.equal(recovered.length, original.length);
      for (let i = 0; i < original.length; i++) {
        assert.ok(
          Math.abs(recovered[i] - original[i]) < 1e-6,
          `index ${i}: expected ${original[i]}, got ${recovered[i]}`,
        );
      }
    });

    it("round-trips a 1024-dim vector (BGE-M3 size)", () => {
      const original = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) original[i] = Math.random() * 2 - 1;

      const blob = vecToBlob(original);
      assert.equal(blob.length, 1024 * 4); // 4 bytes per float32

      const recovered = blobToVec(blob);
      assert.equal(recovered.length, 1024);
      for (let i = 0; i < 1024; i++) {
        assert.ok(
          Math.abs(recovered[i] - original[i]) < 1e-6,
          `index ${i}: expected ${original[i]}, got ${recovered[i]}`,
        );
      }
    });

    it("round-trips an empty vector", () => {
      const original = new Float32Array(0);
      const blob = vecToBlob(original);
      const recovered = blobToVec(blob);
      assert.equal(recovered.length, 0);
    });
  });

  describe("embed", () => {
    it("returns null or a Float32Array (no crash regardless of API key presence)", async () => {
      // If the API key file exists on this machine, embed() will make a
      // real network call and return a Float32Array. If it doesn't exist,
      // it returns null. Either outcome is correct — the test verifies
      // that embed() never throws.
      const result = await embed("test text");
      if (result !== null) {
        assert.ok(result instanceof Float32Array, "expected Float32Array when embed succeeds");
        assert.ok(result.length > 0, "expected non-empty vector");
      }
      // null is also a valid outcome (missing key or network error)
    });
  });

  describe("store: memory_embeddings table", () => {
    let store: BrainStore;

    beforeEach(() => {
      store = new BrainStore(":memory:");
    });

    afterEach(() => {
      store.close();
    });

    it("memory_embeddings table exists after migration", () => {
      const rows = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'")
        .all() as Array<{ name: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, "memory_embeddings");
    });

    it("setEmbedding and getEmbedding round-trip", () => {
      store.db.exec("INSERT INTO memories (id, type, content) VALUES (1, 'fact', 'test')");
      const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const blob = vecToBlob(vec);
      store.setEmbedding(1, blob, "bge-m3");

      const retrieved = store.getEmbedding(1);
      assert.ok(retrieved !== null);
      const recoveredVec = blobToVec(retrieved!);
      assert.equal(recoveredVec.length, 4);
      assert.ok(Math.abs(recoveredVec[0] - 0.1) < 1e-6);
      assert.ok(Math.abs(recoveredVec[3] - 0.4) < 1e-6);
    });

    it("getEmbedding returns null for missing memory", () => {
      assert.equal(store.getEmbedding(999), null);
    });

    it("setEmbedding replaces on conflict (same memory_id)", () => {
      store.db.exec("INSERT INTO memories (id, type, content) VALUES (1, 'fact', 'test')");
      const vec1 = vecToBlob(new Float32Array([1, 2, 3]));
      const vec2 = vecToBlob(new Float32Array([4, 5, 6]));

      store.setEmbedding(1, vec1);
      store.setEmbedding(1, vec2);

      const retrieved = store.getEmbedding(1);
      const recovered = blobToVec(retrieved!);
      assert.ok(Math.abs(recovered[0] - 4) < 1e-6);
    });

    it("getAllEmbeddings returns all stored embeddings", () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content) VALUES (1, 'fact', 'a');
        INSERT INTO memories (id, type, content) VALUES (2, 'fact', 'b');
      `);
      store.setEmbedding(1, vecToBlob(new Float32Array([1, 0])));
      store.setEmbedding(2, vecToBlob(new Float32Array([0, 1])));

      const all = store.getAllEmbeddings();
      assert.equal(all.length, 2);
      const ids = all.map(e => e.memoryId).sort();
      assert.deepEqual(ids, [1, 2]);
    });

    it("getMemoriesWithoutEmbeddings finds unembedded active memories", () => {
      store.db.exec(`
        INSERT INTO memories (id, type, content, status) VALUES (1, 'fact', 'has embedding', 'active');
        INSERT INTO memories (id, type, content, status) VALUES (2, 'fact', 'no embedding', 'active');
        INSERT INTO memories (id, type, content, status) VALUES (3, 'fact', 'archived no emb', 'archived');
      `);
      store.setEmbedding(1, vecToBlob(new Float32Array([1])));

      const unembedded = store.getMemoriesWithoutEmbeddings(10);
      assert.equal(unembedded.length, 1);
      assert.equal(unembedded[0].id, 2);
      assert.equal(unembedded[0].content, "no embedding");
    });

    it("getMemoriesWithoutEmbeddings respects limit", () => {
      for (let i = 1; i <= 10; i++) {
        store.db.prepare("INSERT INTO memories (id, type, content, status) VALUES (?, 'fact', ?, 'active')").run(i, `mem ${i}`);
      }
      const unembedded = store.getMemoriesWithoutEmbeddings(3);
      assert.equal(unembedded.length, 3);
    });
  });
});
