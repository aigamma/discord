# Tool Catalog Reference

Single source of truth for every model-callable tool the bot exposes via
Anthropic tool use. Mirrors `src/tools/index.js` (the registry and gating) and
the per-tool source files (`src/tools/*.js`) without drift. **Every spec
listed here should match the actual `spec` exported from the tool file.**

When you add a tool, update this document in the same PR. New tools must:

1. Export `{ spec, execute }` from a file in `src/tools/`.
2. Be imported and registered under the right gating bucket in
   `src/tools/index.js` (`SUPABASE_MODULES`, `MEMORY_MODULES`, or
   `DUCKDB_MODULES`).
3. Set a cache TTL in the `TOOL_TTLS` map.
4. Have a test in `test/` that does not rely on a live API.
5. Have an entry below.
6. Have a row in the `ARCHITECTURE.md > Tool catalog` summary table.

If the tool handles privacy-sensitive scope (channel, guild, user), see
`src/agent.js`'s `if (block.name === 'search_chat_history')` block — the
agent layer must forcibly clamp the scope before the tool sees the input.
Add the new tool to that block too.

---

## Gating

The registry only adds a module when its backend is configured. From
`src/tools/index.js`:

| Bucket | Gate | Tools |
|---|---|---|
| `SUPABASE_MODULES` | `config.supabase.enabled` (SUPABASE_URL + SUPABASE_KEY set) | `get_vix_family_latest`, `get_iv_percentile`, `get_gex_levels`, `get_spx_term_structure`, `get_stock_history`, `get_gex_history`, `get_realized_correlations`, `get_vrp_history` |
| `MEMORY_MODULES` | `config.voyage.enabled` (VOYAGE_API_KEY set) | `search_chat_history` |
| `DUCKDB_MODULES` | `duckdbReady()` (at least one shard attached) | `query_duckdb` |
| Anthropic server-side | `ENABLE_WEB_SEARCH` / `ENABLE_WEB_FETCH` | `web_search`, `web_fetch` |

A deployment with no backends still answers questions — the bot becomes a
tool-free conversational model.

---

## Cache TTLs

From `src/tools/index.js TOOL_TTLS`. Tools not listed inherit 60s. Set to 0 to
disable caching for a specific tool. Cache key is `(toolName, canonicalized
input)`; FIFO eviction at 256 entries.

| Tool | TTL (s) | Rationale |
|---|---|---|
| `get_gex_levels` | 30 | Intraday 5-min refresh. |
| `get_spx_term_structure` | 30 | Intraday 5-min refresh. |
| `get_vix_family_latest` | 300 | Daily EOD refresh. |
| `get_iv_percentile` | 300 | Daily EOD refresh. |
| `get_stock_history` | 600 | Historical; reads end at the prior EOD. |
| `get_gex_history` | 600 | Historical; reads end at the prior EOD. |
| `get_realized_correlations` | 600 | Historical; reads end at the prior EOD. |
| `get_vrp_history` | 600 | Historical; reads end at the prior EOD. |
| `search_chat_history` | 30 | Short — chat corpus updates frequently. |
| `query_duckdb` | 60 | Mid — shards refresh daily; arbitrary queries shouldn't pin stale results long. |

`web_search` / `web_fetch` are server-side at Anthropic; the bot does not
cache their responses locally.

---

## Catalog

### `get_vix_family_latest` (Supabase)

Latest EOD close for every symbol in the VIX family plus cross-asset vol
indices. Computes the VVIX:VIX ratio and the VIX3M:VIX term slope.

**Input:** `{}` (no parameters)

**Output:**

```
{
  latest: { VIX: {trading_date, close}, VVIX: {...}, VIX3M: {...}, ... },
  derived: {
    vvix_vix_ratio: number | null,
    vix3m_vix_ratio: number | null,
    term_structure: 'contango' | 'backwardation' | null,
  },
  as_of: 'YYYY-MM-DD' | null,
}
```

**Reads:** `vix_family_eod`. Symbols pulled: VIX, VIX1D/9D/3M/6M/1Y, VVIX,
VXN/RVX/OVX/GVZ, SDEX/TDEX, BXM/BXMD/BFLY/CNDR.

---

### `get_iv_percentile` (Supabase)

SPX 30-day constant-maturity IV and 20-day Yang-Zhang realized vol, with
percentile rank over a chosen lookback.

**Input:**

| Param | Type | Default | Range | Notes |
|---|---|---|---|---|
| `lookback_days` | int | 252 | `[30, 1260]` | Calendar days of history to rank against. |

**Output:**

```
{
  as_of: 'YYYY-MM-DD',
  spx_close: number | null,
  iv_30d_cm: number,
  hv_20d_yz: number | null,
  variance_risk_premium: number | null,
  percentile_rank: number,    // 0..100, IV vs lookback
  lookback: { days, sample_size, min, median, max },
}
```

Filters out rows where `iv_30d_cm` is null. Returns `{ error }` if the window
yields zero usable rows.

**Reads:** `daily_volatility_stats`.

---

### `get_gex_levels` (Supabase)

