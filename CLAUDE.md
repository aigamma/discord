# Strategic Trading Discord Bot — Architecture Notes

A Discord bot for a private trading community ([Options Alchemy]) that
turns Claude Sonnet 4.6 into a desk-mate over live market data, persisted
chat memory, and the aigamma-backtester's multi-year DuckDB shards. MIT
licensed; designed to be forked.

This file is the canonical architectural reference. Read it before doing
substantive work on the repo.

## Runtime

- Node.js 22+ (node:sqlite, --env-file)
- ESM throughout
- discord.js v14
- @anthropic-ai/sdk
- @duckdb/node-api (native bindings; prebuilt binaries for Win/Mac/Linux)

## Invocation surfaces

| Surface | What it does | Notes |
|---|---|---|
| `/ask question:<text> model:<sonnet\|opus\|haiku>?` | Full agent turn | Tool-use enabled, 8 rounds max |
| `/forget` | Clears short-term context | Channel-scoped |
| `/usage hours:<n>?` | Cost/token/latency summary | Ephemeral; default 24h |
| `/search query:<text> scope:<channel\|all>?` | Semantic recall | pgvector → SQLite fallback |
| `/health` | Subsystem state | Ephemeral |
| `/summarize messages:<n>?` | Brief of recent channel | Default 100 messages |
| `@bot <text>` | Mention invocation | Same agent path as /ask |
| 👍 / 👎 reaction | Feedback capture | Stored to `feedback` table |

## Agent loop

`src/agent.js` runs the canonical Anthropic tool-use loop:

```
load short-term context from SQLite
prepend to messages, append user content
loop up to 8 rounds:
  call client.messages.create with system + tools + messages
  if stop_reason !== 'tool_use': capture text, break
  else: execute tool blocks → append tool_results → continue
persist user + assistant + turn audit
return { text, cost, latency, model, assistantMessageId }
```

Wrapped in `withRetry` (3 attempts, 1s/3s/8s backoff) for 429/5xx
transient errors. `beginWork()` bookends the call for the in-flight
drain counter that graceful shutdown waits on.

## System prompt composition

Composed in `src/prompt.js` from named blocks:

1. CORE_PERSONA
2. OPERATOR_IDENTITY (Blue / Eric Allione / Options Alchemy)
3. BEHAVIORAL_CONSTRAINTS (modeled on aigamma.com's behavior.mjs)
4. SITE_DEFINITIONS (25Δ risk reversal, VRP sign convention)
5. TOOLS_BLOCK or NO_TOOLS_BLOCK
6. TIME AND MARKET SESSION (per-turn, current ET, session label)

The static prefix (1-5) is wrapped in a cache_control: ephemeral block so
Anthropic's prompt cache reuses it across turns in the 5-minute sliding
window. The temporal block sits after the cache breakpoint so it can
change per turn without busting the cache. The same cache_control sits on
the last tool definition.

## Memory model

**Short-term.** `src/memory.js loadShortTermContext()` pulls the last
`SHORT_TERM_CONTEXT_TURNS` (default 12) messages from the channel within
`SHORT_TERM_CONTEXT_MINUTES` (default 60), oldest-first, for the
Anthropic messages array. Multi-user channels prefix user content with
the Discord display name (`[Blue]: ...`).

**Long-term.** Every turn writes a user message + assistant message + a
turn audit row to SQLite. The background embedder (`src/embedder.js`)
ticks every 10 seconds: it embeds pending user messages (Voyage,
`voyage-3`, 1024-dim, batches of 32) and syncs embedded rows into the
Supabase `discord_chat_memory` table indexed with HNSW over cosine
distance.

**Search.** `src/tools/searchChatHistory.js` first tries the
`search_discord_memory` RPC (HNSW lookup); on RPC failure or when
Supabase is unconfigured, falls back to `src/embeddings.js`'s
`cosineSimilarity()` over `iterEmbeddedUserMessages()`. The model sees
the same interface; the `backend` field in the response identifies which
path served the query.

## Tools

Registered in `src/tools/index.js`. Each module exports `{ spec, execute
}`. The registry only adds modules whose backend is configured: Supabase
modules require `SUPABASE_*`, memory modules require `VOYAGE_API_KEY`,
DuckDB modules require attached shards.

Tool catalog:

- `get_vix_family_latest` — Supabase `vix_family_eod`
- `get_iv_percentile` — Supabase `daily_volatility_stats`
- `get_gex_levels` — Supabase `ingest_runs` + `computed_levels`
- `get_spx_term_structure` — Supabase `expiration_metrics`
- `get_stock_history` — Supabase `daily_eod`
- `get_gex_history` — Supabase `daily_gex_stats`
- `search_chat_history` — pgvector RPC (or SQLite fallback)
- `query_duckdb` — backtester shards via @duckdb/node-api
- `web_search` — Anthropic native (`web_search_20250305`)
- `web_fetch` — Anthropic native (`web_fetch_20250910`)

## DuckDB shard integration

`src/duckdb.js` probes `BACKTESTER_DATA_DIR` (default
`C:/aigamma-backtester/data`) for any of:

- `option_chains_eod.duckdb`
- `index_history.duckdb`
- `stocks_history.duckdb`
- `derived.duckdb`

Each present shard is ATTACHed read-only into a single in-memory carrier
database. The bot's connection cannot write to the shards (DuckDB
enforces the READ_ONLY attach). When no shards exist, `query_duckdb` is
not registered and the bot starts cleanly.

