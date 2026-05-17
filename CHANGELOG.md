# Changelog

All notable changes to this project are documented here. Order is newest
first within each section. Versioning is incremental; pre-1.0 only.

## Unreleased

### Correctness
- System prompt's market-session label honors the 2026-2027 NYSE
  holiday calendar plus the three early-close days (day before
  Independence Day, day after Thanksgiving, Christmas Eve). The bot
  no longer tells a trader the market is open on Christmas. A warn
  fires once if the calendar's max year is in the past so the
  operator knows to extend it.
- gexHistory, vrpHistory, ivPercentile null-safety pass: numeric
  source columns now surface as null when missing instead of
  coercing through Number(null) === 0. The user-facing misread was
  'SPX closed at 0' on rows where an ingest had landed iv/hv but
  not spx_close.
- Reaction events on partial (uncached) bot messages now fetch the
  message before checking authorship, so feedback on older bot
  replies actually records to the feedback table.
- Empty assistant text now warns rather than persisting silently —
  surfaces upstream prompt-injection / model-issue patterns the
  operator would otherwise have to scan the audit log to find.

### Reliability
- withAnthropicRetry covers network-level errors (ECONNRESET, ETIMEDOUT,
  APIConnectionError, undici cause chains) in addition to HTTP
  status. A transient socket failure no longer hard-fails a turn
  on its first attempt.
- Anthropic SDK maxRetries=0 with our wrapper as the sole retry
  authority. The doubled retry layers could stack to ~9 round-trips
  per agent round on a transient 503; one predictable retry policy
  now bounds total worst-case at ~12.2 min, comfortably under
  Discord's 15-min deferReply window. Per-attempt timeout pinned at
  4 min to match.
- Voyage embed() retries once on transient HTTP (5xx, 429) or
  socket errors. Live /search no longer hard-fails on a single
  Voyage hiccup.
- DuckDB runSelect serialized through a FIFO mutex so two parallel
  query_duckdb tool_uses in one agent round can't race the shared
  connection's internal state.
- Progress reporter serializes Discord edits: a slow edit (rate-
  limit backoff > MIN_EDIT_INTERVAL_MS) no longer spawns a
  concurrent edit on the same message, eliminating self-inflicted
  429s.
- summarize() now participates in the graceful-shutdown drain via
  beginWork/releaseWork. A SIGTERM mid-summary used to cut the
  stream off; now it waits.
- Tool execution failures log at warn level so a systematic
  regression (renamed table, expired key, broken RPC) surfaces in
  logs instead of only as '{error: ...}' to the model.

### Performance
- Migration 009 adds an index on turns(user_id, created_at DESC).
  The budget-cap query (userSpendSince) ran on every gated /ask,
  /summarize, and @mention when DAILY_USER_COST_CAP_USD was set;
  without the index every call full-scanned the turns table.
- Migration 007 adds indexes on turns(user_message_id) and
  turns(assistant_message_id). Every LEFT JOIN turns ... ON
  t.user_message_id = m.id (embedder, recentFeedback, postmortem) was
  a full scan of turns without them — invisible on a fresh store,
  measurable on a long-lived one.
- Migration 008 adds a partial index on messages(discord_message_id)
  WHERE role='assistant'. Every reaction event used to full-scan the
  messages table; now it's a point lookup.
- Embedder's pgvector sync collapses to one SQL query per batch (was
  1 + N for N rows in the batch). The paired assistant reply now
  comes back from the same LEFT JOIN turns→messages select rather
  than a per-row getAssistantRowFor call.
- setEmbedding writes and markSynced inserts now batch into a single
  SQLite transaction per tick (was N separate statements).
- search_chat_history SQLite fallback pushes channel_id / guild_id
  into the SQL filter so a channel-restricted search no longer
  iterates the entire embedded corpus to drop most of it.

### Added
- `/usage` shows a per-user spend breakdown when invoked by the
  owner (cost / turns / tokens, top 8). Surveillance-aware: gated
  by isOwner so non-owners don't see the table; bot uses
  no-ping mentions so the list doesn't notify users.
