// Voyage embeddings client. Single-purpose: take text → return Float32Array
// of the chosen model's dimension (voyage-3 → 1024 dims). Used by the
// background embedder to embed persisted user messages, and by the
// search_chat_history tool to embed live query text.
//
// Voyage's REST API supports batch input (up to 128 strings per call). We
// batch in groups of 32 for headroom and per-call latency.
//
// Pricing as of 2026: voyage-3 is ~$0.06 / 1M tokens — orders of magnitude
// cheaper than the model calls, so embedding every persisted message is
// effectively free at this scale.

import { config } from './config.js';

const API_URL = 'https://api.voyageai.com/v1/embeddings';
const BATCH_SIZE = 32;
const TIMEOUT_MS = 30000;

export const isEnabled = () => config.voyage.enabled;

export async function embed(texts, { inputType = 'document' } = {}) {
  if (!config.voyage.enabled) {
    throw new Error('Voyage embeddings are not configured (set VOYAGE_API_KEY)');
  }
  if (!Array.isArray(texts)) texts = [texts];
  if (texts.length === 0) return [];

  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.voyage.apiKey}`,
      },
      body: JSON.stringify({
        model: config.voyage.model,
        input: batch,
        input_type: inputType,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Voyage ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    if (!Array.isArray(json.data)) {
      throw new Error('Voyage response missing data array');
    }
    for (let j = 0; j < json.data.length; j++) {
      const vec = new Float32Array(json.data[j].embedding);
      out[i + j] = vec;
    }
  }
  return out;
}

export function vecToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVec(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
