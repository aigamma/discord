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

test('withAnthropicRetry: 529 (overloaded) is retried up to 3 times', async (t) => {
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