Current SPX dealer-positioning levels from the latest healthy intraday run.

**Input:** `{}`

**Output:**

```
{
  as_of: 'ISO timestamp',
  trading_date: 'YYYY-MM-DD',
  spot_price: number,
  volatility_flip: number,
  call_wall: number,
  put_wall: number,
  put_call_ratio_oi: number,
  put_call_ratio_volume: number,
  total_call_volume: number,
  total_put_volume: number,
  regime: 'long_gamma' | 'short_gamma' | null,
}
```

Resolves the latest `ingest_runs` row with `status=success` and
`contract_count > 0`, then joins `computed_levels` by `run_id`.

---

### `get_spx_term_structure` (Supabase)

Per-expiration ATM IV + 25Δ put IV + 25Δ call IV across the chain, plus
implied DTE relative to the run's trading date.

**Input:**

| Param | Type | Default | Range | Notes |
|---|---|---|---|---|
| `max_expirations` | int | 20 | `[1, 50]` | Nearest-first cap on returned expirations. |

**Output:**

```
{
  as_of: 'ISO',
  trading_date: 'YYYY-MM-DD',
  expirations: [
    {
      expiration_date,
      dte,
      atm_iv,
      put_25d_iv,
      call_25d_iv,
      put_skew_25d,   // put_25d_iv - atm_iv
      call_skew_25d,  // call_25d_iv - atm_iv
    },
    ...
  ],
}
```

**Sign convention:** put_skew_25d positive means put-wing rich vs ATM (the
typical equity-index state). This convention is also documented in
`src/prompt.js`'s SITE_DEFINITIONS block.

---

### `get_stock_history` (Supabase)

Daily EOD close history for a single ticker.

**Input:**

| Param | Type | Default | Required | Notes |
|---|---|---|---|---|
| `symbol` | string | — | yes | Uppercased internally. |
| `lookback_days` | int | 60 | no | Clamped to `[1, 1260]`. |

**Output:**

```
{
  symbol,
  lookback_days,
  sample_size,
  as_of,
  latest_close, earliest_close,
  return_pct,
  min_close, max_close,
  drawdown_from_high_pct,
  series: [{date, close}, ...]
}
```

Filters rows with null or non-positive closes. Returns `{ error }` when no
usable rows.

---

### `get_gex_history` (Supabase)

Historical SPX dealer-gamma readings: call/put GEX, ATM call/put GEX, vol
flip, walls. Plus percentile rank of latest net GEX vs the lookback.

**Input:**

| Param | Type | Default | Range |
|---|---|---|---|
| `lookback_days` | int | 60 | `[10, 1260]` |

**Output:**

```
{
  lookback_days, sample_size, as_of,
  latest: { spx_close, net_gex, call_gex, put_gex, vol_flip_strike,
            call_wall_strike, put_wall_strike },
  net_gex_percentile_rank: 0..100 | null,
  net_gex_summary: { min, median, max } | null,
  series: [{date, spx_close, net_gex, vol_flip, call_wall, put_wall}, ...]
}
```

The 10-day floor exists because percentile rank over a 1-row sample is
always 0 (a value is never `< itself`), which would falsely report "lowest
ever" on every call.

---

### `get_realized_correlations` (Supabase)

Pairwise Pearson correlations on daily log returns across a basket.

**Input:**

| Param | Type | Default | Range | Notes |
|---|---|---|---|---|
| `symbols` | string[] | sector ETFs | — | Capped at 30 distinct after upper-case dedup. |
| `lookback_days` | int | 60 | `[7, 1260]` | |

Default basket: `XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY`.

**Output:**

```
{
  basket: [string, ...],
  lookback_days, trading_days_used,
  average_pairwise_corr: number | null,
  pairs: [{a, b, corr}, ...], // upper triangle, sorted by corr desc
  missing_symbols: [string, ...],
}
```

Drops rows where any basket symbol is null/non-positive on a given date —
preserves the intersection-alignment invariant Pearson expects.

---

### `get_vrp_history` (Supabase)

Variance risk premium time series (IV - HV), percentile rank, summary stats,
count of negative-VRP days.

**Input:**

| Param | Type | Default | Range |
|---|---|---|---|
| `lookback_days` | int | 252 | `[30, 1260]` |

**Output:**

```
{
  lookback_days, sample_size, as_of,
  current_vrp, current_iv, current_hv,
  percentile_rank: 0..100,
  summary: { min, median, max },
  negative_vrp_days, negative_vrp_share_pct,
  series: [{date, spx_close, iv, hv, vrp}, ...]
}
```

---

### `search_chat_history` (pgvector → SQLite fallback)

Semantic search over persisted past user messages and the assistant replies
that followed them.

**Input:**

| Param | Type | Default | Required | Notes |
|---|---|---|---|---|
| `query` | string | — | yes | Phrased as a natural-language search query. |
| `limit` | int | 5 | no | Clamped to `[1, 15]`. |
| `channel_id` | string | — | no | **Clamped by the agent layer** — see SECURITY.md. |
| `guild_id` | string | — | no | **Clamped by the agent layer** — see SECURITY.md. |

**Output:**

