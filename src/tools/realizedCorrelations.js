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
    "Pairwise realized correlation matrix from daily log returns across a basket of tickers over a chosen lookback. Default basket is the eleven SPDR sector ETFs (XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY). Returns the correlation matrix in compact upper-triangle form plus the average pairwise correlation. Use when the user asks about diversification, regime changes in correlation, sector co-movement, or whether a particular pair is cointegrated. For single-stock vs index correlation, include both in the symbols list.",
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
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? null : num / denom;
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
  const basket = (symbols && symbols.length > 0 ? symbols : DEFAULT_BASKET).map((s) => s.toUpperCase());
  const days = Math.min(Math.max(parseInt(lookback_days, 10) || 60, 7), 1260);
  const fromDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

  const rows = await selectRows('daily_eod', {
    symbol: `in.(${basket.join(',')})`,
    trading_date: `gte.${fromDate}`,
    select: 'symbol,trading_date,close',
    order: 'symbol.asc,trading_date.asc',
    limit: String(basket.length * 400),
  });

  if (!rows.length) {
    return { error: `No daily_eod rows for basket ${basket.join(',')} in the last ${days} days.` };
  }

  // Group by symbol, build per-symbol close arrays keyed by date for
  // intersection alignment.
  const byDate = {};
  const symbolsWithData = new Set();
  for (const r of rows) {
    symbolsWithData.add(r.symbol);
    (byDate[r.trading_date] ||= {})[r.symbol] = Number(r.close);
  }

  const dates = Object.keys(byDate).sort();
  const aligned = {};
  for (const sym of basket) aligned[sym] = [];
  for (const d of dates) {
    const row = byDate[d];
    if (basket.every((s) => Number.isFinite(row[s]))) {
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
      upperTriangle.push({ a: basket[i], b: basket[j], corr: c == null ? null : +c.toFixed(3) });
      if (c != null) { sumPair += c; nPair++; }
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
