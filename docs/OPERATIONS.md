# Operations Runbook

How to run, monitor, debug, and recover this bot. Companion to
`docs/DATA_SETUP.md` (which covers the one-time data-hookup) and
`ARCHITECTURE.md > Lifecycle` (which describes the drain semantics).

The bot is a single Node 22+ process. There is no cluster, no worker pool,
no queue service. That makes operations simple: there is one log stream,
one SQLite store, and one health endpoint. Treat the process as ephemeral
— state of record is SQLite plus the optional Supabase mirror.

---

## Day-zero deployment

1. **Provision a host.** Anything that runs Node 22+ works: a Linux VPS, a
   `node:22-bookworm-slim` container, a fly.io machine, a Raspberry Pi.
   Memory budget: ~150 MB resident steady-state; ~250 MB peak during a
   long DuckDB result. Disk: tens of MB for the bot + however much you let
   the SQLite store grow (`du -sh data/conversation.db` after a month of
   use gives a real number).
2. **Install Node 22+.** `nvm install 22 && nvm use 22`, or use the
   shipped Docker image (`Dockerfile` + `compose.yml`).
3. **`npm install`.** Native `@duckdb/node-api` has prebuilt binaries for
   Win/Mac/Linux; no compiler toolchain is needed.
4. **Fill in `.env.local`.** Required: `DISCORD_BOT_TOKEN`,
   `DISCORD_CLIENT_ID`, `ANTHROPIC_API_KEY`. See `docs/CONFIG.md` for the
   full env-var surface.
5. **`npm run verify`.** This pings every configured external service and
   prints a per-service pass/fail. Run it before users hit `/ask` — credential
   errors then come from a script you control, not from a Discord interaction.
6. **`npm run register`.** Publishes the slash commands to Discord. Use
   `DISCORD_GUILD_ID` for instant guild-scoped registration during
   development; leave it blank for global (~1h propagation).
7. **`npm start`.** The bot logs in, attaches DuckDB shards if any,
   starts the embedder loop and the optional health server, and reports
   `discord ready` when the first shard is up.

---

## Daily operations

### Where to look first

| Surface | Use when | Notes |
|---|---|---|
| `/health` (in Discord) | First diagnostic for "the bot is acting weird" | Subsystem reachability, queue depths, lifecycle state. |
| `/usage` (in Discord) | Cost, latency, prompt-cache hit ratio | Defaults to 24h; max 720h. Per-user breakdown is owner-only. |
| `/admin feedback` (in Discord) | "Why did people thumbs-down recently?" | Joins reactions to the original question and reply. Owner-only. |
| `GET /healthz` (HTTP) | Orchestration probe (k8s, fly.io) | Set `HEALTH_PORT`. Returns 200 only when SQLite + Discord + drain check all pass. |
| `npm run postmortem -- --hours 168` (CLI) | End-of-week review | Plain text; pipe to a file. Same R-7 percentile as /usage. |
| Logs | Everything else | JSON for non-TTY (supervisor ingest), pretty for TTY. Filter by `LOG_LEVEL`. |

### Restarting safely

```
systemctl restart trading-discord-bot     # systemd
docker compose restart                    # docker
flyctl deploy / flyctl machine restart    # fly.io
```

Send SIGTERM (or SIGINT for Ctrl-C). The bot's lifecycle handler:

1. Sets `shuttingDown = true`. `/health` now reports `**SHUTTING DOWN**`;
   `/healthz` returns 503.
2. New turns refuse early (`Bot is shutting down; new requests refused.`).
3. Waits up to 30 seconds for `inFlightCount() === 0`.
4. Stops the embedder, closes the DuckDB connection, destroys the Discord
   client, exits 0.
5. If a 30-second wait isn't enough, a 45-second hard timer force-exits.
6. A second SIGINT/SIGTERM bypasses the drain and exits immediately.

So a rolling restart loses **at most** the turns that didn't complete
within 30 seconds. Most turns finish in 5–15s.

### Backups

The store carries every persisted Q&A plus the audit log plus user notes
plus feedback. Back it up:

- **Scheduled (recommended)**: `npm run backup` on a cron. Default
  output path is `./data/backups/conversation-<isoStamp>.db`. Rotation
  keeps the 14 most recent (`keep: 14` in `runBackup`). Override the
  retention by editing `backup.js` or wrapping the script.
