# Data Contracts

The schema interfaces the bot expects from every external integration. **Read this before forking** if you intend to swap in your own market-data provider, your own backtester shards, or your own embedding model. Every table, column, and constraint here is a contract — a missing column or a wrong type is a runtime failure with no warning.

For the bot's own internal schema (the SQLite store it owns and migrates), see `ARCHITECTURE.md > Storage > SQLite`. This document covers only the **external** contracts.

Companion documents:

- `ARCHITECTURE.md` — system overview and module map.
- `README.md` — user-facing setup.
- `migrations/discord_chat_memory_001.sql` and `migrations/discord_chat_memory_002_unique_local_id.sql` — copy-paste-ready SQL for the one Supabase table the bot writes.

---

## Anthropic

The bot uses the `@anthropic-ai/sdk` (v0.40+) against the standard Anthropic Messages API. The only non-obvious dependencies:

| Feature | Used | Notes |
|---|---|---|
| `messages.stream` | Yes | The agent loop and `/summarize` both stream. |
| Prompt caching (`cache_control: ephemeral`) | Yes | Two cache breakpoints per call: end of static system prefix, end of tool list. |
| Tool use | Yes | Up to 8 rounds per turn; parallel tool execution via `Promise.all`. |
| Server-side `web_search_20250305` | Optional | Disabled when `ENABLE_WEB_SEARCH=false`. |
| Server-side `web_fetch_20250910` | Optional | Disabled when `ENABLE_WEB_FETCH=false`. |
| `pause_turn` stop reason | Yes | Resumes with a fresh round; preserves the running text accumulator. |
| `refusal` stop reason | Yes | Surfaces an explicit refusal note to the user. |
| `server_tool_use` content blocks | Yes | Captured into the audit log + billed via `usage.server_tool_use`. |

Configured model defaults to `claude-sonnet-4-6` (`ANTHROPIC_MODEL` env var). The three supported models (priced in `src/pricing.js`):

| Model id | Input $/MTok | Output $/MTok | Cache write $/MTok | Cache read $/MTok |
|---|---:|---:|---:|---:|
| `claude-opus-4-7` | 15.00 | 75.00 | 18.75 | 1.50 |
| `claude-sonnet-4-6` | 3.00 | 15.00 | 3.75 | 0.30 |
| `claude-haiku-4-5-20251001` | 1.00 | 5.00 | 1.25 | 0.10 |

To use a different model: set `ANTHROPIC_MODEL` AND add a pricing entry to `src/pricing.js`. The startup logs a warn if the configured model has no pricing entry; cost tracking will record `null` until you fix it.

---

## Voyage AI

The bot uses `voyage-3` by default (1024 dims). Override with `VOYAGE_MODEL`.

**Endpoint**: `POST https://api.voyageai.com/v1/embeddings`

**Request**:
```json
{
  "model": "voyage-3",
  "input": ["text1", "text2", ...],
  "input_type": "document" | "query"
}
```

**Expected response**:
```json
{
  "data": [
    { "embedding": [0.123, -0.456, ...] },
    ...
  ]
}
```

The bot batches up to 32 inputs per call. The vector dim does not need to be exactly 1024 — `Float32Array.from(embedding)` accepts any length — but the storage column and the pgvector HNSW index ARE pinned at 1024, so a swap requires a migration.

**To swap embedding providers**: re-implement `src/embeddings.js`'s `embed()` to return `Float32Array[]` from your provider. If the dim changes, update `migrations/discord_chat_memory_001.sql`'s vector column dim and run `npm run admin -- rebuild-embeddings` (or the equivalent SQL) on a fresh deployment.

---

## Supabase: tables the bot READS

All reads are via PostgREST. The bot uses the `selectRows()` helper in `src/supabase.js` which composes URLs like:

```
GET /rest/v1/{table}?select={cols}&{filter}=eq.{value}&order={col}.{dir}&limit={N}
```

The bot uses the anon key. Production RLS should allow `SELECT` from these tables.

Below is the exact schema the bot expects, table by table. Column types are PostgREST-projected JSON types (PostgreSQL `numeric`/`double precision` → JS number, `timestamptz` → ISO string, `date` → `YYYY-MM-DD` string).

### `vix_family_eod`

Daily EOD close for the VIX family and cross-asset vol indices. Used by `get_vix_family_latest`.

| Column | Type | Notes |
|---|---|---|
| `symbol` | text | One of: `VIX`, `VIX1D`, `VIX9D`, `VIX3M`, `VIX6M`, `VIX1Y`, `VVIX`, `VXN`, `RVX`, `OVX`, `GVZ`, `SDEX`, `TDEX`, `BXM`, `BXMD`, `BFLY`, `CNDR` |
| `trading_date` | date | Trading date (NYSE close basis) |
| `close` | numeric | Closing value for that symbol on that date |

