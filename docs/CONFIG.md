# Configuration Reference

Single source of truth for every environment variable the bot reads. Mirrors
`src/config.js` (the loader + validator) and `.env.example` (the annotated
template) without drift. **Every entry in `config.js` should be listed here.**
If you add or remove one, update this file in the same PR.

The bot reads env vars once at startup, validates them, and surfaces missing
required keys as a fail-fast error naming each missing var. Optional
integrations silently disable when their key is absent.

---

## Reading order

1. `node --env-file-if-exists=.env.local` loads `.env.local` if present.
   Production deployments can inject the env directly (Docker compose,
   Kubernetes Secret, orchestrator) and skip the file.
2. `src/config.js readEnv()` runs once at import. Required keys must be
   non-empty strings. Optional integers go through `safeInt(name, raw,
   fallback, {min, max})` which logs a parse error and uses the fallback
   when the value is out of range. Optional floats go through `safeFloat`
   with the same shape.
3. `config` is exported as a frozen plain object. Mutating it at runtime
   is unsupported.

---

## Required

These three must be set or the bot refuses to start. The startup error
message names each missing key.

### `DISCORD_BOT_TOKEN`

Bot token from the Discord developer portal. Application → Bot → "Reset
Token". Treat as a secret; anyone with this token can act as the bot. Rotate
via "Reset Token" if it leaks.

### `DISCORD_CLIENT_ID`

Application (client) ID. Application → General Information → Application ID.
Used by `scripts/register-commands.js` and by the mention-detection regex in
`src/bot.js stripMention`.

### `ANTHROPIC_API_KEY`

Key from <https://console.anthropic.com/settings/keys>. Used for every model
call and every tool-execution round. Treat as a secret.

---

## Operator identity (system prompt)

These shape the `[OPERATOR IDENTITY]` block in the system prompt. Forkers
should override them via env vars; the defaults preserve the Options
Alchemy identity.

| Var | Default | Notes |
|---|---|---|
| `OPERATOR_HANDLE` | `Blue` | Used everywhere the prompt refers to the operator by handle. |
| `OPERATOR_NAME` | `Eric Allione` | Used when a member asks the operator's real name. |
| `COMMUNITY_NAME` | `Options Alchemy` | Used in the `/about` footer and the system prompt. |

A fork that wants a different voice should also update
`BEHAVIORAL_CONSTRAINTS` in `src/prompt.js` and the assertions in
`test/prompt.test.js`. See `CONTRIBUTING.md`.

---

## Discord

| Var | Required | Default | Notes |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | — | See **Required** above. |
| `DISCORD_CLIENT_ID` | yes | — | See **Required** above. |
| `DISCORD_GUILD_ID` | no | (global) | When set, `npm run register` registers commands to that guild only — guild-scoped registration propagates instantly. Leave blank for global registration (~1h propagation). |
| `OWNER_DISCORD_USER_ID` | no | — | Required to use the `/admin` subcommand surface. Without it, `/admin` returns "Not authorized" to every caller. Right-click your avatar → Copy User ID (Developer Mode required). |

---

## Anthropic

| Var | Required | Default | Range | Notes |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | — | — | See **Required** above. |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-4-6` | — | Model id used unless `/ask model:` overrides. Must have a `PRICING` entry in `src/pricing.js`; the startup logs a warn and cost tracking records `null` when missing. |
| `ANTHROPIC_MAX_TOKENS` | no | `4096` | `[64, 200000]` | Per-turn output ceiling. The bot appends a truncation note when `stop_reason=max_tokens`. |
| `ENABLE_WEB_SEARCH` | no | `true` | bool | Set to `false` to disable Anthropic's server-side `web_search_20250305` tool. |
| `ENABLE_WEB_FETCH` | no | `true` | bool | Set to `false` to disable Anthropic's server-side `web_fetch_20250910` tool. |

Bool semantics: any value other than the literal string `false` (case-insensitive)
is treated as `true`. Leave unset for `true` defaults.

---

## Supabase (optional)

When both `SUPABASE_URL` and `SUPABASE_KEY` are set, the bot:

- Registers the eight market-data tools (see `docs/TOOLS.md`).
- Starts mirroring locally-embedded messages to the `discord_chat_memory`
  pgvector table.
- Routes `search_chat_history` through the pgvector HNSW RPC with SQLite
  cosine fallback.

When either is unset, all of the above silently disable. The bot still runs.

| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | no | Project REST URL, e.g. `https://abc123.supabase.co`. |
| `SUPABASE_KEY` | no | Use the anon (publishable) key. The service key bypasses RLS and should not sit in a process that doesn't strictly need write access. |

---

## Voyage (optional)

When set, the background embedder embeds every persisted user message via
`voyage-3` (1024 dims) and stores the Float32 buffer locally. Without
Voyage, short-term context still works but `search_chat_history` is
unavailable (because the tool registry gates `MEMORY_MODULES` on
`config.voyage.enabled`).

| Var | Required | Default | Notes |
|---|---|---|---|
| `VOYAGE_API_KEY` | no | — | Key from <https://www.voyageai.com/>. |
| `VOYAGE_MODEL` | no | `voyage-3` | Override the embedding model. **Changing this requires a pgvector schema change** because the `vector(1024)` column dim is fixed by migration 001. |

