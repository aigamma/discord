// realizedCorrelations.execute fans out to Supabase with a `limit` that
// must scale with both basket size AND lookback window — otherwise long
// lookbacks silently truncate the back half of the basket. Stub the
// global `fetch` to capture the URL the tool requested, plus the
// resulting alignment math, without touching the network.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_KEY ||= 'sb_secret_stub';

const { execute } = await import('../src/tools/realizedCorrelations.js');

function rowsForBasket(basket, days) {
  const out = [];
  const startMs = Date.now() - (days - 1) * 86400 * 1000;
  for (let s = 0; s < basket.length; s++) {
    for (let d = 0; d < days; d++) {
      const date = new Date(startMs + d * 86400 * 1000).toISOString().slice(0, 10);
      const shock = (d % 2 === 0) ? 0.5 : -0.3;
      const symDrift = (s + 1) * 0.01;
      out.push({ symbol: basket[s], trading_date: date, close: 100 + d * symDrift + shock });
    }
  }
  return out;
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const params = Object.fromEntries(u.searchParams.entries());
    const body = await handler(u.pathname, params);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };
  return () => { globalThis.fetch = original; };
}

test('realizedCorrelations: limit param scales with days * basket size', async () => {
  const captured = [];
  const restore = stubFetch(async (_path, params) => {
    captured.push(params);
    return rowsForBasket(['XLB', 'XLK'], 40);
  });
  try {
    await execute({ symbols: ['XLB', 'XLK'], lookback_days: 1260 });
    const lim = parseInt(captured[0].limit, 10);
    assert.ok(lim >= 2 * 1260, `limit should scale with days; got ${lim}`);
  } finally {
    restore();
  }
});

test('realizedCorrelations: short lookback still uses a sane floor', async () => {
  const captured = [];
  const restore = stubFetch(async (_path, params) => {
    captured.push(params);
    return rowsForBasket(['XLB', 'XLK', 'XLF'], 30);
  });
  try {
    await execute({ symbols: ['XLB', 'XLK', 'XLF'], lookback_days: 10 });
    const lim = parseInt(captured[0].limit, 10);
    assert.ok(lim >= 3 * 120, `floor should kick in; got ${lim}`);
  } finally {
    restore();
  }
});

test('realizedCorrelations: empty result returns a structured error', async () => {
  const restore = stubFetch(async () => []);
  try {
    const r = await execute({ symbols: ['XLB', 'XLK'], lookback_days: 30 });
    assert.ok(r.error);
    assert.match(r.error, /No daily_eod rows/);
  } finally {
    restore();
  }
});

test('realizedCorrelations: produces an upper-triangle pair list', async () => {
  const restore = stubFetch(async () => rowsForBasket(['XLB', 'XLK', 'XLF'], 30));
  try {
    const r = await execute({ symbols: ['XLB', 'XLK', 'XLF'], lookback_days: 30 });
    assert.equal(r.pairs.length, 3);
    assert.ok(typeof r.average_pairwise_corr === 'number' || r.average_pairwise_corr === null);
    assert.deepEqual(r.missing_symbols, []);
  } finally {
    restore();
  }
});
