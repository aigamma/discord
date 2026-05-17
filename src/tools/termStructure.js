// Per-expiration ATM IV, 25-delta put IV, 25-delta call IV across the SPX
// chain — the volatility surface in its term-structure projection. Lets the
// model answer "is the front-month bid up?", "where's the smile steepest?",
// "is the 25Δ put skew elevated for [some DTE]?".

import { selectRows } from '../supabase.js';

export const spec = {
  name: 'get_spx_term_structure',
  description:
    "SPX volatility term structure: for every listed expiration in the latest intraday run, returns ATM implied vol, 25-delta put IV, and 25-delta call IV. Use this when the user asks about the IV curve across expirations, skew at a specific DTE, front-month vs back-month bid, calendar spreads, or the put-skew shape. Each row also includes the implied days-to-expiration (DTE) computed from the run's trading date.",
  input_schema: {
    type: 'object',
    properties: {
      max_expirations: {
        type: 'integer',
        description: 'Cap on the number of expirations to include (sorted from nearest to furthest). Defaults to 20; clamped to [1, 50].',
        default: 20,
      },
    },
    required: [],
  },
};

function daysBetween(fromIsoDate, toIsoDate) {
  const a = Date.parse(fromIsoDate + 'T00:00:00Z');
  const b = Date.parse(toIsoDate + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

export async function execute({ max_expirations = 20 } = {}) {
  // Clamp before passing to PostgREST so a model passing 99999 doesn't
  // try to slam every expiration into one response. SPX typically has
  // ~30 listed expirations on any given day; capping at 50 leaves
  // headroom for special expirations without blowing the tool result.
  const cap = Math.min(Math.max(parseInt(max_expirations, 10) || 20, 1), 50);
  const runs = await selectRows('ingest_runs', {
    underlying: 'eq.SPX',
    snapshot_type: 'eq.intraday',
    status: 'eq.success',
    contract_count: 'gt.0',
    order: 'captured_at.desc',
    limit: '1',
    select: 'id,captured_at,trading_date',
  });
  if (!runs.length) return { error: 'No successful intraday run available.' };
  const run = runs[0];

  const rows = await selectRows('expiration_metrics', {
    run_id: `eq.${run.id}`,
    select: 'expiration_date,atm_iv,put_25d_iv,call_25d_iv',
    order: 'expiration_date.asc',
    limit: String(cap),
  });

  const expirations = rows.map((r) => ({
    expiration_date: r.expiration_date,
    dte: daysBetween(run.trading_date, r.expiration_date),
    atm_iv: r.atm_iv,
    put_25d_iv: r.put_25d_iv,
    call_25d_iv: r.call_25d_iv,
    put_skew_25d: r.atm_iv != null && r.put_25d_iv != null
      ? +(r.put_25d_iv - r.atm_iv).toFixed(4)
      : null,
    call_skew_25d: r.atm_iv != null && r.call_25d_iv != null
      ? +(r.call_25d_iv - r.atm_iv).toFixed(4)
      : null,
  }));

  return {
    as_of: run.captured_at,
    trading_date: run.trading_date,
    expirations,
  };
}
