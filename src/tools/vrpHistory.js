// Variance risk premium time series. Same daily_volatility_stats table that
// get_iv_percentile reads, but returns the full IV−HV series across the
// lookback so the model can locate today's reading in a longer history,
// flag analogue regimes, and reason about persistence.

import { selectRows } from '../supabase.js';

export const spec = {
  name: 'get_vrp_history',
  description:
    "Variance risk premium time series: SPX 30-day constant-maturity implied volatility minus 20-day Yang-Zhang realized volatility, one row per trading day. Returns the full series over the lookback, summary stats (min, median, max), current percentile rank, and the count of negative-VRP days. Use when the question turns on the persistence of VRP, regime comparisons (was this seen before), the proportion of recent days that ran short-vol, or whether to short premium given the historical context.",
  input_schema: {
    type: 'object',
    properties: {
      lookback_days: {
        type: 'integer',
        description: 'Calendar days of history. Default 252 (one trading year). Clamped to [30, 1260].',
        default: 252,
      },
    },
    required: [],
  },
};

export async function execute({ lookback_days = 252 } = {}) {
  const days = Math.min(Math.max(parseInt(lookback_days, 10) || 252, 30), 1260);
  const fromDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

  const rows = await selectRows('daily_volatility_stats', {
    select: 'trading_date,spx_close,hv_20d_yz,iv_30d_cm',
    trading_date: `gte.${fromDate}`,
    order: 'trading_date.asc',
    limit: '2000',
  });

  if (!rows.length) {
    return { error: `No daily_volatility_stats rows in the last ${days} days.` };
  }

  const series = rows
    .filter((r) => Number.isFinite(r.iv_30d_cm) && Number.isFinite(r.hv_20d_yz))
    .map((r) => ({
      date: r.trading_date,
      // spx_close can be null on rows where iv/hv landed but the
      // close ingest hadn't caught up. Number(null) === 0 would
      // print 'SPX closed at 0' to the model.
      spx_close: r.spx_close != null && Number.isFinite(Number(r.spx_close)) ? Number(r.spx_close) : null,
      iv: Number(r.iv_30d_cm),
      hv: Number(r.hv_20d_yz),
      vrp: +(Number(r.iv_30d_cm) - Number(r.hv_20d_yz)).toFixed(4),
    }));

  if (series.length === 0) {
    return { error: 'No rows with both iv_30d_cm and hv_20d_yz populated.' };
  }

  const vrps = series.map((s) => s.vrp);
  const sorted = [...vrps].sort((a, b) => a - b);
  const current = vrps[vrps.length - 1];
  const below = sorted.filter((v) => v < current).length;
  const negDays = sorted.filter((v) => v < 0).length;
  const median = sorted[Math.floor(sorted.length / 2)];

  return {
    lookback_days: days,
    sample_size: series.length,
    as_of: series[series.length - 1].date,
    current_vrp: current,
    current_iv: series[series.length - 1].iv,
    current_hv: series[series.length - 1].hv,
    percentile_rank: +((below / sorted.length) * 100).toFixed(1),
    summary: {
      min: +sorted[0].toFixed(4),
      median: +median.toFixed(4),
      max: +sorted[sorted.length - 1].toFixed(4),
    },
    negative_vrp_days: negDays,
    negative_vrp_share_pct: +((negDays / series.length) * 100).toFixed(1),
    series,
  };
}
