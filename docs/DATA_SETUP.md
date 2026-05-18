# Data Setup Guide

How to wire this bot up to its data layer end-to-end: Discord, Anthropic,
Voyage, Supabase (market data + pgvector memory), and DuckDB shards. This
is the step-by-step companion to `DATA_CONTRACTS.md` (which is the schema
reference) and `docs/CONFIG.md` (which is the env-var reference).

Take this guide top-to-bottom for a fresh deployment. Skip sections for
integrations you don't need — every external is optional except Discord +
Anthropic, and the bot starts cleanly in any subset.

---

## 1. Discord

You need a Discord application with a Bot user. Read-only summary of what
to set — see the README for the click-by-click.

| What | Where | Save as | Notes |
|---|---|---|---|
| Bot token | Application → Bot → "Reset Token" | `DISCORD_BOT_TOKEN` | Treat as a secret. Rotation = restart. |
| Application ID | Application → General Information → Application ID | `DISCORD_CLIENT_ID` | Public-ish; used by the slash-command registration and the mention regex. |
| Server (Guild) ID | Right-click your server icon → Copy Server ID | `DISCORD_GUILD_ID` | Optional. Set during development for instant slash-command registration. Leave blank for global (~1h propagation). |
| Owner User ID | Right-click your avatar → Copy User ID | `OWNER_DISCORD_USER_ID` | Optional. Required for `/admin`. Developer Mode must be on in Discord settings. |

**Intents you must enable** (Application → Bot → Privileged Gateway
Intents):

- **MESSAGE CONTENT INTENT** — required for `@mention <text>` to read
  the message text. Without it, the mention handler sees an empty body.

**OAuth scopes + permissions** when generating the invite URL (Application
→ OAuth2 → URL Generator):

- Scopes: `bot`, `applications.commands`.
- Permissions: `Send Messages`, `Read Message History`, `Use Slash
  Commands`, `Embed Links`, `Attach Files`.

`Attach Files` is needed for `/export`'s JSON download. The bot does
not need `Add Reactions` (it only receives them).

**Slash commands** are not visible to users until you publish them:

```
npm run register
```

If `DISCORD_GUILD_ID` is set, registration is instant (guild-scoped).
Otherwise global, ~1h propagation.

---

## 2. Anthropic

| What | Where | Save as |
|---|---|---|
| API key | <https://console.anthropic.com/settings/keys> | `ANTHROPIC_API_KEY` |

**Model selection** (`ANTHROPIC_MODEL`, default `claude-sonnet-4-6`):

- The default Sonnet is the recommended tradeoff (speed + cost + quality).
- Per-turn override is available to users via `/ask model:` (sonnet /
  opus / haiku).
- Setting `ANTHROPIC_MODEL` to a different model requires a matching
  entry in `src/pricing.js`. Without one, the startup logs a warn and
  cost tracking records `null` until the entry exists. The
  daily-budget cap silently fails open during that window.

**Web tools** (`ENABLE_WEB_SEARCH`, `ENABLE_WEB_FETCH`, both default `true`):

- `web_search` is billed at $10 per 1000 requests; that cost surfaces
  in `/usage`'s cost field.
- Set to `false` if you want the bot's outputs to be fully self-contained
  from model knowledge + your local data.

---

## 3. Voyage AI (optional — semantic memory)

Required for `/search`, `search_chat_history`, and the background embedder.
Without Voyage, the bot keeps short-term context (last N turns in the
channel within the time window) but cannot search older history by meaning.

| What | Where | Save as |
|---|---|---|
| API key | <https://www.voyageai.com/> | `VOYAGE_API_KEY` |
| Model override | — | `VOYAGE_MODEL` (default `voyage-3`) |

**Caveats:**

- The pgvector column is `vector(1024)`. The default `voyage-3` returns
  1024-dim vectors. Switching to a model with a different dim requires
  a coordinated migration (drop and recreate the column + index).
- The bot embeds **only user messages** (`role='user'`), and only those
  with `length(content) >= 4`. Bot replies and short noise messages are
  skipped.

---

## 4. Supabase — market data (optional)

This section is the heaviest. The eight market-data tools read from
specific tables in a Supabase project. You can either:

a. Point at an existing Supabase project that already has the right
   schema (the original Options Alchemy deployment does this — its
   pipeline writes the tables that the bot reads), or
b. Provision a fresh project and write a puller that produces the tables
   yourself, or
c. Skip Supabase entirely. The bot starts cleanly without it; the
   market-data tools simply don't register.

### 4a. Provision the project

1. Create a project at <https://supabase.com>.
2. **Project Settings → API:**
   - Copy the project REST URL → `SUPABASE_URL` (e.g.
     `https://abc123.supabase.co`).
   - Copy the **anon (publishable) key** → `SUPABASE_KEY`. The bot only
     reads public tables and writes to its own `discord_chat_memory`
     table; the anon key plus RLS is the safe profile.
