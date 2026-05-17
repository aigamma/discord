// vixFamily collapses the VIX-family rolling-window query into one
// latest reading per symbol, picks VIX / VVIX / VIX3M out for derived
// ratios (term structure, vol-of-vol), and surfaces them in a flat
// payload. Edge cases pinned: first-occurrence-wins per symbol given
// trading_date.desc sort; derived ratios null when a leg is missing;
// term_structure label depends on the VIX3M/VIX comparison.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_KEY ||= 'sb_secret_stub';

const { execute } = await import('../src/tools/vixFamily.js');

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

test('vixFamily: picks the most recent close per symbol (desc order, first wins)', async () => {
  const restore = stubFetch(async () => [
    // Rows are pre-sorted desc by trading_date as the function expects.
    { symbol: 'VIX', trading_date: '2026-05-16', close: 14.2 },
    { symbol: 'VIX', trading_date: '2026-05-15', close: 14.5 },
    { symbol: 'VVIX', trading_date: '2026-05-16', close: 92.1 },
    { symbol: 'VIX3M', trading_date: '2026-05-16', close: 17.8 },
  ]);
  try {
    const r = await execute();
    assert.equal(r.latest.VIX.close, 14.2);
    assert.equal(r.latest.VIX.trading_date, '2026-05-16');
    assert.equal(r.latest.VVIX.close, 92.1);
    assert.equal(r.latest.VIX3M.close, 17.8);
    assert.equal(r.derived.vvix_vix_ratio, 6.486);
    assert.equal(r.derived.vix3m_vix_ratio, 1.254);
    assert.equal(r.derived.term_structure, 'contango');
    assert.equal(r.as_of, '2026-05-16');
  } finally {
    restore();
  }
});

test('vixFamily: backwardation when VIX3M < VIX', async () => {
  const restore = stubFetch(async () => [
    { symbol: 'VIX', trading_date: '2026-05-16', close: 28.0 },
    { symbol: 'VIX3M', trading_date: '2026-05-16', close: 23.0 },
  ]);
  try {
    const r = await execute();
    assert.equal(r.derived.term_structure, 'backwardation');
  } finally {
    restore();
  }
});

test('vixFamily: derived ratios null when VIX leg missing', async () => {
  const restore = stubFetch(async () => [
    { symbol: 'VVIX', trading_date: '2026-05-16', close: 92.1 },
    { symbol: 'VIX3M', trading_date: '2026-05-16', close: 17.8 },
  ]);
  try {
    const r = await execute();
    assert.equal(r.derived.vvix_vix_ratio, null);
    assert.equal(r.derived.vix3m_vix_ratio, null);
    assert.equal(r.derived.term_structure, null);
    assert.equal(r.as_of, null);
  } finally {
    restore();
  }
});
