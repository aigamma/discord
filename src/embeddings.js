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
const RETRY_BACKOFF_MS = 500;

// Transient HTTP statuses worth a single retry. 5xx server-side errors
// plus 429 rate-limit plus 408 client timeout. 4xx authn/authz/input
// errors fail fast — retrying won't change a bad API key.
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// Socket-level error codes propagated by undici. Matches the supabase
// helper's set for consistency.
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ECONNREFUSED',
  'UND_ERR_SOCKET',
]);

function isTransientFetchError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = err.code || err.cause?.code;
  return code ? TRANSIENT_CODES.has(code) : false;
}

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
    // Single retry on transient failures (network or 5xx/429). Live
    // /search and search_chat_history both call this synchronously; a
    // Voyage hiccup without retry surfaces as an error to the model
    // mid-turn. The background embedder retries naturally on its next
    // tick — the extra in-line attempt costs at most ~500ms there.
    let res;
    let attempt = 0;
    while (true) {
      try {
        res = await fetch(API_URL, {
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
      } catch (err) {
        if (attempt === 0 && isTransientFetchError(err)) {
          attempt++;
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        throw err;
      }
      if (!res.ok && attempt === 0 && TRANSIENT_STATUSES.has(res.status)) {
        attempt++;
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      break;
    }
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
