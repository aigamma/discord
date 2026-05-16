// Latest readings across the VIX family + cross-asset vol indices. The model
// uses this to answer "what is VVIX:VIX right now?", "is the term structure
// in contango or backwardation?", "what does the tail-cost (TDEX) say?", etc.
//
// Schema mirrors aigamma's vix_family_eod (close-only EOD; daily refresh).

import { selectRows } from '../supabase.js';

const SYMBOLS = [
  'VIX', 'VIX1D', 'VIX9D', 'VIX3M', 'VIX6M', 'VIX1Y',
  'VVIX', 'VXN', 'RVX', 'OVX', 'GVZ',
  'SDEX', 'TDEX',
  'BXM', 'BXMD', 'BFLY', 'CNDR',
];

export const spec = {
  name: 'get_vix_family_latest',
  description:
    'Get the latest end-of-day close for every symbol in the VIX family (VIX, VIX1D/9D/3M/6M/1Y for term structure, VVIX for vol-of-vol, VXN/RVX/OVX/GVZ for cross-asset vol, SDEX/TDEX for skew/tail-cost). Returns one row per symbol with trading_date and close. Computes the VVIX:VIX ratio and the VIX3M:VIX term slope (contango if > 1, backwardation if < 1). EOD data — updated once per trading day after close. Use when the user asks about current volatility levels, term structure shape, cross-asset vol comparison, or vol-of-vol regimes.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export async function execute() {
  const rows = await selectRows('vix_family_eod', {
    symbol: `in.(${SYMBOLS.join(',')})`,
    select: 'symbol,trading_date,close',
    order: 'trading_date.desc',
    limit: '200',
  });

  const latest = {};
  for (const r of rows) {
    if (!latest[r.symbol]) {
      latest[r.symbol] = { trading_date: r.trading_date, close: r.close };
    }
  }

  const vix = latest.VIX?.close;
  const vvix = latest.VVIX?.close;
  const vix3m = latest.VIX3M?.close;

  const derived = {
    vvix_vix_ratio: vix && vvix ? +(vvix / vix).toFixed(3) : null,
    vix3m_vix_ratio: vix && vix3m ? +(vix3m / vix).toFixed(3) : null,
    term_structure: vix && vix3m
      ? (vix3m > vix ? 'contango' : 'backwardation')
      : null,
  };

  return { latest, derived, as_of: latest.VIX?.trading_date ?? null };
}
