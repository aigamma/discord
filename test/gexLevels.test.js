// gexLevels: latest intraday SPX run lookup, then computed_levels for
// that run. Surfaces vol-flip, call wall, put wall, and a long/short
// gamma regime label derived from spot vs vol_flip.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_KEY ||= 'sb_secret_stub';

const { execute } = await import('../src/tools/gexLevels.js');

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

test('gexLevels: no successful run → structured error', async () => {
  const restore = stubFetch({ 'ingest_runs': async () => [] });
  try {
    const r = await execute();
    assert.ok(r.error);
    assert.match(r.error, /No successful intraday run/);
  } finally {
    restore();
  }
});

test('gexLevels: spot above vol_flip yields long_gamma regime', async () => {
  const restore = stubFetch({
    'ingest_runs': async () => [{
      id: 1, captured_at: '2026-05-15T18:00:00Z',
      trading_date: '2026-05-15', spot_price: 5100,
    }],
    'computed_levels': async () => [{
      call_wall_strike: 5200, put_wall_strike: 4900,
      volatility_flip: 5050,
      put_call_ratio_oi: 1.3, put_call_ratio_volume: 1.1,
      total_call_volume: 1000000, total_put_volume: 1200000,
    }],
  });
  try {
    const r = await execute();
    assert.equal(r.spot_price, 5100);
    assert.equal(r.volatility_flip, 5050);
    assert.equal(r.regime, 'long_gamma');
  } finally {
    restore();
  }
});

test('gexLevels: spot below vol_flip yields short_gamma regime', async () => {
  const restore = stubFetch({
    'ingest_runs': async () => [{
      id: 1, captured_at: '2026-05-15T18:00:00Z',
      trading_date: '2026-05-15', spot_price: 5020,
    }],
    'computed_levels': async () => [{
      call_wall_strike: 5200, put_wall_strike: 4900,
      volatility_flip: 5050,
      put_call_ratio_oi: 1.3, put_call_ratio_volume: 1.1,
      total_call_volume: 1000000, total_put_volume: 1200000,
    }],
  });
  try {
    const r = await execute();
    assert.equal(r.regime, 'short_gamma');
  } finally {
    restore();
  }
});

test('gexLevels: regime null when either side missing', async () => {
  const restore = stubFetch({
    'ingest_runs': async () => [{
      id: 1, captured_at: '2026-05-15T18:00:00Z',
      trading_date: '2026-05-15', spot_price: null,
    }],
    'computed_levels': async () => [{
      call_wall_strike: 5200, put_wall_strike: 4900,
      volatility_flip: 5050,
      put_call_ratio_oi: 1.3, put_call_ratio_volume: 1.1,
      total_call_volume: 1000000, total_put_volume: 1200000,
    }],
  });
  try {
    const r = await execute();
    assert.equal(r.regime, null);
  } finally {
    restore();
  }
});

test('gexLevels: missing computed_levels row → structured error path', async () => {
  const restore = stubFetch({
    'ingest_runs': async () => [{
      id: 1, captured_at: '2026-05-15T18:00:00Z',
      trading_date: '2026-05-15', spot_price: 5100,
    }],
    'computed_levels': async () => [],
  });
  try {
    const r = await execute();
    assert.ok(r.error);
    assert.match(r.error, /computed_levels missing/);
  } finally {
    restore();
  }
});
