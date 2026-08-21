/**
 * waywiser-brain — embedding support for semantic vector recall.
 *
 * Calls BGE-M3 via Ollama's OpenAI-compatible API to generate 1024-dim
 * embeddings. Provides cosine similarity and serialization helpers for
 * storing/loading Float32Array vectors as SQLite BLOBs.
 *
 * All network calls are fail-soft: a missing API key, unreachable server,
 * or malformed response returns `null` so the caller can proceed without
 * the semantic signal.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BrainConfig } from "./types.ts";

const API_KEY_PATH = path.join(process.env.HOME || ".", ".config/nalyk-ollama/api-key");

function getApiKey(): string | null {
  try { return fs.readFileSync(API_KEY_PATH, "utf-8").trim(); } catch { return null; }
}

/**
 * Generate an embedding for text using BGE-M3 via Ollama.
 * Returns a Float32Array of 1024 dimensions, or null on failure.
 */
export async function embed(text: string, config?: BrainConfig): Promise<Float32Array | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const baseUrl = config?.embeddings?.baseUrl || "https://ollama.nalyk.dev/v1";
  const model = config?.embeddings?.model || "bge-m3:latest";

  try {
    const resp = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as { data?: Array<{ embedding?: number[] }> };
    const vec = data?.data?.[0]?.embedding;
    if (!vec || !vec.length) return null;
    return new Float32Array(vec);
  } catch {
    return null;
  }
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize Float32Array to Buffer for SQLite BLOB storage.
 */
export function vecToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialize Buffer from SQLite BLOB back to Float32Array.
 */
export function blobToVec(blob: Buffer | Uint8Array): Float32Array {
  const ab = new ArrayBuffer(blob.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < blob.length; i++) view[i] = blob[i];
  return new Float32Array(ab);
}
