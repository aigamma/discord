// stockHistory must NOT treat a null close on the tail row as 0. The
// previous filter `Number.isFinite(Number(r.close))` accepted null
// because Number(null) === 0, so latest_close, min_close, and the
// series entry for that day all rendered as 0 — disastrous for any
// downstream price calculation.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_KEY ||= 'sb_secret_stub';

const { execute } = await import('../src/tools/stockHistory.js');

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

test('stockHistory: null tail row does NOT render as latest_close 0', async () => {
  const rows = [];
  for (let d = 30; d >= 1; d--) {
    rows.push({ trading_date: daysAgo(d), close: 100 + (30 - d) * 1.5 });
  }
  // Tail row missing close (ingest gap).
  rows.push({ trading_date: daysAgo(0), close: null });

  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ symbol: 'NVDA', lookback_days: 60 });
    assert.ok(!r.error, `expected ok, got ${r.error}`);
    // The latest valid close is the day -1 row, with close = 100 + 29*1.5 = 143.5
    assert.equal(r.latest_close, 100 + 29 * 1.5);
    // as_of must reflect that row's date, NOT today's null row.
    assert.equal(r.as_of, daysAgo(1));
    // min_close must be the actual minimum (100), not zero.
    assert.equal(r.min_close, 100);
    // series should NOT contain the null row.
    assert.equal(r.series.length, 30);
    for (const s of r.series) {
      assert.ok(Number.isFinite(s.close) && s.close > 0,
        `series should drop null rows; found ${JSON.stringify(s)}`);
    }
  } finally {
    restore();
  }
});

test('stockHistory: returns structured error when ALL closes are null', async () => {
  const rows = [
    { trading_date: daysAgo(2), close: null },
    { trading_date: daysAgo(1), close: null },
  ];
  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ symbol: 'NVDA', lookback_days: 60 });
    assert.ok(r.error);
    assert.match(r.error, /No usable close prices/);
  } finally {
    restore();
  }
});

test('stockHistory: rejects empty symbol', async () => {
  const r = await execute({ symbol: '', lookback_days: 60 });
  assert.ok(r.error);
  assert.match(r.error, /Missing symbol/);
});

test('stockHistory: clamps lookback_days', async () => {
  const captured = [];
  const restore = stubFetch(async (_path, params) => {
    captured.push(params);
    return [{ trading_date: daysAgo(1), close: 50 }, { trading_date: daysAgo(0), close: 51 }];
  });
  try {
    const r = await execute({ symbol: 'AAPL', lookback_days: 999999 });
    assert.equal(r.lookback_days, 1260, 'should clamp to 5y');
  } finally {
    restore();
  }
});