```
{
  query,
  backend: 'pgvector_hnsw' | 'sqlite_cosine',
  hits: [
    {
      similarity, asked_by, asked_at, channel_id,
      question, reply: string | null,
      discord_url: 'https://discord.com/channels/.../...' | null,
    },
    ...
  ],
  similarity_floor: number,        // SEARCH_MIN_SIMILARITY
  corpus_scanned?: number,         // sqlite_cosine only
}
```

Tries pgvector RPC first; falls back to SQLite full-scan cosine on RPC
failure or when Supabase is not configured. Embedding model: `voyage-3`
unless overridden (1024 dims, matches the pgvector column).

**Privacy:** the agent loop forcibly overrides `guild_id` to the caller's
real guild and forces `channel_id = callerChannelId` when the call
originates in a DM (no guild). A prompt-injection trying to widen scope is
overridden at that layer before this tool sees the input.

---

### `query_duckdb` (DuckDB shards, READ_ONLY)

Single-statement SELECT or WITH-SELECT against the attached backtester
shards.

**Input:**

| Param | Type | Default | Required |
|---|---|---|---|
| `sql` | string | — | yes |

**Output:**

```
{
  rows: [...],              // up to 1000
  row_count: number,
  truncated: boolean,
  max_rows_returned: 1000,
  latency_ms: number,
  attached_shards: [string, ...],
}
```

**Guards (three layers, all active simultaneously):**

1. `isReadOnlySelect(sql)` regex: rejects multi-statement, non-SELECT, the
   keyword blocklist (INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, ATTACH,
   DETACH, PRAGMA, COPY, EXPORT, IMPORT, TRUNCATE, GRANT, REVOKE, SET),
   and the function-name deny list (read_csv, read_parquet, read_json,
   glob, load_extension, etc.).
2. Per-shard `ATTACH ... (READ_ONLY)`.
3. `SET enable_external_access = false` + `SET lock_configuration = true`
   applied to the connection **after** the shards attach.

Per-call: 30s timeout via `connection.interrupt()`, 1000-row return cap.
Concurrent calls serialize through a FIFO mutex (the @duckdb/node-api
connection is not safe for two concurrent `runAndReadAll` calls).

**Attached shards** (probed at startup):

| File | Attach name | Required for |
|---|---|---|
| `option_chains_eod.duckdb` | `option_chains` | Full-chain option queries |
| `index_history.duckdb` | `index_history` | Multi-year SPX/VIX indices |
| `stocks_history.duckdb` | `stocks_history` | Multi-year stock/ETF OHLC |
| `derived.duckdb` | `derived` | Pre-computed daily features |

See `DATA_CONTRACTS.md > DuckDB backtester shards` for the exact table
schemas the model expects.

---

### `web_search` / `web_fetch` (Anthropic native)

Anthropic's server-side tools, used when a question turns on current events,
breaking news, recent papers, or a specific URL the user provides.

**Configuration:** controlled by `ENABLE_WEB_SEARCH` / `ENABLE_WEB_FETCH`
env vars. The tools are registered as
`{ type: 'web_search_20250305', name: 'web_search' }` and
`{ type: 'web_fetch_20250910', name: 'web_fetch' }`.

**Billing:** counted by Anthropic in `usage.server_tool_use`. `web_search`
is priced at $10 per 1000 requests; that cost is accumulated into the
turn's `cost_usd` via `pricing.js`. `web_fetch` is currently free at
Anthropic; the bot tracks it but does not charge for it.

The bot does not execute these locally — Anthropic invokes them inside the
same API call. The audit log captures `server_tool_use` blocks from the
response content for the `/usage` breakdown.

---

## Cross-cutting concerns

### Error contract

Every tool's `execute` returns either a normal result object or
`{ error: string }`. The registry coerces `null`/`undefined` returns into
`{ error }` (with a warn log) so the model always sees a well-formed
`tool_result` content block. A thrown exception is caught at the registry,
logged at `warn`, and surfaced as `{ error: message }` to the model.

This is intentional: the model has a path forward in either case (it can
mention the error, retry with different inputs, or abandon the tool). It
does not see the SDK's raw error shape.

### Caching

The registry caches by `(toolName, canonicalized input)` with the per-tool
TTL. Results carrying `error` are not cached. `/admin rebuild-embeddings`
flushes the cache so the bot doesn't serve stale `search_chat_history`
results in the 30s window between rebuild and the embedder's next tick.

### Logging

Tool failures log at `warn` level with `{ tool, err }`. A systematic
regression (renamed table, expired token, broken RPC) becomes a queryable
warn-level signal in `LOG_FORMAT=json` rather than surfacing only as "the
bot is giving weak answers." The model still gets the structured error.

### Latency tracking

The agent loop wraps each tool execution with `Date.now()` so per-tool
latency lands in the assistant message's `tool_uses[].latency_ms`. The
`/usage` "by tool" breakdown averages over non-null values. Server-side
tools (`web_search`/`web_fetch`) report `null` latency because Anthropic
executes them and their cost surfaces from `usage.server_tool_use` rather
than from `executeTool`.
