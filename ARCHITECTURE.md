# Architecture

A deep technical reference for the Strategic Trading Discord Bot. Read this after the README (which is user-facing) and the CLAUDE.md (which is the canonical short-form architectural summary). This document is the long-form companion: where every module sits, what every request flow looks like, what every storage layer holds.

Companion documents:

- `README.md` — user-facing setup + capability tour.
- `CLAUDE.md` — short-form architecture reference (the same shape as this document, condensed).
- `DATA_CONTRACTS.md` — the schema contracts the bot expects from Supabase, DuckDB shards, Voyage, and Anthropic. **Read this before swapping any data source.**
- `SECURITY.md` — threat model + secrets posture.
- `CONTRIBUTING.md` — fork workflow + style.

---

## Mission

The bot is a desk-mate for a small, closed community of practitioners — market makers, options traders, hedge fund managers, investment bankers. The audience is technical and time-pressured. They want fast, sourced, opinionated answers about regime, structure, entry, exit, sizing, and tactical positioning. They do not want disclaimers, hedges, preambles, or analogies.

Concretely the bot must:

1. **Reason** like a senior practitioner — direct, sourced from live data, no preambles, no closing hooks, declarative final sentences.
2. **Remember the short term** — the last several turns in the same channel, so a follow-up like "and how does that compare to last week?" makes sense without re-stating context.
3. **Recall the long term** — semantic search across every prior Q&A in the persisted store, so a question that's been answered before doesn't get re-answered from scratch.
4. **Reach for tools** — call live-market-data tools (VIX family, IV percentile, GEX levels, term structure, etc.) when the question turns on a current number; refuse to invent numbers.
5. **Stay accurate** — surface holidays, early closes, null fields as null (not zero), refusals as refusals, truncations as truncations.

The voice is enforced by the system prompt in `src/prompt.js`, audited by `test/prompt.test.js`. Do not weaken those assertions.

---

## High-level architecture

```
                          ┌────────────────────┐
                          │  Discord users     │
                          │  (slash + @bot)    │
                          └─────────┬──────────┘
                                    │
                          ┌─────────▼──────────┐
                          │  bot.js            │
                          │  (discord.js v14   │
                          │   client + router) │
                          └─────────┬──────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                │                   │                   │
        ┌───────▼───────┐  ┌────────▼────────┐  ┌──────▼──────┐
        │  agent.js     │  │  summarize.js   │  │  admin.js   │
        │  (tool-use    │  │  (dedicated     │  │  (owner-    │
        │   loop)       │  │   summary path) │  │   gated ops)│
        └───────┬───────┘  └────────┬────────┘  └──────┬──────┘
                │                   │                   │
                └───────────────────┼───────────────────┘
                                    │
                          ┌─────────▼──────────┐
                          │  Anthropic SDK     │
                          │  (Sonnet/Opus/     │
                          │   Haiku + tools)   │
                          └─────────┬──────────┘
                                    │
       ┌───────────────┬────────────┼────────────┬──────────────────┐
       │               │            │            │                  │
┌──────▼─────┐  ┌──────▼─────┐  ┌───▼───┐  ┌─────▼────┐  ┌──────────▼─────────┐
│  Supabase  │  │  pgvector  │  │ Local │  │  DuckDB  │  │  Anthropic native  │
│  market    │  │  HNSW      │  │SQLite │  │  shards  │  │  web_search /      │
│  data      │  │  search    │  │       │  │ (R/O)    │  │  web_fetch         │
└────────────┘  └────────────┘  └───────┘  └──────────┘  └────────────────────┘
```

Every component is opt-in by configuration:

- **Supabase** (`SUPABASE_URL` + `SUPABASE_KEY`) enables eight market-data tools and the pgvector long-term memory mirror.
- **Voyage** (`VOYAGE_API_KEY`) enables the embedder and semantic search.
- **DuckDB shards** (any `*.duckdb` file at `BACKTESTER_DATA_DIR`) enables `query_duckdb`.
- **Anthropic web tools** (`ENABLE_WEB_SEARCH`, `ENABLE_WEB_FETCH`) enable Anthropic's server-side web tools.

A deployment with none of these still runs — the bot becomes a tool-free conversational model with short-term memory only. The `/about` surface reflects which integrations are live.

