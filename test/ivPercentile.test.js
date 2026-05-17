// ivPercentile must derive 'latest' from rows with a usable iv_30d_cm
// reading, NOT from the literal last row. A null on the tail (partial
// daily ingest) used to make the percentile-rank comparator do `v < null`,
// which JS coerces to `v < 0`. With IV always positive, the bot reported
// percentile 0 (interpretable as 'never been this low') in those cases.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_KEY ||= 'sb_secret_stub';

const { execute } = await import('../src/tools/ivPercentile.js');

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const params = Object.fromEntries(u.searchParams.entries());
    const body = await handler(u.pathname, params);
    return { ok: true, status: 200, json: async () => body };
  };
  return () => { globalThis.fetch = original; };
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400 * 1000).toISOString().slice(0, 10);
}

test('ivPercentile: null tail row falls back to the latest non-null IV', async () => {
  // 30 days of IV climbing 15 -> 22; final row has null IV (ingest gap).
  const rows = [];
  for (let d = 30; d >= 1; d--) {
    rows.push({
      trading_date: daysAgo(d),
      spx_close: 5000 + d,
      hv_20d_yz: 0.18,
      iv_30d_cm: 0.15 + (30 - d) * 0.0025, // 0.15 -> 0.2225
    });
  }
  rows.push({
    trading_date: daysAgo(0),
    spx_close: 5031,
    hv_20d_yz: 0.18,
    iv_30d_cm: null,
  });
  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ lookback_days: 252 });
    assert.ok(!r.error, `expected ok result, got ${r.error}`);
    // Latest must be the second-to-last row, which had iv 0.2225.
    assert.ok(Math.abs(r.iv_30d_cm - 0.2225) < 1e-9, `got ${r.iv_30d_cm}`);
    // That value is the maximum of the lookback -> 100th percentile.
    assert.equal(r.percentile_rank, +((29 / 30) * 100).toFixed(1));
  } finally {
    restore();
  }
});

test('ivPercentile: clamps absurd lookback_days', async () => {
  const captured = [];
  const restore = stubFetch(async (_path, params) => {
    captured.push(params);
    return [
      { trading_date: daysAgo(1), spx_close: 5000, hv_20d_yz: 0.18, iv_30d_cm: 0.2 },
      { trading_date: daysAgo(0), spx_close: 5001, hv_20d_yz: 0.18, iv_30d_cm: 0.21 },
    ];
  });
  try {
    const r = await execute({ lookback_days: 9999999 });
    assert.equal(r.lookback.days, 1260, 'should clamp to 1260');
  } finally {
    restore();
  }
});

test('ivPercentile: rejects when no usable IV rows in the window', async () => {
  const restore = stubFetch(async () => [
    { trading_date: daysAgo(2), spx_close: 5000, hv_20d_yz: 0.18, iv_30d_cm: null },
    { trading_date: daysAgo(1), spx_close: 5001, hv_20d_yz: 0.18, iv_30d_cm: null },
  ]);
  try {
    const r = await execute({ lookback_days: 60 });
    assert.ok(r.error, 'expected error result');
    assert.match(r.error, /No iv_30d_cm rows/);
  } finally {
    restore();
  }
});
