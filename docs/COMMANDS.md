# Command Surface Reference

Single source of truth for every Discord-facing surface the bot exposes:
slash commands, the mention surface, and reaction feedback. Mirrors
`scripts/register-commands.js` (Discord-side registration) and
`src/bot.js handleSlashCommand` (the runtime router) without drift.

When you add or change a command, the three places that must agree:

1. `scripts/register-commands.js` — declares the Discord-side schema
   (name, options, choices, min/max, max length). Discord enforces these
   before the handler ever runs.
2. `src/bot.js` — the handler function plus a `case` in
   `handleSlashCommand`.
3. This document — the entry below.

Slash commands are not visible to users until `npm run register` is run.
Guild-scoped registration is instant; global takes ~1h to propagate.

---

## Quick reference

| Command | Surface | Ephemeral? | Owner-only? |
|---|---|---|---|
| `/ask` | model turn with tool use | public reply | no |
| `@bot <text>` | model turn with tool use (mention) | public reply | no |
| `/search` | semantic recall | ephemeral | no |
| `/summarize` | dedicated summary agent | public reply | no |
| `/forget` | clear short-term context cutoff | ephemeral | no |
| `/remember` | add a persistent user note | ephemeral | no |
| `/notes` | list saved notes | ephemeral | no |
| `/forget-note` | remove a single note by number | ephemeral | no |
| `/forget-notes` | clear all notes | ephemeral | no |
| `/export` | download channel Q&A as JSON | ephemeral | no |
| `/usage` | cost / token / latency summary | ephemeral | per-user breakdown is owner-only |
| `/health` | subsystem reachability | ephemeral | no |
| `/about` | capability tour | public reply | no |
| `/admin <subcommand>` | rebuild / backup / reset / feedback | ephemeral | yes |
| 👍 / 👎 reaction | feedback on a bot reply | — | no |

