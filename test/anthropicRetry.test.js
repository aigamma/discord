// withAnthropicRetry: shared between agent.answer() and summarize().
// Retries on 408/429/500/502/503/504/529, gives up on anything else,
// caps at 3 attempts.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const { withAnthropicRetry } = await import('../src/anthropicRetry.js');

function makeErr(status) {
  const e = new Error(`status ${status}`);
  e.status = status;
  return e;
}

test('withAnthropicRetry: success on first attempt returns immediately', async () => {
  let calls = 0;
  const result = await withAnthropicRetry(async () => {
    calls++;
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(calls, 1);
});

test('withAnthropicRetry: 529 (overloaded) is retried up to 3 times', async () => {
  // Override setTimeout to skip the actual sleep
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  try {
    await assert.rejects(
      () => withAnthropicRetry(async () => { calls++; throw makeErr(529); }),
      /status 529/
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(calls, 3, 'should attempt exactly 3 times');
});

test('withAnthropicRetry: 401 (auth) is not retried', async () => {
  let calls = 0;
  await assert.rejects(
    () => withAnthropicRetry(async () => { calls++; throw makeErr(401); }),
    /status 401/
  );
  assert.equal(calls, 1, 'auth error must not retry');
});

test('withAnthropicRetry: 400 (bad request) is not retried', async () => {
  let calls = 0;
  await assert.rejects(
    () => withAnthropicRetry(async () => { calls++; throw makeErr(400); }),
    /status 400/
  );
  assert.equal(calls, 1);
});

test('withAnthropicRetry: succeeds on second attempt after one 503', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  try {
    const r = await withAnthropicRetry(async () => {
      calls++;
      if (calls === 1) throw makeErr(503);
      return 'ok';
    });
    assert.equal(r, 'ok');
    assert.equal(calls, 2);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('withAnthropicRetry: each retried status in the allow-list triggers retry', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  try {
    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
      let calls = 0;
      await assert.rejects(
        () => withAnthropicRetry(async () => { calls++; throw makeErr(status); }),
        new RegExp(`status ${status}`)
      );
      assert.equal(calls, 3, `status ${status} should retry up to 3 times`);
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('withAnthropicRetry: non-status thrown error is not retried', async () => {
  let calls = 0;
  await assert.rejects(
    () => withAnthropicRetry(async () => { calls++; throw new Error('parse error'); }),
    /parse error/
  );
  assert.equal(calls, 1);
});

test('withAnthropicRetry: ECONNRESET is retried', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  try {
    await assert.rejects(
      () => withAnthropicRetry(async () => {
        calls++;
        const e = new Error('socket hang up');
        e.code = 'ECONNRESET';
        throw e;
      }),
      /socket hang up/
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(calls, 3, 'ECONNRESET should retry up to 3 times');
});

test('withAnthropicRetry: undici fetch failed with cause.code is retried', async () => {
  // The Anthropic SDK wraps undici, which wraps the OS error in
  // err.cause.code. Mirror that shape.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  try {
    await assert.rejects(
      () => withAnthropicRetry(async () => {
        calls++;
        const inner = new Error('connect ETIMEDOUT');
        inner.code = 'ETIMEDOUT';
        const outer = new Error('fetch failed');
        outer.cause = inner;
        throw outer;
      }),
      /fetch failed/
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(calls, 3, 'cause.code ETIMEDOUT should retry');
});

test('withAnthropicRetry: APIConnectionError (by name) is retried', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  try {
    await assert.rejects(
      () => withAnthropicRetry(async () => {
        calls++;
        const e = new Error('connection error');
        e.name = 'APIConnectionError';
        throw e;
      }),
      /connection error/
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(calls, 3);
});

test('withAnthropicRetry: APIConnectionTimeoutError is retried', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  try {
    await assert.rejects(
      () => withAnthropicRetry(async () => {
        calls++;
        const e = new Error('request timed out');
        e.name = 'APIConnectionTimeoutError';
        throw e;
      }),
      /request timed out/
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(calls, 3);
});

test('withAnthropicRetry: arbitrary err.code (not in the network list) is not retried', async () => {
  let calls = 0;
  await assert.rejects(
    () => withAnthropicRetry(async () => {
      calls++;
      const e = new Error('something else');
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }),
    /something else/
  );
  assert.equal(calls, 1);
});