- **Ad-hoc (owner-only)**: `/admin backup` from Discord. Reports output
  path, size in MB, elapsed ms, and rotation count.

The backup uses SQLite's `VACUUM INTO` against the running connection, so
the bot can keep writing through the snapshot. Output is a fully
self-contained `.db` file — no WAL/SHM siblings needed.

**Restoring** is a stop-the-world operation: kill the bot, copy a backup
into place at `CONVERSATION_DB_PATH`, restart. The pgvector mirror is
downstream; on restart the embedder resyncs missing rows in the
background.

### Rotating credentials

| Credential | How to rotate | Bot impact |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Discord dev portal → Bot → Reset Token. Update `.env.local`. Restart bot. | Restart required; sessions invalidate on token change. |
| `ANTHROPIC_API_KEY` | console.anthropic.com → settings/keys. Update env. Restart. | Restart required (config is read once at import). |
| `SUPABASE_KEY` | Supabase dashboard → Settings → API → roll the anon key. Update env. Restart. | Restart required. The pgvector RPC also uses this key. |
| `VOYAGE_API_KEY` | voyageai.com → dashboard. Update env. Restart. | Restart required. Embedder ticks fail until restart. |
| `OWNER_DISCORD_USER_ID` | Change to a different user id. Restart. | Restart required. `/admin` is denied until the env reflects the new owner. |

There is currently no SIGHUP reload path — the env is read once at module
import. Restarts cost nothing meaningful (the 30s drain plus the ~5s cold
start of attaching DuckDB shards).

---

## Incident playbooks

Each section starts with the **observable symptom** and walks to a
remediation. Look for the symptom that matches what you're seeing rather
than reading top-to-bottom.

### "The bot stopped responding to /ask"

1. `/health` from Discord. If it doesn't even respond, the bot is down or
   disconnected from Discord. Check the process is running, then check
   logs for the most recent `discord shard error` or `Invalidated`.
2. If `/health` works but `/ask` doesn't: the model call path is broken.
   Look in logs for `anthropic` errors. Most likely causes: expired
   `ANTHROPIC_API_KEY`, region outage, rate limit on the Anthropic side.
3. If logs are clean: check `/admin feedback` for a pattern. A repeated
   thumbs-down on `_(no response)_` usually means `stop_reason=refusal`
   on a topic the model has decided to decline — see the refusal note in
   `agent.js`.

### "The bot is hallucinating numbers"

Critical bug — the system prompt explicitly forbids inventing readings.
Tells the user "I don't have the data, no tool is available" should be
the fallback.

1. `/health`. Is the relevant backend reachable? If Supabase pgvector says
   `UNREACHABLE`, market tools are likely failing too. Check
   `SUPABASE_URL` / `SUPABASE_KEY`.
2. `/admin feedback` for the recent thumbs-down on the hallucination.
3. Search the audit log (`messages.tool_uses`) for the offending turn.
   `tool_uses=NULL` on an assistant message that quoted a number is a
   smoking gun: the model emitted a number without calling a tool.
4. If the model is calling a tool but the tool returns `{ error }`,
   verify the upstream schema hasn't drifted. Run `npm run verify` —
   schema drift surfaces here as a credentials-look-ok-but-rows-empty
   failure. The tool source files (`src/tools/*.js`) list the exact
   columns each tool reads; cross-check against the live schema.

### "Embedder backlog growing"

Symptom: `/health` shows `Embed pending` or `Sync pending` rising over
time and not draining.

| Side stuck | Likely cause | Remediation |
|---|---|---|
| Embed pending growing | Voyage down or `VOYAGE_API_KEY` expired | Check logs for `embedder embed tick failed`. `npm run verify`. Rotate the key. |
| Sync pending growing | Supabase pgvector unreachable, RLS misconfigured, or migration 002 (UNIQUE local_id) missing | Check logs for `embedder pgvector sync failed`. Re-apply `migrations/discord_chat_memory_002_unique_local_id.sql`. |
| Both growing | The embedder timer stopped | `/health` reports `embed_runs`. If it's not advancing, restart. |

After fixing the root cause, the embedder catches up on the next 10s
tick. No manual reset needed.

### "`/search` returns no hits when I know the topic was discussed"

