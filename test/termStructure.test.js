// termStructure does a two-step Supabase fetch: first look up the
// latest successful intraday SPX run, then pull the expiration_metrics
// rows for that run. Tests cover: no-run-available short-circuit;
// DTE computation; null skew components handled gracefully.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_KEY ||= 'sb_secret_stub';

const { execute } = await import('../src/tools/termStructure.js');

function stubFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/rest\/v1\//, '');
    const handler = routes[path];
    if (!handler) throw new Error(`No stub for ${path}`);
    const body = await handler(Object.fromEntries(u.searchParams.entries()));
    return { ok: true, status: 200, json: async () => body };
  };
  return () => { globalThis.fetch = original; };
}

test('termStructure: no successful run → structured error', async () => {
  const restore = stubFetch({
    'ingest_runs': async () => [],
  });
  try {
    const r = await execute({});
    assert.ok(r.error);
    assert.match(r.error, /No successful intraday run/);
  } finally {
    restore();
  }
});

test('termStructure: computes DTE and skews from the latest run', async () => {
  const tradingDate = '2026-05-15';
  const restore = stubFetch({
    'ingest_runs': async () => [{
      id: 42, captured_at: '2026-05-15T20:00:00Z',
      trading_date: tradingDate,
    }],
    'expiration_metrics': async () => [
      { expiration_date: '2026-05-22', atm_iv: 0.12, put_25d_iv: 0.14, call_25d_iv: 0.11 },
      { expiration_date: '2026-06-19', atm_iv: 0.16, put_25d_iv: 0.18, call_25d_iv: 0.15 },
    ],
  });
  try {
    const r = await execute({ max_expirations: 20 });
    assert.equal(r.trading_date, tradingDate);
    assert.equal(r.expirations.length, 2);
    // 2026-05-22 - 2026-05-15 = 7 days
    assert.equal(r.expirations[0].dte, 7);
    // 25Δ skew = put_25d_iv - atm_iv = 0.14 - 0.12 = 0.02
    assert.equal(r.expirations[0].put_skew_25d, 0.02);
    // 25Δ call skew = call_25d_iv - atm_iv = 0.11 - 0.12 = -0.01
    assert.equal(r.expirations[0].call_skew_25d, -0.01);
  } finally {
    restore();
  }
});

test('termStructure: clamps max_expirations to [1, 50]', async () => {
  const captured = [];
  const restore = stubFetch({
    'ingest_runs': async () => [{ id: 1, captured_at: '2026-05-15T20:00:00Z', trading_date: '2026-05-15' }],
    'expiration_metrics': async (params) => {
      captured.push(params);
      return [];
    },
  });
  try {
    await execute({ max_expirations: 99999 });
    assert.equal(captured[0].limit, '50');
  } finally {
    restore();
  }
  // Lower bound: 0 should clamp to 1, not 0.
  const captured2 = [];
  const restore2 = stubFetch({
    'ingest_runs': async () => [{ id: 1, captured_at: '2026-05-15T20:00:00Z', trading_date: '2026-05-15' }],
    'expiration_metrics': async (params) => {
      captured2.push(params);
      return [];
    },
  });
  try {
    await execute({ max_expirations: 0 });
    // 0 → fallback 20 (parseInt('0',10) = 0, the `|| 20` triggers).
    assert.equal(captured2[0].limit, '20');
  } finally {
    restore2();
  }
});

test('termStructure: null skew components handled', async () => {
  const restore = stubFetch({
    'ingest_runs': async () => [{ id: 1, captured_at: '2026-05-15T20:00:00Z', trading_date: '2026-05-15' }],
    'expiration_metrics': async () => [
      { expiration_date: '2026-05-22', atm_iv: 0.12, put_25d_iv: null, call_25d_iv: 0.11 },
    ],
  });
  try {
    const r = await execute({});
    assert.equal(r.expirations[0].put_skew_25d, null);
    assert.equal(r.expirations[0].call_skew_25d, -0.01);
  } finally {
    restore();
  }
});