- `/forget-note number:<n>` removes a single saved note by its 1-based
  number from `/notes` (the existing `/forget-notes` clears all). Wires
  the deleteUserNote backend that previously only the test suite
  exercised.
- `/usage` exposes p50 / p95 latency via linear-interpolation
  percentile alongside the existing avg — surfaces tail behavior that
  the average smooths over.
- `/admin feedback` lines now show which model produced each
  thumbs-up/down so operators can spot model-specific quality patterns
  without cross-referencing the audit log.
- System prompt now defines the dealer-GEX sign convention (positive
  net_gex = long gamma = pinning; negative = short gamma = trending)
  so the model interprets get_gex_levels and get_gex_history outputs
  consistently turn-over-turn.
- Startup warns when the configured Anthropic model has no entry in
  pricing.js — otherwise cost tracking silently records null forever
  and the daily cap never triggers.
- Prompt-cache hit ratio surfaces on `/usage`. Lets operators spot a
  silent cache regression (a moved breakpoint or a varying-per-turn
  prefix) that would otherwise be invisible until the cost ledger
  caught up.
- `/health` shows lifecycle state (running vs shutting-down) plus
  the in-flight turn counter — visible drain progress during a
  rolling restart.
- Logger auto-flattens `Error` instances at every level, not just
  `error()`. Previously a `logger.warn('x', {err: someError})`
  silently rendered `err={}` because Error's enumerable property
  set is empty.
- Per-tool latency stamped on every `tool_uses` entry; `/usage`'s
  by-tool field now reports `avg Xms` and the postmortem script
  ranks tools by their own runtime instead of the round's combined
  network + every-tool latency.
- `withAnthropicRetry` extracted from `agent.js` into its own module
  and now wraps the full stream consumption (creation + finalMessage)
  rather than just the synchronous stream creation. `/summarize`
  flows through it too, so transient Anthropic errors are retried on
  both paths.
- `chunk()` extracted to `src/textChunks.js` with ten regression
  tests for the break-priority and edge-case behavior.
- Twenty-plus new tests pinning the recent null-tail fixes, the
  per-tool latency aggregation, every market-data tool's happy path,
  the SELECT guard against file-reading DuckDB functions, and the
  prompt cache-break marker.
- `/summarize` now streams progressive Discord edits via the
  progressReporter, matching the `/ask` UX.
- `/export` produces a JSON dump of the channel's persisted Q&A as a
  Discord file attachment, with a 24MB size guard against Discord's
  attachment ceiling.
- `/remember`, `/notes`, `/forget-notes`: opt-in per-user notes that
  surface in every future system prompt for that user.
- Operator identity in the system prompt and `/about` now driven by
  `OPERATOR_HANDLE`, `OPERATOR_NAME`, `COMMUNITY_NAME` env vars.
  Defaults preserve the original Blue / Eric Allione / Options Alchemy
  identity. Forkers no longer need to edit source.
- Anthropic native `pause_turn` stop reason now resumes via a fresh
  round; preserves the cross-round accumulator for streaming and
  persistence so multi-round responses store the full answer.
- `web_search_requests` now contributes to per-turn cost in pricing
  ($10 / 1000 requests), accumulated across all rounds. Server-side
  `server_tool_use` blocks (web_search / web_fetch) captured in the
  tool audit log.
- `/usage` picks up per-tool breakdown and per-caller daily-cap
  headroom; `/admin feedback` shows the original question alongside
  the reply for postmortem.
- Migration 005 user_notes; 006 channel_cutoffs (non-destructive
  /forget); pgvector 002 UNIQUE(local_id) for upsert idempotency.
- 3 backup tests, 5 supabase-retry tests, 6 toolCache tests, 8 user
  notes tests, 6 memory tests, 5 budget tests added to the suite.

