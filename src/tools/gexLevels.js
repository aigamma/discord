// Current dealer-positioning levels from the latest healthy intraday ingest:
// Vol Flip, Call Wall, Put Wall, P/C ratios. Pulls computed_levels for the
// newest run that has status=success and contract_count > 0, exactly how
// aigamma's data.mjs resolves the same row.

import { selectRows } from '../supabase.js';

export const spec = {
  name: 'get_gex_levels',
  description:
    "Current SPX dealer-positioning levels: volatility_flip (the spot below which dealers go short-gamma — typically the threshold above which the market enters a pinning regime and below which it enters a trending regime), call_wall (highest concentration of OI-weighted gamma above spot — natural resistance from dealer hedging), put_wall (highest concentration below spot — natural support), and put/call ratios by OI and volume. Pulled from the latest 5-minute intraday SPX snapshot during market hours; freezes at last successful run after close. Use when the user asks about gamma levels, dealer positioning, where the market is 'pinned', support/resistance from options flow, or whether dealers are long/short gamma.",
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export async function execute() {
  const runs = await selectRows('ingest_runs', {
    underlying: 'eq.SPX',
    snapshot_type: 'eq.intraday',
    status: 'eq.success',
    contract_count: 'gt.0',
    order: 'captured_at.desc',
    limit: '1',
    select: 'id,captured_at,trading_date,spot_price',
  });
  if (!runs.length) return { error: 'No successful intraday run available.' };
  const run = runs[0];

  const levels = await selectRows('computed_levels', {
    run_id: `eq.${run.id}`,
    select: 'call_wall_strike,put_wall_strike,volatility_flip,put_call_ratio_oi,put_call_ratio_volume,total_call_volume,total_put_volume',
  });

  if (!levels.length) {
    return {
      as_of: run.captured_at,
      spot_price: run.spot_price,
      error: 'Run found but computed_levels missing.',
    };
  }
  const L = levels[0];

  return {
    as_of: run.captured_at,
    trading_date: run.trading_date,
    spot_price: run.spot_price,
    volatility_flip: L.volatility_flip,
    call_wall: L.call_wall_strike,
    put_wall: L.put_wall_strike,
    put_call_ratio_oi: L.put_call_ratio_oi,
    put_call_ratio_volume: L.put_call_ratio_volume,
    total_call_volume: L.total_call_volume,
    total_put_volume: L.total_put_volume,
    regime: run.spot_price != null && L.volatility_flip != null
      ? (run.spot_price >= L.volatility_flip ? 'long_gamma' : 'short_gamma')
      : null,
  };
}