1. `/health`. If `Embed pending` or `Sync pending` is large, the messages
   you're searching for haven't been embedded/synced yet — wait, or check
   the embedder.
2. Check `SEARCH_MIN_SIMILARITY`. The default `0.15` is loose; if your
   fork tightened it, recent queries are falling below the floor. Loosen
   to test.
3. If `backend: pgvector_hnsw` returns nothing but `backend:
   sqlite_cosine` would: the RPC is broken or returning empty.
   Temporarily disable Supabase to force the SQLite fallback and compare.
4. If both backends return nothing: the corpus genuinely doesn't contain
   the topic. Confirm with `/export` and grep the JSON.

### "Per-user daily cost cap is not triggering"

1. Confirm `DAILY_USER_COST_CAP_USD > 0` in the running env. `/health`
   doesn't print it; check the startup log.
2. Confirm the configured model is in `pricing.js`. If it isn't, the
   startup logs a warn and `cost_usd` records as `null` for every turn —
   the cap never triggers because `SUM(NULL) = NULL`. Add the entry to
   `pricing.js`.
3. Run `npm run postmortem -- --hours 24`. The per-user spend should be
   populated. If it's all zeros, you have a pricing mismatch.

### "Discord rate-limiting the bot's edits"

Symptom: streaming responses look choppy or stop updating mid-stream.

The `progressReporter` debounces edits and serializes them with an
`inFlight` flag. Discord's edit-rate ceiling is ~5/sec per channel; we
target under that. If you see 429s in logs:

1. Check whether multiple progress reporters are racing against one
   Discord message id. (Shouldn't happen — each turn creates its own
   reporter.)
2. Lower the edit cadence (`progressReporter.js` is small; the
   `DEBOUNCE_MS` is the knob).
3. If the channel sees parallel bot replies (multiple `/ask`s in flight),
   that's still 5 edits/sec per **channel**, not per message. Discord
   does enforce a channel-wide ceiling.

### "DuckDB tool returned no rows for something I know exists"

1. `/health` → "DuckDB shards" line. Confirm the relevant shard is
   attached. If only `derived` is attached and you queried
   `option_chains.option_chains_eod`, the table doesn't exist on this
   connection.
2. Run `npm run verify`. The DuckDB section reports the attached shards
   and any `init failed` error.