`runSelect(sql)` enforces:
- single-statement (no semicolon-separated multi-statement)
- WITH or SELECT prefix only
- keyword blocklist: INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, ATTACH,
  DETACH, PRAGMA, COPY, EXPORT, IMPORT, TRUNCATE, GRANT, REVOKE, SET
- function-name blocklist: read_csv/read_csv_auto, read_parquet,
  parquet_scan, parquet_metadata, parquet_schema, read_json/read_ndjson,
  read_text, read_blob, read_xml, glob, sniff_csv, copy_database,
  load_extension, install_extension — these would otherwise let a
  prompt-injected SELECT exfiltrate arbitrary files (`SELECT * FROM
  read_csv('/etc/passwd')`).
- engine-level lockdown: `SET enable_external_access = false` plus
  `SET lock_configuration = true` are applied to the DuckDB connection
  AFTER the shards are attached, so file-reading table functions are
  refused at the engine even if the regex misses one.
- 30-second timeout via `connection.interrupt()` if available
- 1000-row result cap

## Storage

**SQLite** at `data/conversation.db` (path overridable). WAL mode,
foreign keys on, idempotent migrations tracked in `schema_meta`. Tables:

- `messages` (id, channel_id, guild_id, user_id, username, discord_message_id, role, content, model, tool_uses, token counters, cost, latency, embedding BLOB, embedding_model, created_at)
- `turns` (audit: per-turn token usage, cost, latency, stop reason, error, FK to messages)
- `pgvector_sync` (which embedded rows have been pushed to Supabase)
- `feedback` (👍/👎 reactions on assistant messages)
- `user_notes` (per-user persistent context from /remember)
- `channel_cutoffs` (non-destructive /forget cutoff per channel — context loader filters before this timestamp)
- `schema_meta` (migration tracker)

Migrations 001 messages → 002 turns → 003 pgvector_sync → 004 feedback →
005 user_notes → 006 channel_cutoffs. Idempotent on the schema_meta
name list, so re-running on an existing store is a no-op.

**Supabase pgvector** at `discord_chat_memory` (1024-dim vector + HNSW
index + cosine distance + UNIQUE constraint on local_id). The bot uses
the project's secret key for the background writer and the search RPC,
and upserts pass `on_conflict=local_id` so re-syncs replace rather than
duplicate. Migration SQL ships at `migrations/discord_chat_memory_001.sql`
(table + RPC) and `migrations/discord_chat_memory_002_unique_local_id.sql`
(the on-conflict key) for fresh deployments.

## Observability

`src/logger.js` — JSON for non-TTY (supervisor ingest), pretty for TTY.
Levels via `LOG_LEVEL`, format via `LOG_FORMAT`. Error instances passed
in `fields.err` auto-flatten to `{name, message, stack}`. Child loggers
carry default fields.

