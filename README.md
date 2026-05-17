# Strategic Trading Discord Bot

An MIT-licensed Discord bot that turns Claude Sonnet 4.6 into a strategic
trading desk-mate for a private community of practitioners. The bot reasons
over a curated live-market backend, recalls past discussions by semantic
similarity, queries multi-year DuckDB shards from a research backtester,
and never opens with sycophancy.

Built for [Options Alchemy](https://github.com/aigamma) — a closed
community of market makers, options traders, and quants — but designed to
be forked.

## Capabilities

| Surface | What it does |
|---|---|
| `/ask <question> [model:<sonnet\|opus\|haiku>]` | Slash-command Q&A with the model. Tool-use enabled. Streams progressive Discord edits as the response builds. |
| `@bot <question>` | Mention the bot in any channel it can see. |
| `/search <query> [scope:<channel\|all>]` | Semantic search over the bot's persisted chat history. pgvector HNSW with SQLite cosine fallback. Results carry deep-links back to the original Discord message. |
| `/summarize [messages:N]` | Brief of the last N (default 100) channel messages. Streaming. |
| `/remember <note>` | Save a persistent note about yourself (≤280 chars, max 12 notes). Surfaces in every future system prompt for you. |
| `/notes` | List your saved notes (ephemeral). |
| `/forget-note <number>` | Remove a single saved note by its number from `/notes`. |
| `/forget-notes` | Clear all your saved notes. |
| `/forget` | Clear this channel's short-term context window. Non-destructive — older messages stay searchable via `/search`. |
| `/export` | Download this channel's persisted Q&A as a JSON attachment (24MB cap; caller-only). |
| `/usage [hours]` | Ephemeral cost / token / latency summary (p50, p95, prompt-cache hit ratio) with per-model, per-tool, feedback breakdowns. Owner-only: per-user spend breakdown. |
| `/health` | Process state: pgvector reachability + latency, embed and sync queue depths, embed/sync failure counters (split), DuckDB shards, tool cache stats, SQLite integrity, lifecycle drain status. |
| `/about` | Capability tour for new community members. |
| `/admin <subcommand>` | Owner-gated: `rebuild-embeddings`, `backup`, `reset-rate-limit`, `feedback`. |
| 👍 / 👎 reaction | Capture quality feedback on assistant messages; rolls up in `/usage` and `/admin feedback`. |

## What the model can actually do

Each Anthropic API call is augmented with tool-use against:

| Tool | Backend | Use case |
|---|---|---|
| `get_vix_family_latest` | Supabase | VIX, VVIX, term structure, cross-asset vol, SDEX/TDEX |
| `get_iv_percentile` | Supabase | SPX 30-day IV with percentile rank, realized vol, VRP |
| `get_gex_levels` | Supabase | Live Vol Flip, Call Wall, Put Wall, P/C ratios |
| `get_spx_term_structure` | Supabase | Per-expiration ATM IV and 25Δ skew |
| `get_stock_history` | Supabase | Single-name and ETF OHLC with derived returns |
| `get_gex_history` | Supabase | Daily SPX dealer-gamma history with percentile rank |
| `get_realized_correlations` | Supabase | Pairwise correlation matrix over a basket (default sector ETFs) |
| `get_vrp_history` | Supabase | Variance risk premium series with summary stats and percentile rank |
| `search_chat_history` | pgvector + SQLite | Semantic recall over the channel's past Q&A |
| `query_duckdb` | DuckDB shards | Read-only SELECT against multi-year option-chain, index, stock, and derived feature tables (when the backtester puller has produced them) |
| `web_search` | Anthropic native | Current events, news, papers |
| `web_fetch` | Anthropic native | Pull and read a specific URL |

Tool results are cached per (name, normalized-input) with per-tool TTL
overrides; the cache short-circuits duplicate calls within the
freshness window. The model decides which to call per turn; tool chains
up to 8 rounds per turn before the safety stop.

## Memory model

**Short-term** — last N turns in the same channel within a sliding window
(default 12 turns / 60 minutes), loaded from SQLite on every call. The bot
remembers what was said seconds or minutes ago without any model-level
context engineering. Multi-user channels prefix each user message with the
Discord display name so the model can attribute speakers correctly.

**Long-term** — every Q&A persists to SQLite forever, with the user
message embedded via Voyage `voyage-3` (1024-dim). A background worker
ticks every 10 seconds, embeds pending rows, and mirrors them into the
`discord_chat_memory` table in Supabase, indexed with HNSW over cosine
distance. The `search_chat_history` tool prefers the pgvector HNSW path
and transparently falls back to local SQLite cosine when Supabase is
unreachable — the model sees the same interface either way.

## Style discipline

The system prompt is modeled directly on `aigamma.com`'s production chat
constraints. No opening preambles. No flattery. No closing hooks. No
em-dashes, bullets, emojis, metaphors, or analogies. Final sentence is
always declarative. The audience does not need affirmation, only signal.

## Setup

Requires Node.js 22+ and npm.

### 1. Install

```bash
git clone <repo> trading-discord-bot
cd trading-discord-bot
npm install
```

### 2. Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → enable **MESSAGE CONTENT INTENT** (required for `@mention`).
3. **Reset Token** → save as `DISCORD_BOT_TOKEN`.
4. **General Information** → copy **Application ID** as `DISCORD_CLIENT_ID`.
5. **OAuth2** → **URL Generator** → scopes `bot` + `applications.commands`;
   permissions `Send Messages`, `Read Message History`, `Use Slash
   Commands`, `Embed Links`, `Attach Files`. Open the generated URL and
   authorize. (`Attach Files` is required for `/export`'s JSON upload;
   the bot does not need `Add Reactions` because it only receives them.)

### 3. Configure

```bash
cp .env.example .env.local
```

Fill in `.env.local`. Required: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`,
`ANTHROPIC_API_KEY`. Optional: `SUPABASE_*` (enables live market data and
pgvector memory), `VOYAGE_API_KEY` (enables semantic recall),
`BACKTESTER_DATA_DIR` (enables DuckDB tool),
`OPERATOR_HANDLE`/`OPERATOR_NAME`/`COMMUNITY_NAME` (override the
system-prompt identity for forks).

### 4. Verify credentials

```bash
npm run verify
```

Pings every configured external service (Anthropic, Supabase REST,
Supabase pgvector, Voyage, DuckDB shards) and reports per-service
status. Catches credential errors before users hit them via `/ask`.

### 5. Register slash commands

```bash
npm run register
```

If `DISCORD_GUILD_ID` is set, commands register to that guild instantly.
Otherwise global registration, which propagates within ~1 hour.

### 6. Run

```bash
npm start
```

In Discord:

- `/ask is VVIX rich right now?`
- `@bot what does the SPX term structure say about front-month bid?`
- `/search vol of vol regime` (looks up past conversations)
- `/health` (subsystem state)

Stop with `Ctrl+C`. The bot drains in-flight model turns gracefully before
exit (30-second drain timeout, 45-second hard kill).

### 7. Tests

```bash
npm test
```

node:test suites covering pricing, rate limit, cosine, prompt composition,
SQL guard, progress reporter, budget, memory persistence, tool cache,
user notes, backup, and Supabase retry predicates. No live API calls;
SQLite-touching tests use per-process tmp stores.

## Architecture

```
src/
  index.js                  Entry; runs DuckDB attach, builds client, installs lifecycle, logs in
  config.js                 Env loading + validation, fail-fast on missing required keys
  logger.js                 Structured logger (JSON for non-TTY, pretty for TTY)
  lifecycle.js              uncaughtException / unhandledRejection / SIGINT-SIGTERM with drain
  bot.js                    discord.js client + interaction routing for all slash commands and @mention
  agent.js                  Anthropic tool-use loop, retry-with-backoff on transient errors
  prompt.js                 System prompt — composed from cacheable static prefix + per-turn temporal block
  summarize.js              /summarize bypass path (dedicated system prompt, streaming, audited)
  admin.js                  Owner-gated /admin operations (rebuild, backup, reset rate limit, feedback)
  pricing.js                Per-model + server-tool pricing for the cost audit
  rateLimiter.js            Per-user sliding-window rate limit
  budget.js                 Per-user daily cost cap (midnight UTC) from the turns audit log
  toolCache.js              In-process LRU+TTL keyed on (tool, canonicalized input)
  progressReporter.js       Debounced Discord edits as streamed text accumulates
  healthServer.js           Optional HTTP /healthz endpoint for orchestration probes
  backup.js                 Online SQLite backup via VACUUM INTO, with rotation
  db.js                     SQLite open + idempotent migrations
  memory.js                 Persisted messages, audit turns, short-term context, /usage aggregates
  embeddings.js             Voyage client (batch, retry), Float32 ↔ Buffer helpers, cosine
  embedder.js               Background worker — embed pending, sync to pgvector
  pgvector.js               Supabase pgvector upsert + HNSW search RPC wrapper
  supabase.js               Thin REST wrapper for market-data tools
  duckdb.js                 Read-only attach of backtester shards, SELECT-only guarded query interface
  tools/
    index.js                Registry — only registers tools whose backend is configured
    vixFamily.js            VIX/VVIX/term structure/cross-asset
    ivPercentile.js         30d IV rank, realized, VRP
    gexLevels.js            Live Vol Flip, Call Wall, Put Wall
    termStructure.js        Per-expiration IV across the chain
    stockHistory.js         Single-name OHLC history
    gexHistory.js           Daily SPX GEX history with percentile rank
    realizedCorrelations.js Pairwise realized correlations over a basket
    vrpHistory.js           Variance risk premium history with percentile rank
    searchChatHistory.js    Semantic recall (pgvector → SQLite fallback)
    queryDuckdb.js          Read-only SQL against the backtester shards
scripts/
  register-commands.js      One-off slash command registration
  verify.js                 Credential preflight against every configured external service
  postmortem.js             Per-user audit + feedback rollup over a window
  backup-db.js              CLI entry for the SQLite VACUUM INTO backup
test/                       node:test suites (run with `npm test`)
data/                       SQLite store (gitignored, created on first launch)
```

## Optional integrations

### Supabase (market data + pgvector memory)

Configure `SUPABASE_URL` and `SUPABASE_KEY`. The bot reads from
`vix_family_eod`, `daily_volatility_stats`, `daily_eod`, `daily_gex_stats`,
`ingest_runs`, `computed_levels`, and `expiration_metrics` (all written by
the `aigamma.com` pipeline), and writes to `discord_chat_memory` (the bot's
own table). Use the anon key in any new deployment; the bot only reads
public tables on aigamma's schema and writes to a single table it owns.

Two migrations ship for a fresh Supabase deployment:

- `migrations/discord_chat_memory_001.sql` — creates the
  `discord_chat_memory` table with the HNSW index, RLS, and the
  `search_discord_memory` RPC.
- `migrations/discord_chat_memory_002_unique_local_id.sql` — adds the
  `UNIQUE(local_id)` constraint the bot's upsert relies on (via
  `on_conflict=local_id`). Required; without it, every embedder sync
  fails with a PostgREST 'no unique constraint' error.

Apply both in order via `psql` or the Supabase SQL editor.

### Voyage (semantic embeddings)

Configure `VOYAGE_API_KEY` and optionally `VOYAGE_MODEL` (default
`voyage-3`). The bot embeds every persisted user message in the background
(10-second tick, batches of 32, idempotent on `embedding IS NULL`). Without
Voyage, the bot still keeps short-term context but cannot search older
history by similarity.

### DuckDB backtester shards

Configure `BACKTESTER_DATA_DIR` (default `C:/aigamma-backtester/data`).
When `*.duckdb` files exist at that path, the bot attaches them read-only
at startup and registers the `query_duckdb` tool. The model gets SELECT
access to multi-year option chains, index history, stock history, and
pre-computed daily feature tables. The bot starts cleanly when the
directory is empty; the tool simply isn't registered.

## Data licensing

Inherited from the aigamma.com vendor contract. The bot redistributes only
**computed** metrics — percentile ranks, GEX outputs, term-structure
points, regime labels, derived ratios. Raw per-strike IV grids,
per-contract Greeks, and raw bid/ask quotes never leave the data layer.
The shipped tools respect this boundary by construction; do not modify
them to return raw chain data.

## Production posture

- Structured logger with auto-JSON for piped output (supervisor ingest).
- Process-wide uncaught exception and unhandled rejection handlers.
- Graceful SIGINT/SIGTERM with in-flight turn drain.
- Transient-error retry with exponential backoff against Anthropic 429/5xx.
- Token-aware prompt cache (static prefix + per-turn temporal + per-user notes tail).
- NYSE holiday calendar through 2027 in the temporal block: the
  system prompt labels Christmas / MLK Day / etc. as "market closed
  for <holiday>" and the three early-close days as "shortened
  session, closes at 13:00 ET" so the model doesn't tell traders
  the market is open on a holiday.
- Per-user rate limit (default 10/min sliding window).
- Per-user daily cost cap from the turns audit log (`DAILY_USER_COST_CAP_USD`).
- Per-turn cost audit (input/output/cache_write/cache_read priced per
  model, written to `turns` table; `/usage` aggregates a window).
- Read-only DuckDB attach with three-layer guard: SELECT/WITH-only
  parser, function-name deny list against `read_csv` /
  `read_parquet` / `glob` / `load_extension` etc., plus engine-level
  `enable_external_access = false` + `lock_configuration = true` so a
  prompt-injected SELECT can't reach the host filesystem. 30s and
  1000-row caps on top.
- Tool-result cache with per-tool TTLs.
- HTTP `/healthz` for orchestration probes plus the `/health` slash command for in-Discord state.
- Online SQLite backup via `VACUUM INTO` (`npm run backup` or `/admin backup`).
- Postmortem report (`npm run postmortem`) aggregates audit + feedback for review.
- Unit tests (`npm test`) running on every CI push.
- ESLint flat config (`npm run lint`) running on every CI push.

## License

MIT. See `LICENSE`.
