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
| `/ask <question>` | Slash-command Q&A with the model. Tool-use enabled. |
| `@bot <question>` | Mention the bot in any channel it can see. |
| `/search <query>` | Semantic search over the bot's persisted chat history. Backed by Supabase pgvector HNSW with a local SQLite cosine fallback. |
| `/usage [hours]` | Ephemeral token / cost / latency summary. |
| `/health` | Process state: pgvector reachability, embedder queue, DuckDB shards, capabilities. |
| `/forget` | Clear this channel's short-term context window. |

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
| `search_chat_history` | pgvector + SQLite | Semantic recall over the channel's past Q&A |
| `query_duckdb` | DuckDB shards | Read-only SELECT against multi-year option-chain, index, stock, and derived feature tables (when the backtester puller has produced them) |
| `web_search` | Anthropic native | Current events, news, papers |
| `web_fetch` | Anthropic native | Pull and read a specific URL |

The model decides which to call per turn; tool chains up to 8 rounds per
turn before the safety stop.

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
   Commands`, `Embed Links`. Open the generated URL and authorize.

### 3. Configure

```bash
cp .env.example .env.local
```

Fill in `.env.local`. Required: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`,
`ANTHROPIC_API_KEY`. Optional: `SUPABASE_*` (enables live market data and
pgvector memory), `VOYAGE_API_KEY` (enables semantic recall),
`BACKTESTER_DATA_DIR` (enables DuckDB tool).

### 4. Register slash commands

```bash
npm run register
```

If `DISCORD_GUILD_ID` is set, commands register to that guild instantly.
Otherwise global registration, which propagates within ~1 hour.

### 5. Run

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

### 6. Tests

```bash
npm test
```

Pure-function tests only (pricing, rate limit, cosine, prompt composition,
SQL guard). No live API or DB calls.

## Architecture

```
src/
  index.js              Entry; runs DuckDB attach, builds client, installs lifecycle, logs in
  config.js             Env loading + validation, fail-fast on missing required keys
  logger.js             Structured logger (JSON for non-TTY, pretty for TTY)
  lifecycle.js          uncaughtException / unhandledRejection / SIGINT-SIGTERM with drain
  bot.js                discord.js client + interaction routing for all slash commands and @mention
  agent.js              Anthropic tool-use loop, retry-with-backoff on transient errors
  prompt.js             System prompt — composed from cacheable static prefix + per-turn temporal block
  pricing.js            Per-model token pricing for the cost audit
  rateLimiter.js        Per-user sliding-window rate limit
  db.js                 SQLite open + idempotent migrations
  memory.js             Persisted messages, audit turns, short-term context, /usage aggregates
  embeddings.js         Voyage client (batch, retry), Float32 ↔ Buffer helpers, cosine
  embedder.js           Background worker — embed pending, sync to pgvector
  pgvector.js           Supabase pgvector upsert + HNSW search RPC wrapper
  supabase.js           Thin REST wrapper for market-data tools
  duckdb.js             Read-only attach of backtester shards, SELECT-only guarded query interface
  tools/
    index.js            Registry — only registers tools whose backend is configured
    vixFamily.js        VIX/VVIX/term structure/cross-asset
    ivPercentile.js     30d IV rank, realized, VRP
    gexLevels.js        Live Vol Flip, Call Wall, Put Wall
    termStructure.js    Per-expiration IV across the chain
    stockHistory.js     Single-name OHLC history
    gexHistory.js       Daily SPX GEX history with percentile rank
    searchChatHistory.js  Semantic recall (pgvector → SQLite fallback)
    queryDuckdb.js      Read-only SQL against the backtester shards
scripts/
  register-commands.js  One-off slash command registration
test/                   node:test suites (33 tests)
data/                   SQLite store (gitignored, created on first launch)
```

## Optional integrations

### Supabase (market data + pgvector memory)

Configure `SUPABASE_URL` and `SUPABASE_KEY`. The bot reads from
`vix_family_eod`, `daily_volatility_stats`, `daily_eod`, `daily_gex_stats`,
`ingest_runs`, `computed_levels`, and `expiration_metrics` (all written by
the `aigamma.com` pipeline), and writes to `discord_chat_memory` (the bot's
own table). Use the anon key in any new deployment; the bot only reads
public tables on aigamma's schema and writes to a single table it owns.

A migration to create `discord_chat_memory` with the HNSW index and the
`search_discord_memory` RPC ships in `migrations/discord_chat_memory_001.sql`.

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
- Token-aware prompt cache (static prefix + per-turn temporal block).
- Per-user rate limit (default 10/min sliding window).
- Per-turn cost audit (input/output/cache_write/cache_read priced per
  model, written to `turns` table; `/usage` aggregates a window).
- Read-only DuckDB attach with SELECT-only SQL guard and 30s/1000-row caps.
- Health endpoint surfacing every subsystem.

## License

MIT. See `LICENSE`.