3. If shards are attached but a query returns 0 rows: read the
   `BACKTESTER_DATA_DIR` shard's actual schema with the DuckDB CLI (`duckdb
   path/to/shard.duckdb` → `SHOW TABLES;` → `DESCRIBE option_chains_eod;`).
   The schemas in `DATA_CONTRACTS.md` are the expected shape; if the
   external puller wrote something else, the query needs to adjust or
   the puller needs to align with the contract.
4. If the query was rejected with "only a single SELECT or WITH statement
   is allowed": the user used a forbidden keyword or function. Check the
   `FORBIDDEN_KEYWORDS` / `FORBIDDEN_FUNCTIONS` regexes in `src/duckdb.js`.

### "`/healthz` HTTP endpoint returns 503"

The JSON payload tells you which subsystem failed:

- `sqlite_ok: false` → SQLite is unreachable or the integrity probe
  failed. Check disk space, check `data/conversation.db` permissions,
  check whether another process has the WAL locked.
- `discord_ready: false` → Discord shard is disconnected or
  reconnecting. Check logs for `discord shard disconnected` /
  `discord session invalidated`.
- `shutting_down: true` → A drain is in progress. The 503 is correct
  for the orchestrator; load balancer should rotate traffic away.

### "Tests failed in CI but pass locally"

The most common cause is path or environment differences:

- The test suite avoids touching `~/.env` or the real
  `CONVERSATION_DB_PATH`. If a test writes to disk, it should use
  `mkdtempSync` for an isolated tmp store. Check the test for
  hard-coded paths.
- CI runs on `ubuntu-latest` (see `.github/workflows/test.yml`). Tests
  that rely on Windows-specific paths (the `BACKTESTER_DATA_DIR`
  default is `C:/aigamma-backtester/data`) need to set the env or
  detect the platform.

---

## Maintenance tasks

### Annual: refresh the NYSE holiday calendar

The calendar in `src/prompt.js` is pinned through 2027 (last year set in
`CALENDAR_MAX_YEAR`). When the year ticks over, the bot's temporal block
logs a warn at runtime (`NYSE holiday calendar is past its last covered
year`) and falls back to weekday-only logic.

To update: edit `NYSE_HOLIDAYS` and `NYSE_EARLY_CLOSES` to include the
new year's dates (NYSE publishes the schedule annually), bump
`CALENDAR_MAX_YEAR`, and verify the test in `test/prompt.test.js`
covers at least one date in the newly-added year.

### Quarterly: refresh the pricing table

Anthropic occasionally adjusts the published pricing. The bot's
`src/pricing.js` carries per-model rates. Verify against
<https://www.anthropic.com/pricing> and update if anything changed.

### Quarterly: audit the audit log

Run `npm run postmortem -- --hours 2160` (90 days) and look for:

- Recurring `Errors` patterns → root-cause the upstream.
- Persistent thumbs-down patterns → review the system prompt or the
  tool descriptions.
- Tool latency outliers → consider tightening per-tool TTLs in
  `TOOL_TTLS` if a slow upstream is being hit too often.

### As needed: rebuild embeddings

Run `/admin rebuild-embeddings` from Discord (owner-only) when:

- You changed `VOYAGE_MODEL` (different dim or different semantics).
- The pgvector mirror diverged from local SQLite (rare; usually
  surfaces as search returning unexpected rows or missing recent rows).
- You manually edited `messages` rows and want fresh embeddings.

The admin handler clears every local embedding blob, wipes the
`pgvector_sync` table, deletes every row from Supabase
`discord_chat_memory`, and flushes the tool cache. The background
embedder re-embeds and re-syncs over the next several ticks; throughput
scales with Voyage's rate limit.

---

## Forensics

### "What did user X do recently?"

```sql
SELECT m.id, m.role, m.created_at, m.content, t.stop_reason, t.cost_usd
FROM messages m
LEFT JOIN turns t ON t.assistant_message_id = m.id
WHERE m.user_id = '<discord_user_id>'
ORDER BY m.created_at DESC
LIMIT 50;
```

### "Which turns errored in the last hour?"

```sql
SELECT t.created_at, t.model, t.error, m.content AS question
FROM turns t
LEFT JOIN messages m ON m.id = t.user_message_id
WHERE t.error IS NOT NULL AND t.created_at >= (strftime('%s','now')*1000 - 3600*1000)
ORDER BY t.created_at DESC;
```

### "What did the model see on a specific turn?"

The audit log carries `tool_uses` as JSON. Parse it to see exactly which
tools the model called with which inputs:

```sql
SELECT id, model, tool_uses FROM messages
WHERE role = 'assistant' AND id = <message_id>;
```

For the system prompt at the time of the call, the prompt is not
persisted per-turn — it is reconstructed from `src/prompt.js` and the
caller's user notes. If the prompt logic has changed since the turn, you
must check out the git revision that was running at that time.

### "Did the bot get rate-limited on a specific call?"

The rate limit is in-memory (Map keyed by user id). It logs nothing per
allow/deny; only the user sees the rate-limit message. To audit
patterns, look at the gap pattern in `messages.created_at` for that user
— if they were trying repeatedly, the gaps between rejected and accepted
attempts reflect the sliding window.

---

## Choosing a posture

The bot is built for a tight community. Recommended posture:

- **Run on a single small host.** No cluster, no load balancer. A 1
  vCPU / 1 GB RAM VPS is enough for a community of dozens.
- **Set `DAILY_USER_COST_CAP_USD=10`** initially. Adjust based on
  observed `/usage`.
- **Set `RATE_LIMIT_REQUESTS_PER_MINUTE=10`.** Higher invites abuse;
  lower frustrates real users.
- **Enable `HEALTH_PORT` if you have orchestration** (Docker compose,
  k8s, fly.io). Skip it for a bare systemd unit.
- **Daily backup cron** — `0 4 * * * cd /opt/bot && npm run backup`.
  Rotation keeps the last 14 by default.
- **`LOG_FORMAT=json` in production.** Pretty is for tailing during
  development. Pipe JSON into Loki / Datadog / a flat file.

The bot is intentionally boring to operate. If you find yourself doing
non-routine ops work weekly, something is wrong — open an issue.
