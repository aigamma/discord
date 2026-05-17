// Historical SPX dealer-gamma readings from daily_gex_stats. Lets Sonnet
// answer "when was the last time net gamma was this negative", "how often
// have we seen the call wall step down two days in a row", "what's the
// average call-put gex spread over the last quarter".

import { selectRows } from '../supabase.js';

export const spec = {
  name: 'get_gex_history',
  description:
    "Historical SPX dealer-gamma profile over a chosen lookback window. One row per trading day with the daily call/put GEX totals, the ATM call/put GEX subset, the volatility flip strike, call wall strike, and put wall strike. Use this when the question turns on how today's GEX picture compares to the past, when the user asks 'how often does X happen', or when locating an analogue regime (a prior day with similar net gex / wall placement) would inform the current call. For today's live intraday levels use get_gex_levels instead.",
  input_schema: {
    type: 'object',
    properties: {
      lookback_days: {
        type: 'integer',
        description: 'Calendar days of history to return. Default 60. Clamped to [10, 1260] (five years).',
        default: 60,
      },
    },
    required: [],
  },
};

export async function execute({ lookback_days = 60 } = {}) {
  // Floor at 10 days: a percentile rank computed against a sample of
  // 1 is always 0 (since `v < itself` is false for every row), which
  // would falsely tell the operator 'this is the lowest gamma reading
  // ever' on every query. 10 days is a small but meaningful baseline.
  const days = Math.min(Math.max(parseInt(lookback_days, 10) || 60, 10), 1260);
  const fromDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

  const rows = await selectRows('daily_gex_stats', {
    trading_date: `gte.${fromDate}`,
    select: 'trading_date,spx_close,net_gex,call_gex,put_gex,atm_call_gex,atm_put_gex,vol_flip_strike,call_wall_strike,put_wall_strike',
    order: 'trading_date.asc',
    limit: '2000',
  });

  if (!rows.length) {
    return { error: `No daily_gex_stats rows in the last ${days} days.` };
  }

  // Latest must come from the rows with a usable net_gex value. Using
  // the unfiltered tail when the most recent ingest left net_gex null
  // would silently make latestNetGex = NaN; `v < NaN` is always false,
  // so the percentile rank rendered as 0.0 and looked like 'never been
  // this low' to the model — a serious misread.
  // Number(null) === 0, so a `Number.isFinite(Number(x))` check alone
  // would let null through. Explicit null check first.
  const rowsWithGex = rows.filter((r) => r.net_gex != null && Number.isFinite(Number(r.net_gex)));
  const netGexSeries = rowsWithGex.map((r) => Number(r.net_gex));
  const sorted = [...netGexSeries].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const latest = rowsWithGex.length ? rowsWithGex[rowsWithGex.length - 1] : rows[rows.length - 1];
  const latestNetGex = Number(latest.net_gex);
  const latestGexFinite = Number.isFinite(latestNetGex);
  const below = latestGexFinite ? sorted.filter((v) => v < latestNetGex).length : 0;
  const netGexPercentile = sorted.length && latestGexFinite
    ? +((below / sorted.length) * 100).toFixed(1)
    : null;

  return {
    lookback_days: days,
    sample_size: rows.length,
    as_of: latest.trading_date,
    latest: {
      spx_close: Number(latest.spx_close),
      net_gex: latestNetGex,
      call_gex: Number(latest.call_gex),
      put_gex: Number(latest.put_gex),
      vol_flip_strike: Number(latest.vol_flip_strike),
      call_wall_strike: Number(latest.call_wall_strike),
      put_wall_strike: Number(latest.put_wall_strike),
    },
    net_gex_percentile_rank: netGexPercentile,
    net_gex_summary: sorted.length
      ? {
          min: sorted[0],
          median,
          max: sorted[sorted.length - 1],
        }
      : null,
    series: rows.map((r) => ({
      date: r.trading_date,
      spx_close: Number(r.spx_close),
      net_gex: Number(r.net_gex),
      vol_flip: Number(r.vol_flip_strike),
      call_wall: Number(r.call_wall_strike),
      put_wall: Number(r.put_wall_strike),
    })),
  };
}
