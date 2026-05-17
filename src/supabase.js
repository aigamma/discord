// Minimal Supabase REST wrapper. The bot only reads, so a thin fetch helper
// is enough — no need to pull in @supabase/supabase-js. Mirrors the same
// PostgREST query shape that aigamma.com's Netlify functions use.
//
// Single retry on transient errors (timeout, network reset, 5xx) so a
// momentary blip does not abort a tool call. Non-transient errors (auth,
// 4xx) fail fast as before.

import { config } from './config.js';
import { logger } from './logger.js';

const TIMEOUT_MS = 8000;
const RETRY_BACKOFF_MS = 400;

function authHeaders() {
  return {
    apikey: config.supabase.key,
    Authorization: `Bearer ${config.supabase.key}`,
    'Content-Type': 'application/json',
  };
}

// Exported so the supabase.test.js suite can pin the actual predicates
// instead of mirroring them inline (which silently drifts when the
// source list of retried errors / status codes changes).
export function isTransientError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = err.cause?.code || err.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(code);
}

export function isTransientStatus(status) {
  return status === 502 || status === 503 || status === 504 || status === 408;
}

export async function selectRows(path, params = {}) {
  if (!config.supabase.enabled) {
    throw new Error('Supabase is not configured — set SUPABASE_URL and SUPABASE_KEY in .env.local');
  }
  const qs = new URLSearchParams(params).toString();
  const url = `${config.supabase.url}/rest/v1/${path}${qs ? '?' + qs : ''}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === 0 && isTransientError(err)) {
        logger.warn('supabase fetch transient, retrying', { path, err: err?.message || String(err) });
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      if (attempt === 0 && isTransientStatus(res.status)) {
        logger.warn('supabase fetch transient status, retrying', { path, status: res.status });
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
}