`/health` and `/usage` are the in-Discord observability surfaces.
`/health` shows pid/uptime/RSS, attached shards, embedder queue depth,
pgvector reachability with measured latency, capability on/off flags,
SQLite integrity probe, and tool cache stats. `/usage` shows
turns/cost/tokens/latency aggregated over a window with per-model,
per-tool, feedback up/down, and (when enabled) per-caller daily-cap
breakdowns. Cost includes Anthropic's server-tool charges (web_search
at $10 / 1000 requests) accumulated across all rounds of a turn.

`/admin feedback` (owner-only) shows recent thumbs-down with both the
original question and the bot's reply joined through the turns table,
so the operator can postmortem quality issues without manual log
chasing.

## Lifecycle

`src/lifecycle.js` installs:

- `uncaughtException` handler → log + exit 1
- `unhandledRejection` handler → log + exit 1
- `SIGINT` / `SIGTERM` → drain (30s soft, 45s hard) → onShutdown → exit

Graceful shutdown semantics: `agent.answer()` calls `beginWork()` at the
top and `releaseWork()` on completion/error. Shutdown waits for the
counter to hit zero or the timeout fires, then closes DuckDB, stops the
embedder, and destroys the Discord client.

## Configuration

`src/config.js` reads env once at import; fail-fast on missing required
keys with a clear message naming each missing var. Optional integrations
silently disable when their keys are absent.

Required: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `ANTHROPIC_API_KEY`.
Optional: `SUPABASE_URL`+`SUPABASE_KEY`, `VOYAGE_API_KEY`,
`BACKTESTER_DATA_DIR`, `ENABLE_WEB_SEARCH`, `ENABLE_WEB_FETCH`,
`ANTHROPIC_MAX_TOKENS`, `ANTHROPIC_MODEL`, `SHORT_TERM_CONTEXT_TURNS`,
`SHORT_TERM_CONTEXT_MINUTES`, `SEARCH_MIN_SIMILARITY`,
`RATE_LIMIT_REQUESTS_PER_MINUTE`, `CONVERSATION_DB_PATH`, `LOG_LEVEL`,
`LOG_FORMAT`.

## Tests

`test/*.test.js` via `node --test` (no external runner). 78 tests
covering pricing math, rate limiter semantics, cosine + blob roundtrip,
prompt composition, SQL guard, progress reporter, budget, memory
persistence, tool cache, user notes, backup, and Supabase retry
predicates. No live API calls; SQLite-touching tests use per-process tmp
stores. Runs in ~3s. `npm test`.

`.github/workflows/test.yml` runs the suite on every push to main and
every PR, plus a `node --check` pass over every source module.

## Deployment

`Dockerfile` is a multi-stage build: deps stage runs `npm ci --omit=dev`
against node:22-bookworm-slim, runtime stage copies just node_modules
plus source plus migrations plus license into a clean image and runs as
a non-root user. `compose.yml` mounts `./data` for the SQLite store and
sets `LOG_FORMAT=json` explicitly. CMD is `node
--env-file-if-exists=.env.local src/index.js` so the container starts
cleanly when secrets are injected via the orchestrator rather than a
mounted file.

## Style discipline

The bot's voice must match aigamma.com's chat constraints byte for byte.
No opening preambles. No flattery. No closing hooks. No em-dashes,
quotation marks (unless requested), bullets, emojis, metaphors,
analogies. Final sentence always declarative. Silence is an acceptable
ending. The audience needs signal, not affirmation.

The system prompt enforces this and is itself audited by `test/prompt.test.js`.

## Data licensing

Inherited from aigamma.com's vendor agreement with Massive. The bot
redistributes only **computed** outputs: percentile ranks, GEX,
term-structure points, regime labels, derived ratios. Raw per-strike IV
grids, per-contract Greeks, and raw bid/ask never leave the data layer.
The shipped tools respect this boundary by construction. Do not modify
them to return raw chain data.

## Forking guidance

`src/prompt.js OPERATOR_IDENTITY` is the per-deployment identity block;
fork operators should swap their own identity in place. `src/tools/` is
the pluggable surface — replace the Supabase-backed modules with your
own data tools, keep `searchChatHistory.js` and `queryDuckdb.js` as
optional layers, update `src/prompt.js` TOOLS_BLOCK if your tool catalog
diverges. The Discord wiring, agent loop, memory layer, observability,
and lifecycle are domain-agnostic and need no changes for a fork.
