// Shared Anthropic transient-error retry. Used by agent.answer() and
// summarize() so both paths handle 429/5xx the same way. Status codes
// chosen to match the supabase wrapper plus Anthropic-specific 529
// (overloaded). Also retries on network-level failures (socket reset,
// DNS timeout, connection refused) because those have no HTTP status
// but are just as transient and just as worth one or two more tries.

import { logger } from './logger.js';

const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 8000];

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

// Node/undici error codes that mean "the connection died, not the
// request". A fresh attempt against api.anthropic.com is the right
// response, not a hard fail back to the user.
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

// Anthropic SDK error class names raised when the request never reaches
// the server (no status to inspect). These wrap the underlying fetch
// error in `cause` but are easier to identify by name.
const TRANSIENT_SDK_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
]);

function isTransient(err) {
  if (!err) return false;
  const status = err.status || err.response?.status;
  if (status && TRANSIENT_STATUSES.has(status)) return true;
  if (err.name && TRANSIENT_SDK_NAMES.has(err.name)) return true;
  // Walk the cause chain — undici wraps the OS-level error in `cause`,
  // and the SDK wraps undici. Keep the walk short to avoid cycles.
  let cur = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur.code && TRANSIENT_NETWORK_CODES.has(cur.code)) return true;
    cur = cur.cause;
  }
  return false;
}

export async function withAnthropicRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === RETRY_ATTEMPTS - 1) throw err;
      const wait = RETRY_BACKOFF_MS[attempt] || 5000;
      logger.warn('anthropic transient error; retrying', {
        status: err.status || err.response?.status,
        code: err.code || err.cause?.code,
        name: err.name,
        attempt: attempt + 1,
        wait_ms: wait,
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
