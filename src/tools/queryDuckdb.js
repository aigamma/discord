// Read-only DuckDB query tool. The agent uses it to answer questions that
// turn on historical options chains, multi-year index/stock history, or
// derived feature tables computed by the aigamma-backtester nightly job.
//
// The bot only attaches the shards when the backtester puller has produced
// them; until then this tool is not registered.

import { runSelect, isReady, getAttachedShards } from '../duckdb.js';

export const spec = {
  name: 'query_duckdb',
  description: `Run a single read-only SELECT (or WITH ... SELECT) against the aigamma-backtester DuckDB shards. Use this for questions that turn on multi-year historical data, full-chain option queries, or pre-computed daily feature tables. Results are capped at 1000 rows; add LIMIT explicitly to keep payload tight.

Schemas (shard.table):

option_chains.option_chains_eod
  date DATE, symbol VARCHAR, expiration DATE, "right" VARCHAR ('call'|'put'),
  strike DECIMAL, open/high/low/close DOUBLE, volume BIGINT, open_interest BIGINT,
  bid/ask DOUBLE, bid_size/ask_size BIGINT, last_trade TIMESTAMP

index_history.index_history_eod
  date DATE, symbol VARCHAR, open/high/low/close DOUBLE

stocks_history.stocks_history_eod
  date DATE, symbol VARCHAR, open/high/low/close DOUBLE, volume BIGINT

derived.daily_indicators
  per-symbol rolling SMAs, RSI, percentile ranks, MA flags (schema settling)

derived.daily_regime
  per-day regime labels: negative-gamma flag, term-structure inversion flag, VRP regime

derived.daily_term_structure
  per-day 30/60/90/180 ATM IV points and slope

derived.daily_gex
  approximate dealer GEX, vol-flip strike

derived.daily_atm_iv
  per-symbol ATM IV at standard tenors

Curated symbol coverage (lazy-pulled outside this list):
  SPX, SPXW (option chains)
  SPX, VIX (indices)
  SPY, QQQ, IWM, DIA, XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLU, XLV, XLY, XLRE (sector ETFs)
  top-11 options-volume single names

Guardrails: SELECT/WITH only, single-statement only, 30-second timeout, 1000-row cap. The bot rejects INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, ATTACH, DETACH, PRAGMA, COPY, EXPORT, IMPORT, TRUNCATE, GRANT, REVOKE, and SET. The connection has external filesystem access disabled, so DuckDB's file-reading table functions (read_csv, read_parquet, read_json, read_text, read_blob, glob, parquet_scan/metadata, load_extension) are refused — only the attached shards are queryable.`,
  input_schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'A single SELECT or WITH ... SELECT statement. Quote table names with the shard prefix, e.g. option_chains.option_chains_eod.',
      },
    },
    required: ['sql'],
  },
};

export async function execute({ sql } = {}) {
  if (!isReady()) {
    return { error: 'DuckDB shards are not currently loaded.' };
  }
  if (!sql) return { error: 'Missing sql.' };
  try {
    const t0 = Date.now();
    const out = await runSelect(sql);
    return {
      ...out,
      latency_ms: Date.now() - t0,
      attached_shards: getAttachedShards().map((s) => s.name),
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}