### Changed
- `/forget` is now non-destructive: writes a per-channel cutoff
  timestamp instead of deleting messages. Old conversations stay
  searchable via `/search`.
- `/search scope:all` clamps to the caller's guild; in DMs it
  silently downgrades to `channel` so cross-DM leakage is impossible.
  Model-driven `search_chat_history` calls are clamped at the agent
  so prompt injection can't widen scope.
- `/admin reset-rate-limit` uses a Discord user picker instead of a
  raw id string.
- `runBackup()` extracted from the script; `/admin backup` calls
  in-process instead of spawning a subprocess.
- All bot-authored messages set `allowedMentions: {parse: [],
  repliedUser: true}` so model output containing `<@id>` or
  `@everyone` doesn't fire notifications.

### Security
- CI gates against high+ npm audit advisories on production deps
  (moderate and below are noise on a 3-dep project; high/critical
  warrant operator attention).
- DuckDB SELECT-only guard extended with a function-name deny list
  (`read_csv`, `read_parquet`, `read_json`, `read_text`, `read_blob`,
  `glob`, `parquet_scan/metadata`, `copy_database`, `load_extension`,
  etc.) so a prompt-injected `SELECT * FROM read_csv('/etc/passwd')`
  can't slip past the keyword guard. Backed by engine-level
  `SET enable_external_access = false` + `SET lock_configuration = true`
  applied after shards attach.

### Fixed
- `beginWork()`'s release closure is now idempotent so an accidental
  double-release can't drop the in-flight counter below the real
  count and let graceful shutdown resolve while turns are still
  running.
- Embedder's `embedTick` defends against Voyage returning fewer
  vectors than requested — skip orphans with a warn log instead of
  throwing on `vecToBlob(undefined)` and losing every valid write in
  the batch.
- Embedder's initial 1-second kick is now cancellable on shutdown
  so a SIGTERM in the first second of process life can't race the
  SQLite close.
- `/admin feedback` truncation note now fires when more than 15
  rows exist (the 15-row display cap was silent before).
- `/notes` paginates so 12 long notes don't exceed Discord's
  2000-char message ceiling.
- `/export` capped at 10000 rows with caller-visible truncation
  notice; previously a high-volume channel would load the entire
  audit log into memory before Discord's attachment cap rejected
  it anyway.
- `/search` 'scanned undefined messages' on the pgvector path is now
  path-aware ('via pgvector_hnsw' vs 'scanned N message(s)').
- `MessageCreate` handler wraps `handleMention` and guards against
  `null` `message.author`; a malformed @mention no longer crashes
  the process or escapes through the error boundary as a noisy
  unhandled-rejection log.
- `searchChatHistory` SQLite fallback explicitly filters NaN
  similarity; a corrupted embedding blob would otherwise slide past
  the `sim < minSim` check (NaN comparisons are always false).
- `stockHistory.latest_close` no longer reports 0 when the tail row
  has a null close (Number(null)===0 foot-gun).
- `realizedCorrelations` drops null/non-positive closes at intake
  and hardens Pearson against NaN / zero variance — previously a
  single bad row poisoned the aggregate.
- `realizedCorrelations` `limit` parameter scales with basket size
  AND lookback; was hardcoded to `basket.length * 400` and silently
  truncated the back half of the basket on long lookbacks.
- `termStructure.max_expirations` clamped to [1, 50] so a model
  passing 99999 can't slam every expiration into one response.
- `ivPercentile` and `gexHistory` no longer report nonsensical
  percentile rank when the most recent ingest left the tail row's
  numeric column null. `Number(null) === 0` silently slid past the
  `Number.isFinite(Number(x))` filter; explicit null guard plus
  fallback to the last row with a usable value.
- `stockHistory.latest_close` no longer reports 0 when the tail row's
  close is null (same Number(null)===0 trap).
- `realizedCorrelations` drops null/non-positive closes at intake and
  hardens Pearson against NaN / zero variance — previously a single
  bad row poisoned the aggregate.
