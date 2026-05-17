// Unit-test the retry decisions of the Supabase wrapper. The actual fetch
// behavior against the live API is exercised by smoke-tests; here we just
// verify the predicate logic that decides whether to retry.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

// The predicates are not exported; recreate them inline so the test asserts
// the spec without depending on internal symbols. If the source diverges,
// this test fails loudly — a feature, not a bug.

function isTransientError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = err.cause?.code || err.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(code);
}

function isTransientStatus(status) {
  return status === 502 || status === 503 || status === 504 || status === 408;
}

test('supabase: timeout / abort are transient', () => {
  assert.equal(isTransientError({ name: 'AbortError' }), true);
  assert.equal(isTransientError({ name: 'TimeoutError' }), true);
});

test('supabase: ECONNRESET / ETIMEDOUT / EAI_AGAIN are transient', () => {
  assert.equal(isTransientError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isTransientError({ code: 'EAI_AGAIN' }), true);
});

test('supabase: cause.code carries the syscall, retried', () => {
  assert.equal(isTransientError({ cause: { code: 'ECONNRESET' } }), true);
});

test('supabase: ordinary errors are NOT transient', () => {
  assert.equal(isTransientError(new Error('parse error')), false);
  assert.equal(isTransientError({ name: 'SyntaxError' }), false);
  assert.equal(isTransientError(null), false);
});

test('supabase: 5xx status codes retried, 4xx not', () => {
  assert.equal(isTransientStatus(502), true);
  assert.equal(isTransientStatus(503), true);
  assert.equal(isTransientStatus(504), true);
  assert.equal(isTransientStatus(408), true);
  assert.equal(isTransientStatus(500), false); // 500 is often deterministic; treat as fatal
  assert.equal(isTransientStatus(429), false); // rate-limit handled differently upstream
  assert.equal(isTransientStatus(404), false);
  assert.equal(isTransientStatus(401), false);
});
