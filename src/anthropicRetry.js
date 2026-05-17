// Shared Anthropic transient-error retry. Used by agent.answer() and
// summarize() so both paths handle 429/5xx the same way. Status codes
// chosen to match the supabase wrapper plus Anthropic-specific 529
// (overloaded).

import { logger } from './logger.js';

const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 8000];

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

export async function withAnthropicRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const transient = TRANSIENT_STATUSES.has(status);
      if (!transient || attempt === RETRY_ATTEMPTS - 1) throw err;
      const wait = RETRY_BACKOFF_MS[attempt] || 5000;
      logger.warn('anthropic transient error; retrying', { status, attempt: attempt + 1, wait_ms: wait });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