- `/notes` paginates so 12 long notes don't exceed Discord's 2000-char
  message ceiling.
- `/admin feedback` truncation note fires when more than 15 rows
  exist, not just when the 2000-char budget breaks early.
- `searchChatHistory` SQLite fallback explicitly filters NaN
  similarity; a corrupted embedding blob would otherwise slide past
  `sim < minSim` (NaN comparisons are always false).
- Embedder's initial 1-second tick is cancellable so a SIGTERM in the
  first second of process life can't race the SQLite close.
- `/healthz` reflects real Discord shard state. Before this, a
  Kubernetes liveness probe saw 200 while the shard was disconnected
  or reconnecting; orchestrators never rotated traffic away.
- `realizedCorrelations` `limit` parameter scales with basket size
  AND lookback. Was hardcoded to `basket.length * 400`, which silently
  truncated the back half of the basket on the maximum 1260-day
  lookback.
- `/search` no longer prints "scanned undefined messages" on the
  pgvector path. Path-aware status text reports the SQLite scan count
  when applicable and the backend label otherwise.
- `MessageCreate` handler wraps `handleMention` in an error boundary
  matching the other event handlers; a malformed @mention no longer
  becomes an unhandled rejection that exits the process.
- `package.json` scripts and Dockerfile CMD aligned on
  `--env-file-if-exists=.env.local` so operator scripts run inside
  containers with orchestrator-injected env vars instead of throwing
  ENOENT.
- Prompt cache-break marker pinned by test: `prompt.js` and `agent.js`
  must agree on `\n\n[TIME AND MARKET SESSION]` or prompt caching
  silently misses on every turn.
- `progressReporter.finalize` is idempotent; a `cancel()` path stops
  pending edits without landing one.
- In-flight `releaseWork()` guaranteed by a top-level try/finally;
  no longer leaks the drain counter on synchronous setup throws.
- Embedder `running` flag is always reset via outer try/finally,
  even if logger throws.
- Embedder shutdown awaits the in-flight tick before the database
  closes.
- DuckDB shard probe defends against per-file `statSync` failures.
- Slash-command boundary catches unhandled errors and replies with a
  structured message; unknown commands no longer time out silently.
- pgvector mirror rebuild also wipes Supabase rows before re-syncing
  so a partial rebuild doesn't leave duplicates.
- Numeric env vars (ANTHROPIC_MAX_TOKENS, SHORT_TERM_CONTEXT_*,
  SEARCH_MIN_SIMILARITY, DAILY_USER_COST_CAP_USD,
  RATE_LIMIT_REQUESTS_PER_MINUTE) validated against expected ranges.
- /summarize records cost into the turns audit log and enforces rate
  limit + daily cost cap (previously bypassed both).
