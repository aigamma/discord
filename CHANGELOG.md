# Changelog

All notable changes to this project are documented here. Order is newest
first within each section. Versioning is incremental; pre-1.0 only.

## Unreleased

### Added
- `/summarize` now streams progressive Discord edits via the
  progressReporter, matching the `/ask` UX.

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