---

## Module map

Every file in `src/` and what it owns:

| File | Responsibility |
|---|---|
| `index.js` | Entry point. Reads config, attaches DuckDB shards, builds Discord client, starts the embedder + health server, installs the lifecycle handlers, logs in. Top-level await. |
| `config.js` | Loads + validates `process.env` once at import time. Fail-fast on missing required keys. Coerces optional numeric env vars with bounded ranges. Optional integrations silently disable when their keys are absent. |
| `bot.js` | The Discord client. Slash command router, `@mention` handler, reaction (feedback) handler, shard event hooks. Calls `agent.answer()`, `summarize()`, `admin.*`, `memory.*` and renders responses. |
| `agent.js` | The Anthropic tool-use loop. Builds the system prompt (with cache breakpoint), assembles the messages array (short-term context + current question), calls `client.messages.stream`, executes tool blocks, persists user + assistant + turn audit. |
| `summarize.js` | A bypass agent path with its own system prompt for `/summarize`. Streaming, retried, audited the same way as the main agent. |
| `admin.js` | Owner-gated operations: `rebuild-embeddings`, `backup`, `reset-rate-limit`, `feedback report`. Gated on `OWNER_DISCORD_USER_ID`. |
| `prompt.js` | Composes the system prompt from named blocks. Includes the NYSE holiday calendar for the temporal block (2026-2027 + early closes). Exports `_buildTemporalContextForTest` for unit tests. |
| `anthropicRetry.js` | `withAnthropicRetry` — single retry authority for the Anthropic SDK calls. Three attempts with 1s/3s/8s backoff. Retries on HTTP 408/429/500/502/503/504/529 and on socket-level errors (ECONNRESET, ETIMEDOUT, APIConnectionError, undici cause-chain codes). |
| `memory.js` | SQLite reads/writes via prepared statements. Persistence (`persistMessage`, `persistTurn`), short-term context loader, embedding bulk writes, pgvector-sync helpers, user notes CRUD, usage aggregates, feedback CRUD, channel export. Owns every prepared statement against the DB. |
| `db.js` | Opens the SQLite file at `CONVERSATION_DB_PATH` (default `./data/conversation.db`), runs WAL/synchronous PRAGMAs, applies idempotent migrations tracked in `schema_meta`. Singleton: imported once, exported as `db`. |
| `embeddings.js` | Voyage REST client. Batch input (32 per call), single retry on transient failures (5xx, 429, network), Float32 ↔ Buffer helpers, cosine similarity. |
| `embedder.js` | Background worker. Every 10s: embed pending user messages (batch up to 32), then sync any locally-embedded rows to the Supabase `discord_chat_memory` pgvector mirror (batch up to 64). Failure counters split by side (embed vs sync). |
| `pgvector.js` | Supabase pgvector wrapper. Bulk upsert, HNSW search RPC, full-wipe (for `/admin rebuild-embeddings`), reachability probe. |
| `supabase.js` | Thin PostgREST wrapper for the market-data tools. Single retry on transient errors with a fixed 400ms backoff. Exports `isTransientError` and `isTransientStatus` so tests can pin the actual predicates. |
| `duckdb.js` | Read-only attach of the backtester shards (option_chains, index_history, stocks_history, derived). Triple-guard on `runSelect`: SELECT/WITH-only with keyword blocklist, function-name deny list, engine-level `enable_external_access=false` + `lock_configuration=true`. FIFO mutex serializes concurrent calls. |
| `pricing.js` | Per-model per-token pricing for the cost audit. Plus per-request pricing for Anthropic server-side tools (web_search at $10/1000 requests). Exports `isModelPriced` so startup can warn on an unknown model. |
| `rateLimiter.js` | Per-user sliding-window rate limit (10/min default). In-memory Map; cleared every minute. `RATE_LIMIT_REQUESTS_PER_MINUTE` env var. |
| `budget.js` | Per-user daily cost cap. Reads `SUM(cost_usd)` from `turns` since UTC midnight. Off by default; on when `DAILY_USER_COST_CAP_USD > 0`. |
| `lifecycle.js` | Process lifecycle. `beginWork()/releaseWork` in-flight counter. `installLifecycle({onShutdown})` registers `SIGINT`/`SIGTERM` handlers with a 30s drain timeout + 45s hard kill. Also `uncaughtException` and `unhandledRejection` → log + exit. |
| `logger.js` | Tiny structured logger. JSON for non-TTY (supervisor ingest), pretty for TTY. Auto-flattens `Error` instances at every level. `LOG_LEVEL` and `LOG_FORMAT` env vars. |
| `healthServer.js` | Optional HTTP `/healthz` for orchestration probes. Off by default; on when `HEALTH_PORT` is set. Returns 200 only when SQLite reachable + Discord shard connected + not draining; 503 otherwise. |
| `backup.js` | Online SQLite backup primitive via `VACUUM INTO`. Used by both the `npm run backup` CLI and `/admin backup`. Retention: keep N most recent backups, delete older. |
| `progressReporter.js` | Debounced Discord-edit dispatcher. Streams partial assistant text into a Discord message, debounced to stay under Discord's ~5 edits/sec ceiling. Serialized via an `inFlight` flag so a slow edit can't spawn a concurrent edit. |
| `textChunks.js` | Two pure helpers: `chunk(text)` splits long text at blank-line/newline/space boundaries (Discord's 2000-char cap), `formatUsd(n)` renders cents/dollars safely against NaN/Infinity. |
| `toolCache.js` | In-process LRU+TTL cache for tool results. Keyed on `(toolName, canonicalized input)`. Per-tool TTL overrides via `TOOL_TTLS` in `tools/index.js`. FIFO eviction at 256 entries. |
| `tools/index.js` | Tool registry. Gates modules on backend configuration (SUPABASE_MODULES require Supabase, MEMORY_MODULES require Voyage, DUCKDB_MODULES require attached shards). `executeTool` wraps the actual call with cache, undefined coercion, and warn-level error logging. |
| `tools/*.js` | One file per tool. Each exports `{ spec, execute }`. `spec` is the Anthropic tool definition (name, description, input_schema). `execute(input)` runs when the model picks the tool. See **Tool catalog** below. |

---

## Turn lifecycle

The flow of a single user question end-to-end:

```
Discord user types `/ask question:...`
  → bot.js InteractionCreate handler
  → handleSlashCommand → handleAsk
  → check rate limit (per user, 10/min sliding window)
  → check budget (if DAILY_USER_COST_CAP_USD set)
  → interaction.deferReply()
  → createProgressReporter for streaming Discord edits
  → answer({channelId, guildId, userId, ...})
      [agent.js]
      → beginWork() — register with the in-flight counter
      → loadShortTermContext(channelId)
          [memory.js]
          → SELECT id, user_id, username, role, content
            FROM messages
            WHERE channel_id = ? AND created_at >= ?
            ORDER BY created_at DESC, id DESC LIMIT ?
          → honor /forget cutoff (channel_cutoffs table)
          → reverse for oldest-first
          → prefix multi-user rows with `[username]:`
      → loadUserNotesAsBlock(userId, username)
          [memory.js]
          → SELECT content FROM user_notes WHERE user_id = ?
            ORDER BY created_at ASC, id ASC
      → buildSystemPrompt({userNotesBlock})
          [prompt.js]
          → CORE_PERSONA + OPERATOR_IDENTITY + BEHAVIORAL_CONSTRAINTS
            + SITE_DEFINITIONS + TOOLS_BLOCK
            (cache_control: ephemeral marker here)
            + [TIME AND MARKET SESSION] (with NYSE holiday calendar)
            + [NOTES FOR THIS ASKER] (if user notes exist)
      → assemble messages array:
          [...historical, {role: 'user', content: prefixed_question}]
      → for round 0..MAX_TOOL_ROUNDS (8):
          → withAnthropicRetry(async () => {
              stream = client.messages.stream({system, tools, messages, model, max_tokens})
              stream.on('text', (delta, snapshot) => {
                runningText = roundStart + (roundStart ? '\n' : '') + snapshot
                onProgress(runningText)  // debounced Discord edit
              })
              return await stream.finalMessage()
            })
          → accumulateUsage(usage, response.usage)
          → if stop_reason === 'pause_turn':
              messages.push({role: 'assistant', content: response.content})
              continue
          → if stop_reason !== 'tool_use':
              finalText = runningText.trim()
              break
          → messages.push({role: 'assistant', content: response.content})
          → record any server_tool_use blocks (web_search/web_fetch) for audit
          → toolResults = await Promise.all(tool_use_blocks.map(async block => {
              // privacy clamp on search_chat_history's guild_id/channel_id
              return await executeTool(block.name, block.input)
            }))
          → messages.push({role: 'user', content: toolResults})
      → if stop_reason === 'rounds_exceeded': append truncation note
      → if stop_reason === 'max_tokens': append truncation note
      → if stop_reason === 'refusal': append refusal note
      → if empty: logger.warn('agent produced empty assistant text')
      → persistMessage(user) → returns userMessageId
      → persistMessage(assistant, with toolUses + usage + cost) → returns assistantMessageId
      → persistTurn(userMessageId, assistantMessageId, stopReason, ...)
      → releaseWork() — clear from in-flight counter
      → return {text, cost, latency, model, assistantMessageId}
  → bot.js:
      → text = result.text || '_(no response)_'
      → chunk(text) → array of ≤2000-char strings
      → reporter.finalize(parts[0]) — land the first chunk
      → attachDiscordMessageId(result.assistantMessageId, sentReply.id)
      → for i in 1..parts.length: interaction.followUp(parts[i])

Meanwhile (asynchronously, every 10s):
  embedder.tick()
    → getPendingEmbeddings(32) — rows with embedding=NULL, role='user', len(content)>=4
    → embed(texts) — Voyage batch call (with 1-attempt retry on transient errors)
    → setEmbeddingBulk(writes) — single SQLite transaction for the whole batch
    → getPendingPgvectorRows(64) — rows with embedding but no pgvector_sync entry
    → upsertChatMemory(payload) — Supabase POST with on_conflict=local_id
    → markSyncedBulk(localIds) — single SQLite transaction

Meanwhile (every reaction):
  bot.js MessageReactionAdd/Remove handler
    → reaction.fetch() if partial
    → reaction.message.fetch() if partial (otherwise author is null)
    → findAssistantMessage(reaction.message.id)
    → recordFeedback({assistantMessageId, userId, sentiment, emoji}) or removeFeedback
```

The agent loop is the only path that calls Anthropic. Every other surface (admin, summarize, embedder, search, reaction handler) either reads SQLite directly or calls a different external service.

---

## Memory model

Two-layer memory, designed so the model never sees pages of irrelevant history but can recall by meaning when relevant.

### Short-term context (SQLite, every turn)

`memory.js loadShortTermContext` pulls up to `SHORT_TERM_CONTEXT_TURNS` (default 12) messages from the same channel within `SHORT_TERM_CONTEXT_MINUTES` (default 60). Oldest-first, prepended to the Anthropic messages array. Honors per-channel `/forget` cutoffs (the `channel_cutoffs` table) — `/forget` writes a timestamp; subsequent loads filter out anything older.

For multi-user channels, each user message is prefixed with `[displayName]:` so the model can attribute speakers correctly. DMs and slash commands skip the prefix.

### Long-term recall (Voyage + Supabase pgvector + SQLite fallback)

Every persisted user message (length ≥ 4) is embedded by the background embedder using `voyage-3` (1024 dims). The local SQLite row's `embedding` column holds the Float32 buffer. The embedder then upserts the embedded row into Supabase's `discord_chat_memory` table — a pgvector HNSW index over cosine distance.

When `search_chat_history` runs, it tries the pgvector RPC first (HNSW lookup). On RPC failure or when Supabase is unconfigured, it falls back to a full-scan cosine over `iterEmbeddedUserMessages()` (filtered by channel/guild in SQL). The model sees the same interface; the `backend` field in the response identifies which path served the query.

### User notes (opt-in, persistent context per user)

`/remember <note>` writes to the `user_notes` table (cap of 12 notes × 280 chars per user). Every turn's system prompt embeds a `[NOTES FOR THIS ASKER]` block — but **only after** the cache breakpoint, so per-user notes don't bust the shared cached prefix.

---

## Storage

### SQLite (`data/conversation.db`, WAL mode)

Path overridable via `CONVERSATION_DB_PATH`. WAL mode, synchronous=NORMAL, foreign keys on. Migrations are idempotent and tracked in `schema_meta` by name. Bumping the schema is appending a new entry to the `migrations[]` array in `db.js`; previously-run migrations are skipped.

Tables:

| Table | Purpose |
|---|---|
| `messages` | Every user, assistant, and (potentially future) system message. Carries `embedding` (BLOB), `embedding_model`, tool_uses (JSON), token counts, cost, latency. |
| `turns` | Per-turn audit log. Links `user_message_id` to `assistant_message_id`, with `stop_reason`, `tool_rounds`, token usage, cost, latency, error. |
| `pgvector_sync` | Which embedded local rows have been mirrored to Supabase pgvector. A missing row means "needs sync." |
| `feedback` | 👍/👎 reactions on assistant messages. `UNIQUE(assistant_message_id, user_id)` so a user's vote replaces, not appends. |
| `user_notes` | Per-user persistent context (`/remember`). |
| `channel_cutoffs` | Non-destructive `/forget` cutoffs per channel. Older messages stay searchable but don't load into short-term context. |
| `user_preferences` | Per-user `/model` preference (one row per user). Stores a short label (`sonnet`/`opus`/`haiku`) rather than the full model id; resolved at runtime via `MODEL_CHOICES` in `src/bot.js`. |
| `schema_meta` | Migration tracker. |

Indexes:

- `idx_messages_channel_time` on `(channel_id, created_at DESC)` — short-term context loader.
- `idx_messages_user_time` on `(user_id, created_at DESC)` — per-user message lookups.
- `idx_messages_embedding_pending` partial on `id WHERE embedding IS NULL AND role='user'` — embedder pending query.
- `idx_messages_discord_id` partial on `discord_message_id WHERE role='assistant' AND discord_message_id IS NOT NULL` — reaction lookup.
- `idx_turns_channel_time` on `(channel_id, created_at DESC)`.
- `idx_turns_user_message` on `user_message_id` — for the embedder's LEFT JOIN turns query.
- `idx_turns_assistant_message` on `assistant_message_id` — same.
- `idx_turns_user_time` on `(user_id, created_at DESC)` — budget-cap query.
- `idx_user_notes_user` on `(user_id, created_at DESC)`.
- `idx_feedback_sentiment` on `(sentiment, created_at DESC)`.

### Supabase pgvector (`discord_chat_memory`)

Pure read-mirror of the locally-embedded `messages` rows. 1024-dim vector column, HNSW index over cosine distance, `UNIQUE(local_id)` for upsert idempotency, RLS configured per the operator's preference. Migration SQL ships at `migrations/discord_chat_memory_001.sql` (table + RPC) and `migrations/discord_chat_memory_002_unique_local_id.sql` (the unique constraint the on-conflict relies on).

Apply both in order via `psql` or the Supabase SQL editor.

### DuckDB shards (read-only attach)

Four optional shards at `BACKTESTER_DATA_DIR`:

- `option_chains_eod.duckdb`
- `index_history.duckdb`
- `stocks_history.duckdb`
- `derived.duckdb`

The bot attaches each present shard read-only into an in-memory carrier database. Engine-level lockdown (`enable_external_access=false`, `lock_configuration=true`) is applied **after** the attach so DuckDB's file-reading table functions (`read_csv`, `read_parquet`, `glob`, etc.) cannot be reached by a prompt-injected `SELECT`.

See **DATA_CONTRACTS.md** for the exact table schemas an external puller must provide. The bot itself never writes to the shards; the attach is `READ_ONLY`.

---

## Tool catalog

Eleven tools, gated by backend availability:

| Tool | Backend | When to call |
|---|---|---|
| `get_vix_family_latest` | Supabase `vix_family_eod` | Current VIX, VVIX, term structure (VIX3M:VIX), cross-asset vol (VXN/RVX/OVX/GVZ), skew (SDEX/TDEX). EOD freshness. |
| `get_iv_percentile` | Supabase `daily_volatility_stats` | SPX 30-day IV ranked over a chosen lookback (default 252 days), realized vol, VRP. |
| `get_gex_levels` | Supabase `ingest_runs` + `computed_levels` | Live SPX dealer-positioning levels: Vol Flip, Call Wall, Put Wall, put/call ratios. 5-min intraday freshness during market hours. |
| `get_spx_term_structure` | Supabase `expiration_metrics` | Per-expiration ATM IV + 25Δ put/call IV across the chain. Latest intraday run. |
| `get_stock_history` | Supabase `daily_eod` | Single-ticker OHLC history with derived returns. |
| `get_gex_history` | Supabase `daily_gex_stats` | SPX dealer-gamma daily series with percentile rank. |
| `get_realized_correlations` | Supabase `daily_eod` | Pairwise realized correlation matrix over a basket (default sector ETFs). |
| `get_vrp_history` | Supabase `daily_volatility_stats` | Variance risk premium time series + summary stats + negative-VRP day count. |
| `search_chat_history` | pgvector RPC → SQLite fallback | Semantic recall across persisted past conversations. Agent layer forces the caller's `guild_id` and `channel_id` to prevent cross-guild leakage from prompt injection. |
| `query_duckdb` | DuckDB shards | Raw SQL access for multi-year option-chain, index, stock, and derived feature tables. Triple-guarded SELECT-only. |
| `web_search` / `web_fetch` | Anthropic native | Current events, news, paper content. Billed per-request via Anthropic's `server_tool_use` usage. |

Per-tool cache TTLs (`tools/index.js TOOL_TTLS`):

- Live intraday: 30s (`get_gex_levels`, `get_spx_term_structure`)
- Daily EOD: 300s (`get_vix_family_latest`, `get_iv_percentile`)
- Historical: 600s (`get_stock_history`, `get_gex_history`, `get_realized_correlations`, `get_vrp_history`)
- Search: 30s (`search_chat_history`)
- DuckDB: 60s (`query_duckdb`)

---

## Concurrency model

Single-process Node 22+. No clustering, no worker threads. The Node event loop handles:

- One Discord client (single-shard for the bot's expected scale).
- N concurrent `agent.answer()` calls, each driving its own Anthropic stream.
- The background embedder timer firing every 10s.
- The health HTTP server (if enabled).

What's serialized:

- **SQLite writes**: node:sqlite is synchronous. JS single-threaded → one write at a time regardless of caller. WAL allows concurrent readers around a writer.
- **DuckDB queries**: `runSelect` uses a FIFO mutex so two parallel `query_duckdb` tool_uses can't race the shared connection.
- **Progress reporter Discord edits**: `inFlight` flag serializes edits per reporter; a slow edit doesn't spawn a concurrent one.
- **Embedder ticks**: a `running` flag means tick() is a no-op if another tick is in flight.

What's parallelized:

- **Tools within a round**: the agent loop's `Promise.all(tool_use_blocks.map(executeTool))` runs every tool in a single model round concurrently. Supabase reads are independent, so a five-tool round costs one round-trip's worth of wall time.

---

## Lifecycle and graceful shutdown

`installLifecycle({onShutdown})` registers:

1. `uncaughtException` → log + `process.exit(1)`.
2. `unhandledRejection` → log + `process.exit(1)`.
3. `SIGINT` / `SIGTERM` → drain (30s soft / 45s hard) → `onShutdown()` → `process.exit(0)`.

The drain waits for `inFlightCount() === 0` (or the timeout fires). `agent.answer()` and `summarize()` both wrap themselves in `beginWork()` / `releaseWork()`. So a SIGTERM mid-turn lets the turn finish (up to 30s), then closes DuckDB, stops the embedder, destroys the Discord client.

A second SIGINT/SIGTERM bypasses the drain and exits immediately.

---

## Observability

Two operator-facing surfaces:

### `/health` (in-Discord)

- pid, uptime, RSS
- Total messages persisted
- Embed pending count + sync pending count
- Embedder embed/sync failure counters (split — different remediation paths)
- Total embedded + total synced
- Supabase pgvector reachability + latency
- Voyage enabled state + model
- Web search/fetch enabled flags
- Attached DuckDB shards (name + size + mtime)
- Tool cache stats (entries, hit rate, hits/misses)
- SQLite integrity probe (PRAGMA integrity_check)
- Lifecycle state (running vs shutting-down) + in-flight counter

### `/usage hours:N`

Cost + token + latency rollup over a window. Includes:

- Total turns, cost, input/output/cache-read tokens.
- Avg/p50/p95 latency (R-7 linear-interpolation percentile).
- Prompt cache hit ratio (cache_read / total_input).
- By-model and by-tool breakdowns.
- Feedback up/down counts.
- Owner-only: per-user spend breakdown.
- If budget enabled: caller's daily cap headroom.

### `/admin feedback hours:N`

Recent 👍/👎 reactions with the original question + the bot's reply joined through the turns table. Lets the operator postmortem quality issues without scraping the audit log.

### Postmortem report (CLI)

`npm run postmortem -- --hours 168` aggregates the audit log + feedback over a window. Outputs plain text suitable for piping to a file. Uses the same R-7 percentile helper as `/usage` so the two surfaces never disagree.

### Logger

`logger.js` writes JSON for non-TTY (supervisor ingest) and pretty for TTY. Error instances passed in `fields.err` auto-flatten to `{name, message, stack}` at every log level. Levels via `LOG_LEVEL`, format override via `LOG_FORMAT`.

---

## Retry posture

Every external call has a defined retry policy:

| Call | Retries | Backoff | Transient predicate |
|---|---|---|---|
| Anthropic (agent + summarize) | 3 | 1s / 3s / 8s | HTTP 408/429/500/502/503/504/529 + socket-level errors (ECONNRESET, ETIMEDOUT, APIConnectionError, undici cause-chain) |
| Anthropic SDK internal retry | 0 (disabled) | — | `withAnthropicRetry` is the single authority — stacked retries could blow past Discord's 15-min deferReply ceiling |
| Voyage embed | 1 | 500ms | HTTP 408/429/500/502/503/504 + socket codes |
| Supabase REST | 1 | 400ms | HTTP 502/503/504/408 + AbortError + socket codes |
| Supabase pgvector RPC | 0 (fallback to SQLite cosine) | — | search has a redundant path; no retry needed |
| Supabase pgvector upsert | 0 (embedder retries next tick) | — | 10s tick is a natural retry cadence |

Anthropic request timeout pinned at 4 min per attempt — three attempts + backoffs fit under Discord's 15-min deferReply ceiling.

---

## Cost accounting

`pricing.js` carries per-million-token rates for input, output, cache-write, and cache-read across the three supported models. Plus per-request rates for Anthropic's server-side tools (`web_search` at $10/1000 requests).

`agent.js` accumulates `usage` across all rounds of a turn (including `server_tool_use` counts) and writes the final `cost_usd` to both the assistant `messages` row and the `turns` row. `/usage` aggregates from `turns`. Budget enforcement reads `SUM(cost_usd) WHERE user_id = ? AND created_at >= ?` since UTC midnight.

If the configured model is not in `PRICING`, the bot logs a warn at startup and records `null` for cost — operator must add the entry or fix the model id.

---

## Style discipline

The bot's voice is enforced by the system prompt in `src/prompt.js`. Key constraints:

- No opening preambles ("Great question", "Absolutely", "I'd be happy to help" — all banned).
- No flattery or compliments on the user's reasoning.
- No em-dashes, no bullets, no emojis, no analogies, no metaphors.
- Final sentence is always a declarative statement of fact.
- Never invent prices, levels, or readings; always call a tool for a current number.
- Never append disclaimers about financial advice or market risk.

These are pinned by `test/prompt.test.js`. Fork operators who want a different voice should re-author the `BEHAVIORAL_CONSTRAINTS` block and update the test assertions in lockstep.

---

## Snap in your own data

To use this bot without aigamma's data layer, see **DATA_CONTRACTS.md** for the table and shard schemas the bot expects. Three layers to swap or omit:

1. **Supabase market-data tables** — replace with your own provider (or omit entirely; the bot runs in tool-free conversational mode).
2. **Voyage embeddings** — commodity service, just provide an API key.
3. **DuckDB backtester shards** — point `BACKTESTER_DATA_DIR` at any directory of `*.duckdb` files matching the schemas in DATA_CONTRACTS.md. The bot attaches read-only.

The Discord wiring, agent loop, memory layer, observability, and lifecycle are domain-agnostic and need no changes for a fork.
