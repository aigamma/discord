// Single-name end-of-day OHLC history. Single-stock or sector ETF queries
// against daily_eod. Sonnet calls this when the conversation turns to a
// specific ticker outside the SPX core.

import { selectRows } from '../supabase.js';

export const spec = {
  name: 'get_stock_history',
  description:
    "Daily end-of-day OHLC and volume for a single ticker (stock or sector ETF) over a lookback window. Returns one row per trading day with trading_date and close. Use when the conversation references a specific name (e.g. NVDA, AAPL, SPY) and the question turns on its recent price action, drawdown, or trend. The coverage is the universe present in the daily_eod table, which is single names and major sector ETFs — not the full Russell 3000.",
  input_schema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Ticker symbol, uppercase. Example: NVDA, AAPL, SPY, QQQ, XLK.',
      },
      lookback_days: {
        type: 'integer',
        description: 'How many calendar days of history to return. Defaults to 60. Hard cap at 1260 (five years).',
        default: 60,
      },
    },
    required: ['symbol'],
  },
};

export async function execute({ symbol, lookback_days = 60 } = {}) {
  if (!symbol || typeof symbol !== 'string') {
    return { error: 'Missing symbol.' };
  }
  const days = Math.min(Math.max(parseInt(lookback_days, 10) || 60, 1), 1260);
  const fromDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

  const rows = await selectRows('daily_eod', {
    symbol: `eq.${symbol.toUpperCase()}`,
    trading_date: `gte.${fromDate}`,
    select: 'trading_date,close',
    order: 'trading_date.asc',
    limit: '2000',
  });

  if (!rows.length) {
    return { error: `No daily_eod rows for ${symbol.toUpperCase()} in the last ${days} days.` };
  }

  const closes = rows.map((r) => Number(r.close)).filter((n) => Number.isFinite(n));
  const latest = closes[closes.length - 1];
  const earliest = closes[0];
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const returnPct = earliest ? +(((latest - earliest) / earliest) * 100).toFixed(2) : null;
  const drawdownFromHigh = max ? +(((latest - max) / max) * 100).toFixed(2) : null;

  return {
    symbol: symbol.toUpperCase(),
    lookback_days: days,
    sample_size: rows.length,
    as_of: rows[rows.length - 1].trading_date,
    latest_close: latest,
    earliest_close: earliest,
    return_pct: returnPct,
    min_close: min,
    max_close: max,
    drawdown_from_high_pct: drawdownFromHigh,
    series: rows.map((r) => ({ date: r.trading_date, close: Number(r.close) })),
  };
}