3. **Database → Extensions** → enable `vector`. Required even if you
   intend to use only the market-data tools; the bot's pgvector
   migration ships in the same project.

### 4b. Apply the bot's own migrations

The bot's only owned table is `discord_chat_memory` (the pgvector mirror
of locally-embedded messages). Two SQL files ship in `migrations/`:

```
psql $DATABASE_URL -f migrations/discord_chat_memory_001.sql
psql $DATABASE_URL -f migrations/discord_chat_memory_002_unique_local_id.sql
```

Or via the Supabase SQL editor (paste each file, run in order).

**Migration 001** creates the table, the HNSW index (m=16,
ef_construction=64), and the `search_discord_memory` RPC. RLS is enabled
on the table; you may need to add a policy if your project's RLS posture
denies anon `SELECT` by default.

**Migration 002** adds `UNIQUE (local_id)`. Required for the embedder's
`on_conflict=local_id` upsert; without it every sync fails with a
PostgREST "no unique constraint" error. **Do not skip migration 002.**

### 4c. Provide the market-data tables

The bot reads seven tables from your Supabase project (writes go only to
`discord_chat_memory`). Each tool maps to one or two tables. See
`DATA_CONTRACTS.md > Supabase: tables the bot READS` for the column-by-
column schema. The short list:

| Table | Used by | Cadence |
|---|---|---|
| `vix_family_eod` | `get_vix_family_latest` | Daily after close |
| `daily_volatility_stats` | `get_iv_percentile`, `get_vrp_history` | Daily after close |
| `daily_eod` | `get_stock_history`, `get_realized_correlations` | Daily after close |
| `daily_gex_stats` | `get_gex_history` | Daily after close |
| `ingest_runs` | `get_gex_levels`, `get_spx_term_structure` | Intraday 5-min |
| `computed_levels` | `get_gex_levels` | Intraday 5-min, FK to `ingest_runs` |
| `expiration_metrics` | `get_spx_term_structure` | Intraday 5-min, FK to `ingest_runs` |

You need a puller (any language, any orchestration — a Python script on a
cron, a serverless function, a long-running ingester) that writes these
tables according to the schemas in `DATA_CONTRACTS.md`. The Options
Alchemy deployment uses the closed-source aigamma.com pipeline; an
open-source alternative is in scope as a future contribution but doesn't
ship with this repo.

**Two ways to point a fork at its own data:**

1. **Match the exact table names and column names** in `DATA_CONTRACTS.md`.
   Then the shipped tools work unchanged. Easiest for a fork.
2. **Use different names/shapes** and fork the tool files in `src/tools/`
   to match. More work per tool, but lets you reuse an existing data
   model. The tool registry is plug-and-play (`src/tools/index.js`
   imports each file by name); replace the implementation and keep the
   spec stable.

### 4d. RLS posture

The anon key respects Row Level Security. For the bot's read access to
the market-data tables, you have two reasonable options:

- **Public read.** Open `SELECT` to `anon` on each market-data table.
  Acceptable if the data layer is non-sensitive (computed metrics,
  derivative readings).
- **Authenticated read with a service-role secondary.** Use the anon key
  with a RLS policy that requires a specific JWT claim, and proxy the
  bot through a service role. More complex; recommended only if the
  data layer is sensitive.

For `discord_chat_memory` (the table the bot WRITES), RLS should at
minimum allow the bot's key to `INSERT` and `SELECT`. Migration 001
enables RLS but does not ship policies — write the policy that fits
your security posture.

### 4e. Verify

```
npm run verify
```

Pings Anthropic, Supabase REST, Supabase pgvector, and Voyage in
sequence. Look for:

- `Supabase REST: reachable in <N>ms (HTTP 200/404)` — the 404 from the
  root path is expected; the REST is reachable, that's what matters.
- `Supabase pgvector: discord_chat_memory table reachable` — confirms
  migration 001 applied.

If pgvector reports "table not reachable", re-apply the migration. If
REST reports an auth failure, check the key.

---

## 5. DuckDB backtester shards (optional)

The `query_duckdb` tool lets the model run arbitrary read-only SELECTs
against multi-year option chains, index history, stock history, and
pre-computed feature tables. Each shard is a single DuckDB file.

| What | Where | Save as |
|---|---|---|
| Shard directory | local filesystem | `BACKTESTER_DATA_DIR` (default `C:/aigamma-backtester/data`) |

The bot probes for these filenames in the directory:

| File | Attach name | Required for |
|---|---|---|
| `option_chains_eod.duckdb` | `option_chains` | Per-contract chain queries |
| `index_history.duckdb` | `index_history` | Multi-year SPX/VIX |
| `stocks_history.duckdb` | `stocks_history` | Multi-year stock/ETF |
| `derived.duckdb` | `derived` | Pre-computed daily features |

You can ship any subset. Missing files are silently skipped. Zero
present → `query_duckdb` is not registered.

