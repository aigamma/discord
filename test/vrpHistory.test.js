// vrpHistory wires the SPX 30-day IV minus 20-day Yang-Zhang realized
// vol into a percentile-ranked time series. The relevant edge cases:
// rows with null iv/hv must be excluded (Number.isFinite already does
// this since vrpHistory uses strict isFinite, not Number()-coerced),
// percentile rank derived from the filtered series, summary stats over
// the same.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_KEY ||= 'sb_secret_stub';

const { execute } = await import('../src/tools/vrpHistory.js');

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

test('vrpHistory: filters rows missing iv or hv, computes percentile against filtered series', async () => {
  const rows = [];
  // 30 days, VRP climbs from 0.01 to 0.03
  for (let d = 30; d >= 1; d--) {
    const iv = 0.18 + (30 - d) * 0.0007;
    rows.push({
      trading_date: daysAgo(d), spx_close: 5000 + d,
      iv_30d_cm: iv, hv_20d_yz: 0.17,
    });
  }
  // Two malformed rows on the tail: one with null iv, one with null hv.
  rows.push({ trading_date: daysAgo(0), spx_close: 5031, iv_30d_cm: null, hv_20d_yz: 0.17 });
  rows.push({ trading_date: daysAgo(0), spx_close: 5031, iv_30d_cm: 0.20, hv_20d_yz: null });

  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ lookback_days: 252 });
    assert.ok(!r.error, `expected ok, got ${r.error}`);
    // 30 valid + 0 malformed (both filtered)
    assert.equal(r.sample_size, 30);
    // current_vrp is the last valid row's VRP: iv 0.18 + 29*0.0007 = 0.2003, minus 0.17 = 0.0303
    assert.ok(Math.abs(r.current_vrp - (0.18 + 29 * 0.0007 - 0.17)) < 1e-6);
    // percentile rank is max for the climbing series.
    assert.equal(r.percentile_rank, +((29 / 30) * 100).toFixed(1));
    // as_of must be the latest non-null row's date
    assert.equal(r.as_of, daysAgo(1));
  } finally {
    restore();
  }
});

test('vrpHistory: empty result returns structured error', async () => {
  const restore = stubFetch(async () => []);
  try {
    const r = await execute({ lookback_days: 60 });
    assert.ok(r.error);
    assert.match(r.error, /No daily_volatility_stats rows/);
  } finally {
    restore();
  }
});

test('vrpHistory: all-null rows return a different structured error', async () => {
  const rows = [
    { trading_date: daysAgo(2), spx_close: 5000, iv_30d_cm: null, hv_20d_yz: null },
    { trading_date: daysAgo(1), spx_close: 5001, iv_30d_cm: null, hv_20d_yz: null },
  ];
  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ lookback_days: 60 });
    assert.ok(r.error);
    assert.match(r.error, /No rows with both iv_30d_cm and hv_20d_yz populated/);
  } finally {
    restore();
  }
});

test('vrpHistory: negative_vrp_days counts rows where iv < hv', async () => {
  const rows = [
    // 5 negative-VRP days (iv < hv)
    { trading_date: daysAgo(5), spx_close: 5000, iv_30d_cm: 0.15, hv_20d_yz: 0.20 },
    { trading_date: daysAgo(4), spx_close: 5001, iv_30d_cm: 0.16, hv_20d_yz: 0.22 },
    { trading_date: daysAgo(3), spx_close: 5002, iv_30d_cm: 0.14, hv_20d_yz: 0.18 },
    { trading_date: daysAgo(2), spx_close: 5003, iv_30d_cm: 0.13, hv_20d_yz: 0.20 },
    { trading_date: daysAgo(1), spx_close: 5004, iv_30d_cm: 0.12, hv_20d_yz: 0.19 },
    // 1 positive-VRP day
    { trading_date: daysAgo(0), spx_close: 5005, iv_30d_cm: 0.20, hv_20d_yz: 0.15 },
  ];
  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ lookback_days: 30 });
    assert.equal(r.negative_vrp_days, 5);
    assert.ok(r.negative_vrp_share_pct > 80 && r.negative_vrp_share_pct < 84);
  } finally {
    restore();
  }
});
