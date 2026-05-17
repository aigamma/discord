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

test('realizedCorrelations: drops dates with a null close for any basket symbol', async () => {
  // Day-7 has a null close for XLK; that date must not enter the
  // intersection-aligned arrays. Without the intake filter, Number(null)
  // would coerce to 0 and pass `Number.isFinite(row[s])`, then
  // logReturnsFromCloses would emit log(0/X) = -Infinity for that day.
  const rows = [];
  const startMs = Date.now() - 29 * 86400 * 1000;
  for (let d = 0; d < 30; d++) {
    const date = new Date(startMs + d * 86400 * 1000).toISOString().slice(0, 10);
    rows.push({ symbol: 'XLB', trading_date: date, close: 100 + d * 0.5 });
    const xlkClose = d === 7 ? null : 100 + d * 0.3 + Math.sin(d) * 0.4;
    rows.push({ symbol: 'XLK', trading_date: date, close: xlkClose });
  }
  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ symbols: ['XLB', 'XLK'], lookback_days: 30 });
    assert.ok(!r.error, `expected ok result, got ${r.error}`);
    // 29 trading days survive (30 - 1 dropped); returns array is days - 1.
    assert.equal(r.trading_days_used, 28, `expected 28 returns, got ${r.trading_days_used}`);
    // The correlation must be a real number, not null/NaN.
    const pair = r.pairs[0];
    assert.ok(pair.corr != null && Number.isFinite(pair.corr),
      `expected finite corr, got ${pair.corr}`);
  } finally {
    restore();
  }
});

test('realizedCorrelations: caps basket at 30 symbols', async () => {
  // Generate 50 symbols. The pearson cost is O(N^2 * days), and a
  // 50-symbol basket at the 1260-day cap would tie up the agent loop
  // long enough to timeout the Discord interaction. The cap prevents
  // a hostile or hallucinated tool call from doing this.
  const symbols = Array.from({ length: 50 }, (_, i) => `S${i}`);
  let capturedParams;
  const restore = stubFetch(async (_path, params) => {
    capturedParams = params;
    return [];
  });
  try {
    await execute({ symbols, lookback_days: 30 });
    // The IN clause should mention only the first 30 symbols.
    const ins = capturedParams.symbol;
    const listed = ins.match(/S\d+/g) || [];
    assert.equal(listed.length, 30, `expected 30 symbols, got ${listed.length}`);
  } finally {
    restore();
  }
});

test('realizedCorrelations: a constant series produces null corr, not NaN', async () => {
  // Constant close for one symbol means zero variance -> denom = 0 in
  // pearson(). Before the audit fix, the caller's `c != null` check
  // accepted NaN (NaN != null is true) and polluted the running average
  // with NaN forever. Now: pearson returns null, the pair is reported
  // as null, the average is computed from the remaining valid pairs.
  const rows = [];
  const startMs = Date.now() - 29 * 86400 * 1000;
  for (let d = 0; d < 30; d++) {
    const date = new Date(startMs + d * 86400 * 1000).toISOString().slice(0, 10);
    rows.push({ symbol: 'XLB', trading_date: date, close: 100 + d * 0.5 });
    rows.push({ symbol: 'XLK', trading_date: date, close: 100 + d * 0.3 });
    rows.push({ symbol: 'XLF', trading_date: date, close: 100 }); // constant
  }
  const restore = stubFetch(async () => rows);
  try {
    const r = await execute({ symbols: ['XLB', 'XLK', 'XLF'], lookback_days: 30 });
    // Any pair involving XLF should have corr === null (zero variance).
    const xlfPairs = r.pairs.filter((p) => p.a === 'XLF' || p.b === 'XLF');
    assert.ok(xlfPairs.length >= 1);
    for (const p of xlfPairs) {
      assert.equal(p.corr, null, `expected null for ${p.a}-${p.b}, got ${p.corr}`);
    }
    // Average must be a finite number derived from the non-null pairs,
    // never NaN-rendered-as-null.
    assert.ok(Number.isFinite(r.average_pairwise_corr),
      `expected finite avg, got ${r.average_pairwise_corr}`);
  } finally {
    restore();
  }
});