**Schema expectations** are documented in `DATA_CONTRACTS.md > DuckDB
backtester shards`. Adhering to them lets the model query unchanged.
Diverging means either updating the model's mental model (via the
`description` field in `src/tools/queryDuckdb.js`'s spec) or normalizing
the data to match.

**Producing the shards** is out of scope for this repo. The Options
Alchemy deployment uses the open-source [`aigamma-backtester`] project
(separate repo). A fork can use any pipeline that emits the right
schema.

**The bot never writes to the shards.** Attach is `READ_ONLY`; the
engine-level lockdown (`enable_external_access = false` +
`lock_configuration = true`) also prevents the model from reaching the
host filesystem via DuckDB's file-reading table functions even with a
prompt-injection attempt. See `SECURITY.md > Threat model`.

**File placement options:**

- A local directory (the original deployment puts shards on the same
  host as the bot).
- A network-mounted directory (NFS, SMB, fly.io volume). The bot just
  needs filesystem read access; DuckDB attaches files via path.

**Hot-reload caveat:** the bot probes for shards once at startup. If
your puller writes a new shard while the bot is running, the bot won't
pick it up until restart. Plan for a daily restart after the puller's
nightly batch, or set up a file-watcher that triggers a restart.

---

## 6. End-to-end verification

After everything is configured, run the smoke test:

```
npm run verify
```

You should see:

```
Anthropic           ✓  claude-sonnet-4-6 responded in 423ms (5→3 tokens)
Supabase REST       ✓  reachable in 142ms (HTTP 200)
Supabase pgvector   ✓  discord_chat_memory table reachable
Voyage              ✓  voyage-3 returned 1024-dim vector in 230ms
SQLite              ✓  integrity ok · 9 migration(s) applied · 12ms
DuckDB              ✓  4 shard(s) attached: option_chains, index_history, stocks_history, derived
```

A skipped section (e.g. "Supabase: skipped (SUPABASE_URL not set)") means
the bot will start without that integration; the corresponding tools simply
won't register.

Then start the bot:

```
npm start
```

And inside Discord:

- `/health` — should show every subsystem you configured as reachable.
- `/ask question: ping` — should produce a one-line answer.
- `/about` — should list the integrations that are live (computed from
  config, not hard-coded).

---

## Common pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run verify` says pgvector unreachable | Migration 001 not applied, or `vector` extension not enabled | Run migration 001, then verify the extension with `SELECT * FROM pg_extension WHERE extname='vector';`. |
| Embedder fails on every tick with "no unique constraint" | Migration 002 not applied | `psql -f migrations/discord_chat_memory_002_unique_local_id.sql`. |
| `/ask` works but no market-data tools show up in `/about` | Supabase not configured (or `SUPABASE_URL`/`SUPABASE_KEY` empty) | Set the env, restart. The registry gates on `config.supabase.enabled` per `src/tools/index.js`. |
| `query_duckdb` not in `/about` even though shards exist | `BACKTESTER_DATA_DIR` points at the wrong path | `npm run verify` reports the resolved path. The bot logs `duckdb no shards found` with `hint: BACKTESTER_DATA_DIR points to a path that does not exist` when the dir is missing entirely. |
| Search returns nothing fresh | Embedder hasn't caught up; or Voyage key expired | `/health` → "Embed pending" / "Sync pending". If pending is high and not draining, check the embedder logs. |
| Bot can't see @mentions | MESSAGE CONTENT INTENT not enabled | Discord developer portal → Bot → Privileged Gateway Intents. Toggle on. |
| Slash commands missing from a server | `npm run register` was global and hasn't propagated yet | Either wait ~1h for global propagation, or set `DISCORD_GUILD_ID` and re-register for instant guild-scoped commands. |

---

## Forking strategy

If you are forking this repo for a different community / different data
layer:

1. **Override the operator identity via env** (`OPERATOR_HANDLE`,
   `OPERATOR_NAME`, `COMMUNITY_NAME`). The default identity is for
   Options Alchemy / Blue / Eric Allione.
2. **Decide which integrations you need.** You can ship a pure-Anthropic
   conversational bot (no Supabase, no Voyage, no DuckDB) and still have
   short-term context. Add Voyage for semantic recall. Add Supabase for
   market-data tools. Add DuckDB for backtester research.
3. **For your data layer**, either match the schemas in
   `DATA_CONTRACTS.md` (zero-source-code-changes path) or fork the tool
   files in `src/tools/` to match your tables.
4. **Update the voice** if your audience isn't a closed practitioner
   community. The constraints in `src/prompt.js BEHAVIORAL_CONSTRAINTS`
   are pinned by `test/prompt.test.js`; weakening them means updating
   the assertions in the same PR.

The Discord wiring, agent loop, memory layer, observability, and
lifecycle are domain-agnostic. The data layer and the voice are the two
fork points.