- Cross-round text accumulator persists the full answer (was: only
  the last round's content blocks).
- Search results filtered by guild_id when scope is server-wide so
  DM rows from other users don't surface.
- Tool calls within a single round execute in parallel.
- Anthropic transient retry list now includes 408 and 504 (matched
  the supabase wrapper).
- `max_tokens` truncation appends an italic hint instead of leaving
  the user with a mid-sentence response.
- Persistence wrapped in try/catch — an audit-log write failure no
  longer hides the reply from the user.

## 0.1.0 — 2026-05-16

### Added — slash commands and surfaces

- `/ask question:<text> model:<sonnet|opus|haiku>?` — agent turn with
  optional per-turn model override.
- `@bot <text>` — mention invocation, same agent path as `/ask`.
- `/search query:<text> scope:<channel|all>?` — semantic recall over
  persisted chat history. Returns Discord deep-links to original
  messages when available.
- `/forget` — clears the channel's short-term context window.
- `/summarize messages:<n>?` — tight brief of the last N channel
  messages (default 100, max 500).
- `/usage hours:<n>?` — ephemeral cost / token / latency summary with
  per-model, per-tool, and feedback breakdowns.
- `/health` — pid, uptime, RSS, attached shards, embedder queue, pgvector
  reachability, capability flags, tool cache stats, SQLite integrity.
- `/about` — capability tour for new community members.
- `/admin` (owner gated) — subcommands `rebuild-embeddings`, `backup`,
  `reset-rate-limit`, `feedback`.
- 👍 / 👎 reactions on assistant messages — persisted to the `feedback`
  table; surfaces in `/usage` and `/admin feedback`.

### Added — tools the model can call

- `get_vix_family_latest` — VIX, VVIX, term structure (VIX/VIX3M),
  cross-asset vol, SDEX/TDEX skew-and-tail-cost pair.
- `get_iv_percentile` — SPX 30-day IV with percentile rank, 20-day
  Yang-Zhang realized vol, variance risk premium.
- `get_gex_levels` — live Vol Flip, Call Wall, Put Wall, P/C ratios.
- `get_spx_term_structure` — per-expiration ATM IV, 25Δ put/call IV.
- `get_stock_history` — single-name and ETF daily OHLC with derived
  return-over-window and drawdown-from-high.
- `get_gex_history` — daily SPX dealer-gamma history with net_gex
  percentile rank.
- `get_realized_correlations` — pairwise Pearson correlation matrix
  over daily log returns across a sector-ETF basket (configurable).
- `get_vrp_history` — variance risk premium time series with summary
  stats and current percentile rank.
- `search_chat_history` — semantic memory recall (pgvector HNSW with
  SQLite cosine fallback).
- `query_duckdb` — read-only SELECT against the aigamma-backtester
  DuckDB shards with single-statement, keyword-blocklist, 30s timeout,
  1000-row cap.
- Anthropic `web_search_20250305` and `web_fetch_20250910` (server-side).

### Added — engineering surface

- Streaming responses with progressive Discord edits via
  progressReporter (800ms debounce, 24-char minimum delta).
- Two-layer memory: short-term (last N turns of the channel within a
  sliding window) loaded on every call; long-term (every Q&A persisted
  to SQLite forever; embedded by Voyage `voyage-3` 1024-dim; mirrored
  into Supabase `discord_chat_memory` with HNSW + cosine).
- Background embedder ticks every 10 seconds, batches up to 32, syncs
  to pgvector after embedding.
- Tool-result cache with per-tool TTL overrides, canonical (name,
  sorted-input) keys, FIFO eviction at 256 entries.
- Per-user sliding-window rate limit (default 10/min).
- Per-user daily cost cap from the turns audit log against
  `DAILY_USER_COST_CAP_USD`; resets at midnight UTC.
- Transient-error retry with 1s/3s/8s backoff against Anthropic
  429/5xx.
- Anthropic prompt cache control on the static system prefix and the
  last tool definition; per-turn temporal block sits outside the cache
  breakpoint.
- Per-channel short-term-context prefix `[displayName]:` for multi-user
  channels so the model can attribute speakers.
- Operator identity block in the system prompt (Blue / Eric Allione /
  Options Alchemy).
- Style discipline lifted byte-for-byte from `aigamma.com`'s
  `behavior.mjs`: no preambles, no flattery, no closing hooks, no
  em-dashes, no bullets in chat, no metaphors. Declarative final
  sentence. Audited by `test/prompt.test.js`.
- Temporal context block in every system prompt (current ET timestamp +
  US-equity-session label) sits outside the cache breakpoint.
- Structured logger (JSON for non-TTY, pretty for TTY) with auto-flatten
  of Error instances passed in `fields.err`.
- Lifecycle handlers: `uncaughtException`, `unhandledRejection`,
  `SIGINT`/`SIGTERM` with in-flight turn drain (30s soft, 45s hard).
- HTTP `/healthz` endpoint on optional `HEALTH_PORT` for container
  orchestration probes.
- Discord-message deep-links in search results
  (`https://discord.com/channels/<guild>/<channel>/<msg>`) when guild,
  channel, and message ids are all present.
- SQLite integrity probe in `/health` via `PRAGMA integrity_check(1)`.
- Per-turn cost audit (input/output/cache_write/cache_read priced per
  model) in the `turns` table.

### Added — infrastructure and ops

- Online SQLite backup via `VACUUM INTO` (`npm run backup`).
- Postmortem report (`npm run postmortem`) reads audit log + feedback
  and prints turn counts, p50/p95 latency, errors, thumbs-down rows
  with question/reply context, and tool ranking.
- ESLint flat config with correctness-oriented rules; runs in CI.
- GitHub Actions workflow runs `npm test` + `npm run lint` + parse-check
  on every push and PR.
- Multi-stage Dockerfile (deps + runtime as non-root user) plus
  compose.yml with host-mounted SQLite volume.
- pgvector migration SQL at `migrations/discord_chat_memory_001.sql`
  for fresh deployments.
- `.nvmrc`, `.editorconfig`, `SECURITY.md`.
- 54 node:test unit tests covering pricing, rate limit, cosine,
  prompt composition, SQL guard, progress reporter, budget cap,
  memory aggregations, tool cache.
- `docs/EXAMPLES.md` — annotated sample interactions with real numbers
  from the live Supabase, showing tactical vs strategic reads,
  cross-asset analysis, memory recall, DuckDB SQL path, and tone
  discipline.
- JSDoc on the most-used public APIs (`agent.answer`,
  `memory.persistMessage`).
- CHANGELOG.md and README.md current with the full feature surface.

### Notes

- Local SQLite remains source of truth for the audit log; Supabase
  pgvector is the search index with HNSW. Search falls back to SQLite
  cosine when Supabase is unreachable so search never goes hard down.
- Vendor data-licensing boundary inherited from aigamma's Massive
  contract: bot redistributes only computed metrics; raw per-strike IV
  grids, per-contract Greeks, and raw bid/ask never leave the data
  layer.
- Background embedder is fail-open against Supabase: a brief
  Supabase outage leaves rows locally embedded with `pgvector_sync`
  missing, and the next successful tick catches them up.

## Commit map (0.1.0)

| Commit | Subject |
|---|---|
| `e877c73` | Initial scaffold: Discord bot with Sonnet 4.6 + aigamma Supabase tools |
| `32422c2` | Add SQLite-backed conversation memory and cost tracking |
| `543d7d0` | Add Voyage embeddings, background embedder, and semantic chat-history search |
| `0deebee` | Add web search, web fetch, per-user rate limit, /usage and /search commands, retries |
| `02178bc` | Add stock + GEX history tools and temporal awareness in the system prompt |
| `ef4b264` | Add read-only DuckDB shard integration via @duckdb/node-api |
| `460b4e5` | Migrate semantic memory to Supabase pgvector with HNSW; SQLite path stays as fallback |
| `caea600` | Add structured logger, lifecycle handlers, in-flight drain, and /health command |
| `2e4f6f3` | Add unit test suite for pure-function modules (33 tests, all green) |
| `255ea71` | Rewrite README, add CI workflow, Dockerfile, compose file, migration SQL |
| `6a7a640` | Add model selector on /ask, reaction feedback capture, /summarize command |
| `697ce1c` | Refresh CLAUDE.md to current architecture; add online SQLite backup script |
| `ee83738` | Stream model responses with progressive Discord edits |
| `57ea48f` | Add HTTP /healthz endpoint, Discord-message citations in search, tool breakdown in /usage |
| `0f80b23` | Add per-user daily cost cap and CHANGELOG.md |
| `42e7199` | Add /admin operator commands, expand test suite, fix non-deterministic ordering bug |
| `4001d3c` | Add get_realized_correlations and get_vrp_history tools |
| `65852e0` | Add tool-result cache and /about command; surface cache stats in /health |
| `ab9a2e7` | Add ESLint, postmortem script, project metadata, fix lint-surfaced issues |
| `97e95cc` | Add docs/EXAMPLES.md, SQLite integrity probe in /health, JSDoc on public APIs |
