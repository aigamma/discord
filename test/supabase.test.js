// Unit-test the retry decisions of the Supabase wrapper. The actual fetch
// behavior against the live API is exercised by smoke-tests; here we just
// verify the predicate logic that decides whether to retry.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

// Import the actual predicates from the source so any future change to
// the retry policy automatically reaches CI (a previous version of this
// file mirrored the predicates inline and silently drifted).
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_KEY ||= 'sb_secret_stub';

const { isTransientError, isTransientStatus } = await import('../src/supabase.js');

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

// Integration: stub global fetch and assert the retry loop in
// selectRows attempts twice on a transient status and returns the
// second attempt's success, and gives up after two attempts on a
// fatal status.

const { selectRows } = await import('../src/supabase.js');

function captureFetch(handlers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const handler = handlers[calls.length] || handlers[handlers.length - 1];
    calls.push(url);
    return await handler();
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('supabase: 503 retried once, second attempt succeeds', async () => {
  const cap = captureFetch([
    async () => ({ ok: false, status: 503, text: async () => 'overloaded' }),
    async () => ({ ok: true, status: 200, json: async () => [{ id: 1 }] }),
  ]);
  try {
    const rows = await selectRows('test_table', { select: '*' });
    assert.equal(cap.calls.length, 2, 'should retry once');
    assert.deepEqual(rows, [{ id: 1 }]);
  } finally {
    cap.restore();
  }
});

test('supabase: 500 (deterministic) NOT retried', async () => {
  const cap = captureFetch([
    async () => ({ ok: false, status: 500, text: async () => 'server error' }),
  ]);
  try {
    await assert.rejects(
      () => selectRows('test_table', { select: '*' }),
      /HTTP 500/
    );
    assert.equal(cap.calls.length, 1, 'must NOT retry on 500');
  } finally {
    cap.restore();
  }
});

test('supabase: ECONNRESET retried, second attempt succeeds', async () => {
  const cap = captureFetch([
    async () => { const e = new Error('reset'); e.code = 'ECONNRESET'; throw e; },
    async () => ({ ok: true, status: 200, json: async () => [] }),
  ]);
  try {
    const rows = await selectRows('test_table', { select: '*' });
    assert.equal(cap.calls.length, 2);
    assert.deepEqual(rows, []);
  } finally {
    cap.restore();
  }
});