---

## Conversation memory

| Var | Default | Range | Notes |
|---|---|---|---|
| `CONVERSATION_DB_PATH` | `./data/conversation.db` | — | Path to the SQLite store. Parent directory is created automatically. WAL mode, synchronous=NORMAL, foreign keys on. |
| `SHORT_TERM_CONTEXT_TURNS` | `12` | `[0, 100]` | How many recent messages from the same channel to load as short-term context per turn. |
| `SHORT_TERM_CONTEXT_MINUTES` | `60` | `[1, 1440]` | Sliding time window. Messages older than this don't load into short-term context but stay searchable via `search_chat_history`. |
| `SEARCH_MIN_SIMILARITY` | `0.15` | `[-1, 1]` | Floor for `search_chat_history` results. `voyage-3` similarities compress tight; 0.15 admits topical neighbors while excluding clear noise. |

---

## Rate limiting and budgets

| Var | Default | Notes |
|---|---|---|
| `RATE_LIMIT_REQUESTS_PER_MINUTE` | `10` | Per-user sliding-window cap, in-memory. Read by `src/rateLimiter.js`. |
| `DAILY_USER_COST_CAP_USD` | `0` (off) | Per-user daily cost cap. Reset at UTC midnight. Computed from `SUM(cost_usd)` in the `turns` audit log. Suggested values: 5–20 USD per user per day for a tight community. Requires every used model to have a `PRICING` entry — without one, `cost_usd` is `null` and the cap silently never triggers. |

---

## Logging

| Var | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `LOG_FORMAT` | (auto) | `json` for supervisor ingest (k8s, Loki, Datadog), `pretty` for an interactive shell. Auto-detected from the stdout TTY when unset. |

---

## HTTP health endpoint (optional)

| Var | Default | Notes |
|---|---|---|
| `HEALTH_PORT` | (off) | When set, starts an HTTP `/healthz` on that port. Returns `200` only when SQLite is reachable, Discord shard is connected, and the lifecycle is not draining. Returns `503` with `{discord_ready, sqlite_ok}` JSON when degraded. Off by default; the in-Discord `/health` slash command remains available regardless. |

---

## Backtester DuckDB shards (optional)

| Var | Default | Notes |
|---|---|---|
| `BACKTESTER_DATA_DIR` | `C:/aigamma-backtester/data` | Directory probed for `option_chains_eod.duckdb`, `index_history.duckdb`, `stocks_history.duckdb`, `derived.duckdb`. Each present shard is attached READ_ONLY. Missing files are skipped. When zero are present, `query_duckdb` is silently omitted from the tool surface. |

The Windows default reflects the original deployment's path. On Linux/macOS,
override to something like `/var/data/backtester` or `~/backtester-data`.

---

## What is **not** configurable

Some knobs that look like they should be env-driven are intentionally pinned
in source. If you need to change one, change the constant and add a test that
pins the new value.

| Pinned value | Where | Why pinned |
|---|---|---|
| `MAX_TOOL_ROUNDS = 8` | `src/agent.js` | Bounds runaway tool-chains for cost. Bumping requires checking Anthropic's per-turn safety. |
| Anthropic SDK timeout = 240s/attempt | `src/agent.js` | 4min × 3 attempts + backoffs ≈ 12min, comfortably under Discord's 15min deferReply ceiling. |
| Voyage batch size = 32 | `src/embedder.js` | Matches Voyage's recommended batch and the rate-limit headroom. |
| Embedder tick interval = 10s | `src/embedder.js` | Tradeoff between recall freshness and Voyage cost. |
| Tool result cache size = 256 entries | `src/toolCache.js` | LRU + FIFO eviction; keeps the cache resident in memory without unbounded growth. |
| Per-tool cache TTL | `src/tools/index.js TOOL_TTLS` | Different surfaces need different freshness. |
| `MAX_NOTES_PER_USER = 12`, `MAX_NOTE_CHARS = 280` | `src/memory.js` | Caps the per-user `[NOTES FOR THIS ASKER]` block size so a single user can't blow up everyone's prompt cache. |
| `EXPORT_ROW_CAP = 10000` | `src/memory.js` | Bounds `/export` memory footprint independently of Discord's 25MB attachment limit. |
| NYSE holiday calendar through 2027 | `src/prompt.js` | Maintained inline so the bot doesn't import a holiday library and to keep the date-aware logic auditable. Update annually; the prompt builder logs a warn when the calendar has aged out. |

---

## Verifying

`npm run verify` runs `scripts/verify.js` which pings every configured
external service and reports per-service status (Anthropic, Supabase REST,
Supabase pgvector, Voyage, DuckDB shards). Use it as the smoke test after
changing any of the above; catches credential errors before users hit them
via `/ask`.

`/health` is the in-Discord runtime equivalent: subsystem reachability,
embed/sync queue depths, cache stats, lifecycle state. See
`docs/OPERATIONS.md` for incident playbooks keyed on `/health` symptoms.
