// SPX 30-day constant-maturity IV vs trailing realized vol (Yang-Zhang). Used
// to answer "what's IV rank?", "is realized > implied right now?", "what's
// the variance risk premium?".
//
// daily_volatility_stats holds one row per trading day with spx_close,
// hv_20d_yz (20-day Yang-Zhang realized), and iv_30d_cm (30-day constant-
// maturity ATM IV). Percentile rank is computed over the requested lookback
// window — model decides whether to ask for 1y, 2y, or 5y.

import { selectRows } from '../supabase.js';

export const spec = {
  name: 'get_iv_percentile',
  description:
    "SPX 30-day constant-maturity IV and 20-day Yang-Zhang realized vol with percentile rank over a chosen lookback. Returns: latest iv_30d_cm, latest hv_20d_yz, the variance risk premium (iv - hv), the percentile rank of the latest IV against the lookback window, and summary statistics (min / median / max) over that window. Use when the user asks 'is IV rich or cheap?', 'what's IV rank?', 'how does today's IV compare to history?', or 'is realized leading implied?'.",
  input_schema: {
    type: 'object',
    properties: {
      lookback_days: {
        type: 'integer',
        description: 'How many calendar days of history to rank the current IV against. Defaults to 252 (one trading year). Use 504 for two years or 1260 for five years if the user wants a longer-baseline rank.',
        default: 252,
      },
    },
    required: [],
  },
};

export async function execute({ lookback_days = 252 } = {}) {
  const fromDate = new Date(Date.now() - lookback_days * 86400 * 1000)
    .toISOString()
    .slice(0, 10);

  const rows = await selectRows('daily_volatility_stats', {
    select: 'trading_date,spx_close,hv_20d_yz,iv_30d_cm',
    trading_date: `gte.${fromDate}`,
    order: 'trading_date.asc',
    limit: '2000',
  });

  const ivSeries = rows.map((r) => r.iv_30d_cm).filter((v) => v != null);
  if (ivSeries.length === 0) {
    return { error: 'No iv_30d_cm rows in the requested window.' };
  }

  const latest = rows[rows.length - 1];
  const ivNow = latest.iv_30d_cm;
  const hvNow = latest.hv_20d_yz;

  const sorted = [...ivSeries].sort((a, b) => a - b);
  const below = sorted.filter((v) => v < ivNow).length;
  const percentile = +((below / sorted.length) * 100).toFixed(1);

  const median = sorted[Math.floor(sorted.length / 2)];

  return {
    as_of: latest.trading_date,
    spx_close: latest.spx_close,
    iv_30d_cm: ivNow,
    hv_20d_yz: hvNow,
    variance_risk_premium: ivNow != null && hvNow != null ? +(ivNow - hvNow).toFixed(4) : null,
    percentile_rank: percentile,
    lookback: {
      days: lookback_days,
      sample_size: ivSeries.length,
      min: +sorted[0].toFixed(4),
      median: +median.toFixed(4),
      max: +sorted[sorted.length - 1].toFixed(4),
    },
  };
}
