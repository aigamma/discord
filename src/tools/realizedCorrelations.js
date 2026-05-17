// Pairwise realized correlation matrix across a basket of tickers. Pulls
// daily close from daily_eod, computes log returns, and runs Pearson
// correlation on every pair. Default basket is the eleven SPDR sector ETFs;
// callers can pass any symbol list present in daily_eod.
//
// Returns the symmetric matrix in a compact upper-triangle form so the
// payload stays small even with large baskets, plus the per-symbol sample
// size for transparency on data gaps.

import { selectRows } from '../supabase.js';

const DEFAULT_BASKET = ['XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'];

export const spec = {
  name: 'get_realized_correlations',
  description:
    "Pairwise realized correlation matrix from daily log returns across a basket of tickers over a chosen lookback. Default basket is the eleven SPDR sector ETFs (XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY). Returns the correlation matrix in compact upper-triangle form plus the average pairwise correlation. Use when the user asks about diversification, regime changes in correlation, sector co-movement, or whether a particular pair is cointegrated. For single-stock vs index correlation, include both in the symbols list. The basket is capped at 30 distinct symbols (the rest are silently dropped) and lookback_days is clamped to [7, 1260].",
  input_schema: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ticker symbols to correlate. If omitted, uses the eleven sector ETFs.',
      },
      lookback_days: {
        type: 'integer',
        description: 'Calendar days of history (default 60). Trading days included will be roughly 70% of this.',
        default: 60,
      },
    },
    required: [],
  },
};

function pearson(a, b) {
  if (a.length !== b.length || a.length < 3) return null;
  // Drop pairs where either side is non-finite (a bad close back-propagated
  // as NaN through logReturnsFromCloses). Without this, NaN propagates
  // through every sum and the caller's "is it a number" check (c == null)
  // misses, polluting sumPair/nPair and producing a NaN average that
  // JSON-renders to null but breaks the sort comparator on the pair list.
  let n = 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    sa += a[i]; sb += b[i]; n++;
  }
  if (n < 3) return null;
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const denom = Math.sqrt(da * db);
  if (denom === 0 || !Number.isFinite(denom)) return null;
  const r = num / denom;
  return Number.isFinite(r) ? r : null;
}

function logReturnsFromCloses(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    if (!Number.isFinite(closes[i]) || !Number.isFinite(closes[i - 1]) || closes[i - 1] <= 0) {
      r.push(NaN);
      continue;
    }
    r.push(Math.log(closes[i] / closes[i - 1]));
  }
  return r;
}

export async function execute({ symbols = null, lookback_days = 60 } = {}) {
  // Cap basket at 30 symbols. Pearson is O(basket^2 * days); a 100-symbol
  // basket at 1260 days approaches 50s on the bot's hardware, which
  // would timeout the Discord interaction and tie up the agent loop.
  // 30 is plenty for sector / index / single-name analysis. Dedupe by
  // uppercased symbol first so ['SPY', 'spy'] doesn't burn an
  // ostensibly-distinct slot on the same series.
  const requested = (symbols && symbols.length > 0 ? symbols : DEFAULT_BASKET);
  const seen = new Set();
  const basket = [];
  for (const raw of requested) {
    const s = String(raw).toUpperCase();
    if (seen.has(s)) continue;
    seen.add(s);
    basket.push(s);
    if (basket.length >= 30) break;
  }
  const days = Math.min(Math.max(parseInt(lookback_days, 10) || 60, 7), 1260);
  const fromDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

  // PostgREST `limit` caps total rows, not per-symbol. Allocate one row
  // per calendar day per symbol with a small floor; trading days are <=
  // calendar days so this is enough to fit every symbol's slice without
  // silently truncating the back half of the basket on long lookbacks.
  const rows = await selectRows('daily_eod', {
    symbol: `in.(${basket.join(',')})`,
    trading_date: `gte.${fromDate}`,
    select: 'symbol,trading_date,close',
    order: 'symbol.asc,trading_date.asc',
    limit: String(basket.length * Math.max(days, 120)),
  });

  if (!rows.length) {
    return { error: `No daily_eod rows for basket ${basket.join(',')} in the last ${days} days.` };
  }

  // Group by symbol, build per-symbol close arrays keyed by date for
  // intersection alignment. Skip rows with null/non-positive closes —
  // Number(null) coerces to 0, which is finite and would later produce
  // log(0/X) = -Infinity in the log-return computation. Drop at intake.
  const byDate = {};
  const symbolsWithData = new Set();
  for (const r of rows) {
    if (r.close == null) continue;
    const c = Number(r.close);
    if (!Number.isFinite(c) || c <= 0) continue;
    symbolsWithData.add(r.symbol);
    (byDate[r.trading_date] ||= {})[r.symbol] = c;
  }

  const dates = Object.keys(byDate).sort();
  const aligned = {};
  for (const sym of basket) aligned[sym] = [];
  for (const d of dates) {
    const row = byDate[d];
    // Require every basket symbol to have a positive finite close on
    // this date for the row to enter the aligned arrays; this preserves
    // the intersection-alignment invariant Pearson expects.
    if (basket.every((s) => Number.isFinite(row[s]) && row[s] > 0)) {
      for (const s of basket) aligned[s].push(row[s]);
    }
  }
  const usableDays = aligned[basket[0]].length;
  if (usableDays < 5) {
    return { error: `Only ${usableDays} overlapping trading days for the basket; need at least 5.` };
  }

  const returns = {};
  for (const s of basket) returns[s] = logReturnsFromCloses(aligned[s]);

  const upperTriangle = [];
  let sumPair = 0, nPair = 0;
  for (let i = 0; i < basket.length; i++) {
    for (let j = i + 1; j < basket.length; j++) {
      const c = pearson(returns[basket[i]], returns[basket[j]]);
      // pearson returns null on insufficient data or NaN propagation;
      // Number.isFinite is the load-bearing check (c == null is false
      // for NaN, so a stricter test is needed before pushing into the
      // running average).
      const valid = c !== null && Number.isFinite(c);
      upperTriangle.push({ a: basket[i], b: basket[j], corr: valid ? +c.toFixed(3) : null });
      if (valid) { sumPair += c; nPair++; }
    }
  }
  upperTriangle.sort((a, b) => (b.corr ?? -2) - (a.corr ?? -2));

  return {
    basket,
    lookback_days: days,
    trading_days_used: usableDays - 1,
    average_pairwise_corr: nPair > 0 ? +(sumPair / nPair).toFixed(3) : null,
    pairs: upperTriangle,
    missing_symbols: basket.filter((s) => !symbolsWithData.has(s)),
  };
}