"Ephemeral" means the response is visible only to the caller and the
ephemeral marker shows in Discord. Use ephemeral for anything that's
either large (clutters the channel) or personal (the user's spend, the
user's saved notes).

---

## `/ask`

Run one agent turn with tool use enabled. The model decides which tools
to call (rate-limited and budget-capped per user).

**Options:**

| Name | Type | Required | Constraints |
|---|---|---|---|
| `question` | string | yes | Max length 1500 chars (Discord enforces). |
| `model` | choice | no | One of `sonnet` (default, fast), `opus` (deeper, 5x cost), `haiku` (fastest, cheapest). |

**Behavior:**

- `deferReply()` immediately (Discord's 3s initial-response deadline; turns
  can take ~30s with tool chains).
- Streams the model output via the progress reporter (debounced edits
  to stay under Discord's ~5 edits/sec ceiling).
- Persists the user message + assistant message + a `turns` audit row.
- For long replies (>2000 chars), the first chunk lands in the original
  reply and follow-ups go via `interaction.followUp`.
- Reactions on the final reply trigger `recordFeedback` if 👍/👎.

**Failure modes:**

- Rate-limited: ephemeral message with retry-after seconds.
- Budget cap reached: ephemeral message with reset time.
- Anthropic upstream failure: ephemeral "Something went wrong: <message>".
- `stop_reason=refusal`: the bot surfaces an explicit refusal note so the
  user doesn't see an ambiguous "_(no response)_".
- `stop_reason=max_tokens`: the bot appends a truncation note.
- `stop_reason=rounds_exceeded`: the bot appends an "agent round limit"
  note plus any partial preamble text.

**Privacy / safety:**

- `search_chat_history` (the model-callable tool) has its `guild_id` and
  `channel_id` forcibly clamped to the caller's actual context inside the
  agent loop. See `SECURITY.md`.

---

## `@bot <text>` (mention)

Same agent path as `/ask`, triggered by mentioning the bot in any channel
it can see. The text after the mention is the question. Identical rate
limit, budget cap, and persistence flow.

The mention path uses `message.reply` (which shows "replying to X") and
seeds the reply with `_…_` so subsequent stream updates can edit in place.

Bots are skipped (`message.author.bot`) and the bot ignores its own
messages.

---

## `/search`

Semantic search over the persisted chat history. pgvector HNSW when
Supabase is configured; SQLite cosine fallback otherwise (transparent to
the caller — the `backend` field in the response identifies which path
served the query).

**Options:**

| Name | Type | Required | Constraints |
|---|---|---|---|
| `query` | string | yes | Max length 500 chars. |
| `scope` | choice | no | `channel` (default) or `all`. Forced to `channel` when called from a DM. |
| `limit` | int | no | `[1, 15]`. Default 5. |

**Behavior:**

- Ephemeral by default; rendering up to 15 embed fields with deep-link
  jump buttons when the source `discord_message_id` is known.
- The SQLite fallback reports `corpus_scanned`; the pgvector backend
  doesn't (HNSW returns top-K without a scan count).
- Privacy: `scope=all` is forced to `channel` in DMs to prevent leakage
  between users' DMs. The agent layer also clamps `guild_id` against the
  caller's actual guild when the tool is invoked indirectly by the model.

---

## `/summarize`

Brief of the last N messages in the channel. Dedicated agent path with
its own system prompt — does not use the tool-use loop.

**Options:**

| Name | Type | Required | Constraints |
|---|---|---|---|
| `messages` | int | no | `[10, 500]`. Default 100. |

**Behavior:**

- `deferReply()` immediately, then streams the summary.
- Counts against the same per-user rate limit and budget cap as `/ask`.
- Audited identically (cost, latency, tool_rounds=0).

---

## `/forget`

Clears the per-channel short-term-context cutoff. The next short-term
context load filters out messages older than the cutoff timestamp.
**Non-destructive** — older messages stay in SQLite and remain
searchable via `/search`.

Implemented by writing a row to the `channel_cutoffs` table. The cutoff
is then `max(rollingTimeWindow, cutoffMs)` on every short-term load.

No options. Ephemeral reply.

---

## `/remember`, `/notes`, `/forget-note`, `/forget-notes`

Per-user persistent notes that surface in every future system prompt for
that user. Stored in the `user_notes` table; rendered in the
`[NOTES FOR THIS ASKER]` block which sits **after** the cache breakpoint
so per-user notes don't bust the shared prompt cache.

**Caps:** 12 notes × 280 chars per user. The cap surfaces as an
ephemeral message when exceeded.

- `/remember note:<text>` — required string, max 280 chars (Discord
  enforces). Trimmed; empty after trim → ephemeral rejection.
- `/notes` — ephemeral listing, numbered 1..N. Truncates with "_(N more
  not shown)_" if the rendered list exceeds Discord's 2000-char message
  cap.
- `/forget-note number:<N>` — required int, `[1, 12]`. References the
  number from `/notes`. Out-of-range or missing notes return an explicit
  message rather than a silent no-op.
- `/forget-notes` — clears every note for the calling user; reports the
  count cleared.

---

## `/export`

Download this channel's persisted Q&A as a JSON attachment.

**Behavior:**

- Ephemeral reply; only the caller sees the attachment.
- `messages` array carries `id`, `role`, `user_id`, `username`, `content`,
  `model`, `tool_uses`, `tokens.input`/`output`, `cost_usd`, `latency_ms`,
  `created_at` (ISO).
- The binary `embedding` column is excluded.
- Capped at 10000 rows (`EXPORT_ROW_CAP` in `src/memory.js`); truncation
  is announced in the response.
- Discord attachments are capped at 25MB per server (unboosted); the bot
  refuses ≥24MB with a message pointing the user at `/search`.

No options. Ephemeral.

---

## `/usage`

Cost / token / latency rollup over a window.

**Options:**

| Name | Type | Required | Constraints |
|---|---|---|---|
| `hours` | int | no | `[1, 720]`. Default 24. |

**Renders (in an embed):**

- Total turns, total cost (USD), total input/output/cache-read tokens.
- avg / p50 / p95 latency (R-7 percentile, computed in JS).
- Prompt-cache hit ratio (cache_read / total_input). Useful to see
  whether the static prompt prefix is being cached effectively.
- Per-model breakdown (turns + cost).
- Per-tool breakdown (calls + avg latency).
- Feedback counts (👍 vs 👎).
- Per-user spend breakdown — **owner-only**. Other callers don't see this
  field at all.
- Daily-cap headroom for the caller when `DAILY_USER_COST_CAP_USD` is set.

Ephemeral (no need to broadcast spend).

---

## `/health`

Subsystem reachability + lifecycle state. Designed to be the first
diagnostic when someone says "the bot is acting weird."

**Renders:**

- Process: pid, uptime, RSS.
- Configured model.
- Total persisted messages.
- Embed pending / sync pending counts.
- Total embedded / total synced.
- Embedder failure counters, **split by side** (embed vs sync) — Voyage
  failures vs pgvector upsert failures need different remediation.
- Supabase pgvector reachability + latency (or "disabled" / "UNREACHABLE").
- Voyage enabled state + model.
- Web search / fetch enabled flags.
- Attached DuckDB shards with size and mtime, or "none attached".
- Tool cache stats: entries / hit rate / hits / misses.
- SQLite integrity probe (`PRAGMA integrity_check(1)`).
- Lifecycle: `running` vs `SHUTTING DOWN`, in-flight counter.

Ephemeral, no options. See `docs/OPERATIONS.md` for incident playbooks
keyed on `/health` symptoms.

---

## `/about`

Capability tour. Composed dynamically from `config` so a forker running
without Supabase doesn't see live-data tools advertised that don't exist.

**Renders:**

- Model label + active integrations summary.
- `Ask` line referring to `/ask` and `@bot`.
- `Live data` field listing the eight market-data tools — only when
  Supabase is configured.
- `Memory and research` field listing `search_chat_history` /
  `query_duckdb` / web tools — only when their backend is configured.
- `Commands` line enumerating every public command.
- `Personal context` line for `/remember` + `/notes` + `/forget-note(s)`.
- `Style` line — the no-fluff voice contract.
- Footer with the operator handle + name from env.

Public reply. No options.

---

## `/admin`

Operator-gated utilities. Authorization gates on
`OWNER_DISCORD_USER_ID`; anything that fails the check returns "Not
authorized" ephemerally and logs at `warn` level.

**Subcommands:**

| Subcommand | Options | What it does |
|---|---|---|
| `rebuild-embeddings` | — | Clears every local `embedding` blob and every `pgvector_sync` row. Wipes the Supabase `discord_chat_memory` mirror via `DELETE local_id=gte.0`. Flushes the in-process tool cache so `search_chat_history`'s 30s TTL doesn't serve stale-corpus results. The background embedder re-embeds and re-syncs on the next tick. |
| `backup` | — | Online `VACUUM INTO` snapshot of the SQLite store. Reports output path, size in MB, elapsed ms, and rotation count. |
| `reset-rate-limit` | `user:<User>` | Clears the in-memory rate-limit bucket for a single user. |
| `feedback` | `hours:<int>` | Renders the most recent 👍/👎 reactions joined back to the original question + the bot's reply. Default lookback 168h. Useful for postmortem without scraping logs. |

All `/admin` responses are ephemeral.

---

## Reaction feedback (👍 / 👎)

Reactions on any **bot-authored** message that the bot has a
`discord_message_id` for trigger feedback capture. Stored in the
`feedback` table with `UNIQUE(assistant_message_id, user_id)` so a user's
vote replaces, not appends.

Handled by `bot.js handleReactionChange`. Both adds and removes are
processed. Partial messages and partial reactions are fetched before the
bot-author check; without that fetch, reactions on aged-out messages
silently drop.

**Surfaces:**

- `/usage` shows up/down counts in the configured window.
- `/admin feedback` shows the most recent reactions joined to the
  question and reply through the `turns` table.

---

## Implementation checklist when adding a new command

1. Add a `SlashCommandBuilder` entry in `scripts/register-commands.js`
   with the right options, choices, and ranges.
2. Add a `handle<Name>` function in `src/bot.js`.
3. Add a `case '<name>'` in `handleSlashCommand`.
4. If the command does anything expensive (DB aggregation, multi-second
   wait), call `interaction.deferReply()` up front. Discord's
   initial-response deadline is 3 seconds; `deferReply` gives 15 minutes.
5. Set `flags: MessageFlags.Ephemeral` on personal / large responses.
6. Use `allowedMentions: SAFE_ALLOWED_MENTIONS` on any bot-authored
   content to prevent accidental `@everyone` notifications from model
   output.
7. Add an entry to this document.
8. Run `npm run register` to publish the new command to Discord.

For owner-gated commands, gate on `isOwner(interaction.user.id)` at the
top of the handler and log refused calls at `warn`.
