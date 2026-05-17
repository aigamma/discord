// searchChatHistory: top-level execute() guards. Full end-to-end tests
// require seeding SQLite + stubbing Voyage and pgvector; those happen
// at the integration layer. Here we cover the synchronous guards that
// prevent expensive embed calls when the input is unusable.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
// VOYAGE_API_KEY must be set BEFORE config.js loads or voyageEnabled()
// short-circuits and we never reach the empty-query check.
process.env.VOYAGE_API_KEY ||= 'pa-stub';

const { execute } = await import('../src/tools/searchChatHistory.js');

test('searchChatHistory: empty query → structured error, no fetch', async () => {
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  try {
    const r = await execute({ query: '' });
    assert.ok(r.error);
    assert.match(r.error, /Empty query/);
    assert.equal(fetchCalled, false, 'must not call Voyage for empty query');
  } finally {
    globalThis.fetch = original;
  }
});

test('searchChatHistory: whitespace-only query → structured error', async () => {
  const r = await execute({ query: '   \n  ' });
  assert.ok(r.error);
  assert.match(r.error, /Empty query/);
});

test('searchChatHistory: non-string query → structured error', async () => {
  const r = await execute({ query: 42 });
  assert.ok(r.error);
  assert.match(r.error, /Empty query/);
});

test('searchChatHistory: missing query → structured error', async () => {
  const r = await execute({});
  assert.ok(r.error);
  assert.match(r.error, /Empty query/);
});
