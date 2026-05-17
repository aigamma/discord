// gexHistory must NOT compute percentile rank against a null tail-row
// net_gex. `v < null` coerces to `v < 0`, which made the bot report
// percentile 0 ("never been this low") for any positive net_gex when
// the most recent daily_gex_stats ingest was incomplete — a real
// misread that traders could trade on.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_KEY ||= 'sb_secret_stub';

const { execute } = await import('../src/tools/gexHistory.js');

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

function gexRow(date, netGex, extras = {}) {
  return {
    trading_date: date,
    spx_close: 5000,
    net_gex: netGex,
    call_gex: extras.call_gex ?? 1e9,
    put_gex: extras.put_gex ?? -5e8,
    atm_call_gex: 1e8,
    atm_put_gex: -5e7,
    vol_flip_strike: extras.vol_flip_strike ?? 4900,
    call_wall_strike: extras.call_wall_strike ?? 5100,
    put_wall_strike: extras.put_wall_strike ?? 4800,
  };
}

test('gexHistory: percentile_rank derived from rows with usable net_gex', async () => {
  const rows = [];
  // Climbing series 0 -> 100 over 60 days
  for (let d = 60; d >= 1; d--) {
    rows.push(gexRow(daysAgo(d), 60 - d));
  }
  // Tail row with null net_gex
  rows.push(gexRow(daysAgo(0), null));

  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ lookback_days: 60 });
    // Latest with a usable net_gex is the day -1 row: 60 - 1 = 59
    assert.equal(r.latest.net_gex, 59);
    // Percentile must be the rank of 59 in the [0..59] series:
    // count of values < 59 is 59 (everything except itself), out of 60.
    // 59/60 * 100 = 98.3
    assert.ok(r.net_gex_percentile_rank >= 98 && r.net_gex_percentile_rank <= 99,
      `expected ~98.3, got ${r.net_gex_percentile_rank}`);
    // as_of must be the day -1 date.
    assert.equal(r.as_of, daysAgo(1));
  } finally {
    restore();
  }
});

test('gexHistory: percentile_rank null when no usable net_gex anywhere', async () => {
  const rows = [
    gexRow(daysAgo(2), null),
    gexRow(daysAgo(1), null),
  ];
  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ lookback_days: 60 });
    assert.equal(r.net_gex_percentile_rank, null);
    assert.equal(r.net_gex_summary, null);
  } finally {
    restore();
  }
});

test('gexHistory: empty result returns structured error', async () => {
  const restore = stubFetch(async () => []);
  try {
    const r = await execute({ lookback_days: 30 });
    assert.ok(r.error);
    assert.match(r.error, /No daily_gex_stats rows/);
  } finally {
    restore();
  }
});
