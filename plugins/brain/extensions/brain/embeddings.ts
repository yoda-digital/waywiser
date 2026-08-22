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
 *
 * BGE-M3 (568M params) is always forced onto CPU via `options: { num_gpu: 0 }`
 * so it never contends with the generation model (Qwen 3.8, 27B) for GPU.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { BrainConfig } from "./types.ts";

const API_KEY_PATH = path.join(process.env.HOME || ".", ".config/nalyk-ollama/api-key");

function getApiKey(): string | null {
  try { return fs.readFileSync(API_KEY_PATH, "utf-8").trim(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// LRU cache — avoids re-embedding repeated/similar text via Ollama.
// ---------------------------------------------------------------------------

const embedCache = new Map<string, Float32Array>();
const CACHE_MAX = 100;

/** Truncated SHA-256 of the input text, used as the cache key. */
function cacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Reads from the cache, marking the entry as most-recently-used on hit. */
function cacheGet(key: string): Float32Array | undefined {
  const vec = embedCache.get(key);
  if (vec === undefined) return undefined;
  // Re-insert to move this key to the end (most-recently-used) of Map's
  // iteration order.
  embedCache.delete(key);
  embedCache.set(key, vec);
  return vec;
}

/** Inserts into the cache, evicting the least-recently-used entry if full. */
function cacheSet(key: string, vec: Float32Array): void {
  if (!embedCache.has(key) && embedCache.size >= CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  embedCache.set(key, vec);
}

/** Strips a trailing `/v1` from an OpenAI-compatible base URL, so we can
 *  hit Ollama's native (non-OpenAI-compatible) API endpoints on the same host. */
function nativeApiBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/**
 * Generate an embedding for text using BGE-M3 via Ollama.
 * Returns a Float32Array of 1024 dimensions, or null on failure.
 */
export async function embed(text: string, config?: BrainConfig): Promise<Float32Array | null> {
  const key = cacheKey(text);
  const cached = cacheGet(key);
  if (cached) return cached;

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
      body: JSON.stringify({
        model,
        input: text,
        options: { num_gpu: 0 }, // Force CPU — free GPU for generation
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as { data?: Array<{ embedding?: number[] }> };
    const vec = data?.data?.[0]?.embedding;
    if (!vec || !vec.length) return null;
    const result = new Float32Array(vec);
    cacheSet(key, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Generate embeddings for many texts in a single Ollama call, using the
 * native `/api/embed` batch endpoint (accepts `input: string[]`, returns
 * `embeddings: number[][]`). Replaces N sequential `embed()` calls (e.g.
 * at session_start) with one HTTP round-trip.
 *
 * Returns an array the same length as `texts`; each entry is a Float32Array
 * on success or null if that item's embedding failed/was missing. On total
 * failure (no API key, network error, malformed response) every entry is
 * null — the caller can proceed without the semantic signal.
 */
export async function embedBatch(texts: string[], config: BrainConfig): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];

  const apiKey = getApiKey();
  if (!apiKey) return texts.map(() => null);

  const baseUrl = config?.embeddings?.baseUrl || "https://ollama.nalyk.dev/v1";
  const model = config?.embeddings?.model || "bge-m3:latest";

  try {
    const resp = await fetch(`${nativeApiBase(baseUrl)}/api/embed`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: texts,
        options: { num_gpu: 0 }, // Force CPU — free GPU for generation
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) return texts.map(() => null);
    const data = await resp.json() as { embeddings?: number[][] };
    const vectors = data?.embeddings;
    if (!vectors || vectors.length !== texts.length) return texts.map(() => null);

    return vectors.map((vec, i) => {
      if (!vec || !vec.length) return null;
      const result = new Float32Array(vec);
      cacheSet(cacheKey(texts[i]), result);
      return result;
    });
  } catch {
    return texts.map(() => null);
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
