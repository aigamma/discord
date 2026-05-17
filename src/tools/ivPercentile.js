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
        description: 'How many calendar days of history to rank the current IV against. Defaults to 252 (one trading year). Clamped to [30, 1260]. Use 504 for two years or 1260 for five years if the user wants a longer-baseline rank.',
        default: 252,
      },
    },
    required: [],
  },
};

export async function execute({ lookback_days = 252 } = {}) {
  const days = Math.min(Math.max(parseInt(lookback_days, 10) || 252, 30), 1260);
  const fromDate = new Date(Date.now() - days * 86400 * 1000)
    .toISOString()
    .slice(0, 10);

  const rows = await selectRows('daily_volatility_stats', {
    select: 'trading_date,spx_close,hv_20d_yz,iv_30d_cm',
    trading_date: `gte.${fromDate}`,
    order: 'trading_date.asc',
    limit: '2000',
  });

  // Filter rows down to those with a usable IV reading. Using the
  // unfiltered tail-row would silently produce `iv < null` comparisons
  // (JS coerces null to 0, so the percentile rank would be computed
  // against the constant 0). Latest must come from the filtered series.
  // Note: Number(null) === 0, so the null check must precede Number().
  const ivRows = rows.filter((r) => r.iv_30d_cm != null && Number.isFinite(Number(r.iv_30d_cm)));
  if (ivRows.length === 0) {
    return { error: 'No iv_30d_cm rows in the requested window.' };
  }

  const latest = ivRows[ivRows.length - 1];
  const ivNow = Number(latest.iv_30d_cm);
  const hvNow = latest.hv_20d_yz != null && Number.isFinite(Number(latest.hv_20d_yz))
    ? Number(latest.hv_20d_yz)
    : null;

  const ivSeries = ivRows.map((r) => Number(r.iv_30d_cm));
  const sorted = [...ivSeries].sort((a, b) => a - b);
  const below = sorted.filter((v) => v < ivNow).length;
  const percentile = +((below / sorted.length) * 100).toFixed(1);

  const median = sorted[Math.floor(sorted.length / 2)];

  return {
    as_of: latest.trading_date,
    // ivRows filters on iv_30d_cm only — spx_close can be null on a
    // row that otherwise passed the IV check. Number(null) === 0 was
    // reporting 'SPX closed at 0' on those days.
    spx_close: latest.spx_close != null && Number.isFinite(Number(latest.spx_close))
      ? Number(latest.spx_close)
      : null,
    iv_30d_cm: ivNow,
    hv_20d_yz: hvNow,
    variance_risk_premium: hvNow != null ? +(ivNow - hvNow).toFixed(4) : null,
    percentile_rank: percentile,
    lookback: {
      days,
      sample_size: ivSeries.length,
      min: +sorted[0].toFixed(4),
      median: +median.toFixed(4),
      max: +sorted[sorted.length - 1].toFixed(4),
    },
  };
}