Bot query: `symbol=in.(VIX,VIX1D,...)`, `order=trading_date.desc`, `limit=200`. Takes the latest per-symbol row in JS.

### `daily_volatility_stats`

Daily SPX volatility statistics. Used by `get_iv_percentile` and `get_vrp_history`.

| Column | Type | Notes |
|---|---|---|
| `trading_date` | date | Trading date |
| `spx_close` | numeric | SPX cash close |
| `iv_30d_cm` | numeric | 30-day constant-maturity ATM implied volatility (decimal vol, e.g. 0.18 = 18% IV) |
| `hv_20d_yz` | numeric | 20-day Yang-Zhang realized volatility (decimal vol) |

Bot query: `trading_date=gte.{lookback_start}`, `order=trading_date.asc`, `limit=2000`. The bot computes VRP = `iv_30d_cm - hv_20d_yz` client-side.

**Behavior under nulls**: rows with null `iv_30d_cm` or `hv_20d_yz` are filtered out of the percentile/series before computation. Rows with valid iv/hv but null `spx_close` surface `spx_close: null` in the response rather than coercing to 0.

### `daily_eod`

Daily OHLC for individual symbols (stocks + ETFs). Used by `get_stock_history` and `get_realized_correlations`.

| Column | Type | Notes |
|---|---|---|
| `symbol` | text | Ticker (uppercase) |
| `trading_date` | date | Trading date |
| `close` | numeric | Closing price |
| (`open` / `high` / `low` / `volume` may exist; bot doesn't read them) | — | — |

Bot query: `symbol=eq.{TICKER}` (single name) or `symbol=in.(...)` (basket), `trading_date=gte.{lookback_start}`, `order=trading_date.asc`, `limit=2000` (single) / `basket.length * max(days, 120)` (basket).

### `daily_gex_stats`

Daily SPX dealer-gamma rollup. Used by `get_gex_history`.

| Column | Type | Notes |
|---|---|---|
| `trading_date` | date | Trading date |
| `spx_close` | numeric | SPX cash close |
| `net_gex` | numeric | Net dealer gamma exposure (positive = dealers long gamma / pinning regime) |
| `call_gex` | numeric | Call-side gamma exposure |
| `put_gex` | numeric | Put-side gamma exposure |
| `atm_call_gex` | numeric | ATM-only call gamma |
| `atm_put_gex` | numeric | ATM-only put gamma |
| `vol_flip_strike` | numeric | Strike at which the dealer book flips long↔short gamma |
| `call_wall_strike` | numeric | Highest call-gamma concentration above spot |
| `put_wall_strike` | numeric | Highest put-gamma concentration below spot |

Bot query: `trading_date=gte.{lookback_start}`, `order=trading_date.asc`, `limit=2000`. Percentile rank is computed in JS over rows with finite `net_gex`. **Sign convention**: positive net_gex = long gamma = pinning; negative = short gamma = trending. This convention is documented in the system prompt.

### `ingest_runs`

Per-snapshot metadata for SPX intraday ingest. Used by `get_gex_levels` and `get_spx_term_structure` to resolve the latest healthy run.

| Column | Type | Notes |
|---|---|---|
| `id` | bigint | Run id (foreign key target) |
| `underlying` | text | Currently only `SPX` is queried |
| `snapshot_type` | text | Currently only `intraday` |
| `status` | text | Must equal `success` for the bot to use it |
| `contract_count` | integer | Bot filters `gt.0` to exclude empty runs |
| `captured_at` | timestamptz | When the snapshot was taken |
| `trading_date` | date | Trading date the snapshot belongs to |
| `spot_price` | numeric | SPX spot at capture time (for regime classification) |

Bot query: `underlying=eq.SPX`, `snapshot_type=eq.intraday`, `status=eq.success`, `contract_count=gt.0`, `order=captured_at.desc`, `limit=1`. Always picks the most recent healthy run.

### `computed_levels`

Per-run aggregate dealer-positioning metrics. Used by `get_gex_levels`. Linked to `ingest_runs.id` via `run_id`.

| Column | Type | Notes |
|---|---|---|
| `run_id` | bigint | FK to `ingest_runs.id` |
| `call_wall_strike` | numeric | Strike with highest call-gamma concentration above spot |
| `put_wall_strike` | numeric | Strike with highest put-gamma concentration below spot |
| `volatility_flip` | numeric | Spot level where dealer book transitions long↔short gamma |
| `put_call_ratio_oi` | numeric | Put OI / Call OI |
| `put_call_ratio_volume` | numeric | Put volume / Call volume |
| `total_call_volume` | numeric | Aggregate call volume |
| `total_put_volume` | numeric | Aggregate put volume |

### `expiration_metrics`

Per-expiration SPX vol surface points. Used by `get_spx_term_structure`. Linked to `ingest_runs.id` via `run_id`.

| Column | Type | Notes |
|---|---|---|
| `run_id` | bigint | FK to `ingest_runs.id` |
| `expiration_date` | date | Option expiration |
| `atm_iv` | numeric | At-the-money implied volatility (decimal vol) |
| `put_25d_iv` | numeric | 25-delta put implied volatility (decimal vol) |
| `call_25d_iv` | numeric | 25-delta call implied volatility (decimal vol) |

Bot query: `run_id=eq.{run.id}`, `order=expiration_date.asc`, `limit={max_expirations}` (clamped 1..50, default 20). Bot computes DTE and 25Δ skew (`put_25d_iv - atm_iv`, `call_25d_iv - atm_iv`) client-side.

**25Δ risk-reversal convention**: the bot expects `put - call` ordering. Positive means put wing richer than call wing (the typical equity-index state). This is documented in the system prompt's `[METRIC DEFINITIONS]` block — a fork using FX-desk convention (call - put) would need to swap signs.

---

## Supabase: table the bot WRITES

### `discord_chat_memory`

The pgvector mirror of locally-embedded user messages. The bot upserts rows here from the background embedder, and queries via the `search_discord_memory` RPC.

**Schema** (see `migrations/discord_chat_memory_001.sql` for the canonical DDL):

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | — |
| `local_id` | bigint | The bot's local SQLite `messages.id`. `UNIQUE` — see migration 002. |
| `channel_id` | text | Discord channel id |
| `guild_id` | text NULL | Discord guild id; null for DMs |
| `user_id` | text | Discord user id |
| `username` | text NULL | Display name at the time the message was sent |
| `role` | text | `user` (only user messages are embedded) |
| `content` | text | The message text |
| `reply_local_id` | bigint NULL | The local id of the assistant reply paired with this user message |
| `reply_content` | text NULL | The assistant reply text |
| `embedding` | `vector(1024)` | voyage-3 embedding |
| `embedding_model` | text | Default `voyage-3` |
| `created_at` | timestamptz | When the row was inserted |

**Indexes**:

- HNSW on `embedding` using `vector_cosine_ops` (the RPC orders by cosine distance).
- `UNIQUE (local_id)` — the upsert relies on `on_conflict=local_id`. Without this, every embedder sync fails with a PostgREST 'no unique constraint' error. Migration 002 adds this; **do not skip migration 002**.

**The RPC** (also in migration 001):

```sql
search_discord_memory(query_embedding, match_count, similarity_floor, p_channel_id) →
  TABLE(local_id, channel_id, guild_id, user_id, username, content,
        reply_content, similarity, created_at)
```

Computes `1 - (embedding <=> query_embedding)` as similarity, filters by floor and optional channel, returns top match_count.

---

## DuckDB backtester shards

The optional read-only data layer. `BACKTESTER_DATA_DIR` (default `C:/aigamma-backtester/data`) points at a directory of `*.duckdb` files. The bot attaches each present shard read-only at startup and registers the `query_duckdb` tool when any are found.

**Attach names** (the bot probes for these exact filenames):

| File | Attached as | Required for |
|---|---|---|
| `option_chains_eod.duckdb` | `option_chains` | Full-chain options queries |
| `index_history.duckdb` | `index_history` | Multi-year SPX / VIX index history |
| `stocks_history.duckdb` | `stocks_history` | Multi-year single-name OHLC history |
| `derived.duckdb` | `derived` | Pre-computed daily feature tables |

The bot attaches each that exists; missing files are skipped. With zero present, the `query_duckdb` tool isn't registered and the bot starts cleanly.

### Schemas

Below is the schema the model expects to query. An external puller (open-source: `aigamma-backtester`, but anyone can write one) must produce these tables to make `query_duckdb` useful.

#### `option_chains.option_chains_eod`

End-of-day per-contract option chain rows.

| Column | Type | Notes |
|---|---|---|
| `date` | DATE | Trading date |
| `symbol` | VARCHAR | Underlying ticker (e.g. `SPX`, `SPXW`) |
| `expiration` | DATE | Option expiration |
| `"right"` | VARCHAR | `'call'` or `'put'` |
| `strike` | DECIMAL | Strike price |
| `open` / `high` / `low` / `close` | DOUBLE | OHLC |
| `volume` | BIGINT | Contract volume |
| `open_interest` | BIGINT | OI |
| `bid` / `ask` | DOUBLE | NBBO at close |
| `bid_size` / `ask_size` | BIGINT | Sizes |
| `last_trade` | TIMESTAMP | Last trade timestamp |

Data-vendor terms inherited from aigamma's contract: redistribute only **computed** metrics from raw chains (percentile ranks, GEX derivatives, regime labels). Do not return raw per-strike IV grids, per-contract Greeks, or raw bid/ask via your tools.

#### `index_history.index_history_eod`

Daily OHLC for indices.

| Column | Type | Notes |
|---|---|---|
| `date` | DATE | Trading date |
| `symbol` | VARCHAR | Index ticker (e.g. `SPX`, `VIX`) |
| `open` / `high` / `low` / `close` | DOUBLE | OHLC |

#### `stocks_history.stocks_history_eod`

Daily OHLC for individual equities + ETFs.

| Column | Type | Notes |
|---|---|---|
| `date` | DATE | Trading date |
| `symbol` | VARCHAR | Ticker |
| `open` / `high` / `low` / `close` | DOUBLE | OHLC |
| `volume` | BIGINT | Daily volume |

#### `derived.daily_indicators`

Per-symbol rolling indicators. Schema settling — the model description in `queryDuckdb.js`'s tool spec is the canonical reference; expect columns for SMAs, RSI, percentile ranks, MA flags.

#### `derived.daily_regime`

Per-day regime labels for SPX.

| Column | Type | Notes |
|---|---|---|
| `date` | DATE | Trading date |
| `negative_gamma_flag` | BOOLEAN | Dealer book in short-gamma regime |
| `term_inversion_flag` | BOOLEAN | VIX term structure inverted (backwardation) |
| `vrp_regime` | VARCHAR | Categorical VRP state |

#### `derived.daily_term_structure`

Per-day ATM IV at standard tenors.

| Column | Type | Notes |
|---|---|---|
| `date` | DATE | Trading date |
| `atm_iv_30d` | DOUBLE | 30-day ATM IV |
| `atm_iv_60d` | DOUBLE | 60-day ATM IV |
| `atm_iv_90d` | DOUBLE | 90-day ATM IV |
| `atm_iv_180d` | DOUBLE | 180-day ATM IV |
| `slope_30d_180d` | DOUBLE | Front-back slope |

#### `derived.daily_gex`

Per-day approximate dealer GEX.

| Column | Type | Notes |
|---|---|---|
| `date` | DATE | Trading date |
| `approximate_dealer_gex` | DOUBLE | Approximate net GEX |
| `vol_flip_strike` | DOUBLE | Strike where book flips long↔short gamma |

#### `derived.daily_atm_iv`

Per-symbol ATM IV at standard tenors.

| Column | Type | Notes |
|---|---|---|
| `date` | DATE | Trading date |
| `symbol` | VARCHAR | Ticker |
| `atm_iv_30d` / `60d` / `90d` / `180d` | DOUBLE | ATM IV at tenor |

### Coverage expectations

The default deployment expects coverage for:

- **SPX / SPXW** in `option_chains_eod`
- **SPX, VIX** in `index_history_eod`
- **SPY, QQQ, IWM, DIA, XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLU, XLV, XLY, XLRE** + top-11 single names by options volume in `stocks_history_eod`

A fork can ship any subset. The model adapts to what's queryable.

### Safety contract

The bot's `query_duckdb` tool refuses any statement that isn't a single `SELECT` or `WITH ... SELECT`. The DuckDB connection has external filesystem access disabled (`SET enable_external_access = false; SET lock_configuration = true`) **after** the shards attach, so DuckDB's file-reading table functions (`read_csv`, `read_parquet`, `glob`, `load_extension`, etc.) are refused at the engine even if the regex guard ever misses one.

A fork swapping in their own shards inherits this lockdown automatically — no per-tool change needed.

---

## Snap-in guide

A pure-Anthropic deployment (no Supabase, no Voyage, no DuckDB):

1. Set `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `ANTHROPIC_API_KEY`. Run.
2. The bot operates with short-term context only. `/search`, market-data tools, and `query_duckdb` are unregistered. `/about` reflects this.

A deployment with your own DuckDB shards:

1. Build a puller (any language) that writes one of the four `*.duckdb` files with the schemas above.
2. Place under `BACKTESTER_DATA_DIR` (default `C:/aigamma-backtester/data`, override via env).
3. Restart the bot. The attach is read-only — the bot cannot write to your shards.

A deployment with your own Supabase backend:

1. Provision a Supabase project. Apply `migrations/discord_chat_memory_001.sql` and `migrations/discord_chat_memory_002_unique_local_id.sql`.
2. Build a puller that writes the seven tables documented above (`vix_family_eod`, `daily_volatility_stats`, `daily_eod`, `daily_gex_stats`, `ingest_runs`, `computed_levels`, `expiration_metrics`).
3. Set `SUPABASE_URL` + `SUPABASE_KEY` (anon key, with read RLS on the public tables and write/read on `discord_chat_memory`).
4. Restart the bot. The eight market-data tools register; the embedder starts mirroring to pgvector.

A deployment that mixes-and-matches: any subset of the above. The tool registry gates each module on its backend being configured.
