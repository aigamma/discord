# Changelog

All notable changes to this project are documented here. Order is newest
first within each section. Versioning is incremental; pre-1.0 only.

## Unreleased

### Added

- Per-user daily cost cap (`DAILY_USER_COST_CAP_USD`). Off by default; when
  enabled, refuses requests once the user's same-day `turns.cost_usd` sum
  exceeds the cap, with a friendly message naming the reset window. `/usage`
  surfaces the caller's own remaining headroom when the cap is on.
- HTTP `/healthz` endpoint on optional `HEALTH_PORT` for container
  orchestration probes. Cheap probe; returns 503 during shutdown or when
  the SQLite probe fails.
- Discord deep-links in `search_chat_history` results. Each hit carries a
  `discord_url` that jumps to the original message when the bot has all
  three of guild_id, channel_id, and discord_message_id.
- Tool-call breakdown in `/usage` (top 10 by call count over the window).
- Streaming responses. Anthropic stream API drives onProgress callbacks;
  `progressReporter.js` debounces Discord edits to ~1-2/sec.
- `/summarize` slash command: brief of the last N (default 100, max 500)
  channel messages via a dedicated summarization system prompt.
- 👍 / 👎 reaction feedback on assistant messages, persisted to the
  `feedback` table and surfaced in `/usage`.
- `/ask model:<sonnet|opus|haiku>` per-turn model override.
- Online SQLite backup via `VACUUM INTO` (`npm run backup`).
- HTTP `/health` slash command surfacing pid, uptime, embedder queue,
  pgvector reachability, attached shards, every capability flag.
- Structured logger (JSON for non-TTY, pretty for TTY).
- Graceful shutdown: drain in-flight model turns before exit, hard
  timeout at 45s.
- `uncaughtException` and `unhandledRejection` handlers.
- Transient-error retry (1s/3s/8s backoff against 429/5xx).
- Per-user rate limit (sliding window, default 10/min).
- `/forget` clears the channel's short-term context window.
- Search command and tool with Supabase pgvector HNSW + SQLite cosine
  fallback.
- Voyage `voyage-3` embeddings with a background embedder.
- DuckDB shard integration: read-only attach of the aigamma-backtester
  shards with a guarded single-statement `query_duckdb` tool.
- Stock-history and GEX-history tools against aigamma's daily tables.
- Anthropic native `web_search_20250305` and `web_fetch_20250910` server
  tools.
- Temporal context block in every system prompt (ET timestamp + market
  session label).
- 25-delta risk reversal definition and VRP sign convention pinned in
  the system prompt.
- Operator identity block (Blue / Eric Allione / Options Alchemy).
- node:test suite (37 tests covering pricing, rate limit, cosine, prompt
  composition, SQL guard, progress reporter).
- GitHub Actions workflow runs the suite on every push and PR.
- Dockerfile + compose.yml for containerized deployment.
- Migration SQL for the discord_chat_memory pgvector table.
- CHANGELOG and README brought current with the full feature surface.

### Notes

- System prompt models aigamma.com's behavior.mjs byte-for-byte on tone
  bans: no preambles, no flattery, no closing hooks, no em-dashes, no
  bullets, no metaphors, no analogies. Final sentence always declarative.
- Local SQLite remains source of truth for the audit log; Supabase
  pgvector is the search index with HNSW. Search falls back to SQLite
  cosine when Supabase is unreachable.
- Vendor data-licensing boundary inherited from aigamma's Massive
  contract: bot redistributes only computed metrics; raw per-strike IV
  grids, per-contract Greeks, and raw bid/ask never leave the data layer.

## Commit map

| Commit | Subject |
|---|---|
| `e877c73` | Initial scaffold: Discord bot with Sonnet 4.6 + aigamma Supabase tools. |
| `32422c2` | Add SQLite-backed conversation memory and cost tracking. |
| `543d7d0` | Add Voyage embeddings, background embedder, and semantic chat-history search. |
| `0deebee` | Add web search, web fetch, per-user rate limit, /usage and /search commands, retries. |
| `02178bc` | Add stock + GEX history tools and temporal awareness in the system prompt. |
| `ef4b264` | Add read-only DuckDB shard integration via @duckdb/node-api. |
| `460b4e5` | Migrate semantic memory to Supabase pgvector with HNSW; SQLite path stays as fallback. |
| `caea600` | Add structured logger, lifecycle handlers, in-flight drain, and /health command. |
| `2e4f6f3` | Add unit test suite for pure-function modules (33 tests, all green). |
| `255ea71` | Rewrite README, add CI workflow, Dockerfile, compose file, migration SQL. |
| `6a7a640` | Add model selector on /ask, reaction feedback capture, /summarize command. |
| `697ce1c` | Refresh CLAUDE.md to current architecture; add online SQLite backup script. |
| `ee83738` | Stream model responses with progressive Discord edits. |
| `57ea48f` | Add HTTP /healthz endpoint, Discord-message citations in search, tool breakdown in /usage. |
