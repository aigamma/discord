# AGENTS.md — Fresh-Agent Orientation

You are an AI coding agent working on this repository. Read this file **before**
your first change. It is the source-of-truth orientation doc — it tells you
what this project is, how it is laid out, what to touch carefully, and how to
verify a change before declaring it done.

This document complements (does not replace):

- `README.md` — user-facing setup and capability tour.
- `ARCHITECTURE.md` — long-form architecture reference (module map, request
  lifecycle, memory model, observability).
- `CLAUDE.md` — short-form architectural summary, same shape as
  `ARCHITECTURE.md` condensed.
- `DATA_CONTRACTS.md` — the schemas the bot expects from every external
  integration. **Required reading before touching any tool or migration.**
- `docs/COMMANDS.md`, `docs/TOOLS.md`, `docs/CONFIG.md` — single-source-of-truth
  references for the slash command surface, the model-callable tool catalog,
  and the environment-variable surface.
- `docs/OPERATIONS.md` — runbook for operating and debugging the bot.
- `docs/DATA_SETUP.md` — step-by-step guide to hooking the bot up to its data
  layer.
- `SECURITY.md` — threat model and the three-layer DuckDB defense.
- `CONTRIBUTING.md` — workflow, voice, style.

If anything in this file conflicts with one of those, the more specific doc
wins; flag the conflict in your PR description so it gets resolved.

---

## What this project is

A Discord bot that turns Claude Sonnet 4.6 into a desk-mate for a private
trading community. It reasons over live market data via Anthropic tool use,
remembers conversations via SQLite plus a pgvector mirror, queries multi-year
DuckDB shards from a research backtester, and never opens with sycophancy.

It is MIT licensed and designed to be forked. The voice is enforced by the
system prompt and pinned by tests; **do not weaken those assertions**.

The default deployment serves Options Alchemy (Blue / Eric Allione). A fork
swaps the operator identity via env vars (`OPERATOR_HANDLE`, `OPERATOR_NAME`,
`COMMUNITY_NAME`) without editing source.

---

## Repository layout

```
/                               Top-level docs (README, ARCHITECTURE,
                                DATA_CONTRACTS, CLAUDE, SECURITY, CONTRIBUTING,
                                CHANGELOG, AGENTS, LICENSE)
.env.example                    Annotated env-var template
docs/                           Detailed reference docs (COMMANDS, TOOLS,
                                CONFIG, OPERATIONS, DATA_SETUP, EXAMPLES)
src/                            All runtime code (ESM, Node 22+)
src/tools/                      One file per model-callable tool
migrations/                     Supabase pgvector SQL (the bot's SQLite
                                migrations live inline in src/db.js)
scripts/                        One-off CLIs (register-commands, verify,
                                backup-db, postmortem)
test/                           node:test suites (run with `npm test`)
data/                           SQLite store; gitignored; created on launch
.github/workflows/test.yml      CI: tests + node --check on every push
```

The directory shape is small on purpose. There is no `src/commands/`
subdirectory — slash command handlers all live in `src/bot.js`. There is no
ORM, no DI container, no plugin manifest. Adding a feature usually means
editing a file already in this list.

---

## How a turn flows

When you change anything in the agent path, you should know this flow:

```
Discord user types /ask
  → bot.js handleAsk (rate limit, budget cap, deferReply, progress reporter)
  → agent.js answer()
      → beginWork() (lifecycle drain counter)
      → memory.js loadShortTermContext (last N msgs in channel within window)
      → memory.js loadUserNotesAsBlock (per-user /remember notes)
      → prompt.js buildSystemPrompt (CORE + IDENTITY + CONSTRAINTS +
        DEFINITIONS + TOOLS, cache_control at end of static prefix,
        TEMPORAL block after the breakpoint, NOTES tail per-user)
      → for round 0..MAX_TOOL_ROUNDS (8):
          → withAnthropicRetry(client.messages.stream)
          → if stop_reason !== tool_use: capture text, break
          → else execute tool blocks in parallel via Promise.all
                + clamp search_chat_history's guild_id/channel_id at this layer
          → append assistant + tool_result blocks to messages
      → persist user message + assistant message + turns audit row
      → releaseWork()
  → bot.js chunk(text), reporter.finalize, follow-up parts
  → attachDiscordMessageId for future feedback lookup

Background (every 10s):
  embedder.js tick → embed pending user messages via Voyage → upsert to
  Supabase pgvector → mark synced.
```

Read `ARCHITECTURE.md > Turn lifecycle` for the long form. Read `src/agent.js`
top-to-bottom before changing any of that file.

---

## What to touch carefully

Some surfaces have invariants enforced by tests, security boundaries, or
external contracts. Editing them naively will break things in ways the
diff does not show.

### `src/prompt.js` — voice and identity

The system prompt is the bot's voice. Every line of `BEHAVIORAL_CONSTRAINTS`
is pinned by `test/prompt.test.js`. The prompt is composed of named blocks:

1. `CORE_PERSONA` — model identity + audience
2. `OPERATOR_IDENTITY` — env-driven, fork-customizable
3. `BEHAVIORAL_CONSTRAINTS` — the voice (no preambles, no flattery,
   declarative endings, no em-dashes, no bullets, no analogies)
4. `SITE_DEFINITIONS` — 25Δ risk-reversal sign convention, VRP sign,
   GEX sign, vol-flip definition
5. `TOOLS_BLOCK` or `NO_TOOLS_BLOCK` (chosen by Supabase availability)
6. `[TIME AND MARKET SESSION]` — per-turn, with NYSE holiday calendar

The `cache_control: ephemeral` breakpoint sits at the end of block 5. Anything
**before** the breakpoint must stay byte-identical across turns; anything
**after** can vary per turn or per user.

**Don't:**
- Loosen any of the `BEHAVIORAL_CONSTRAINTS` assertions in
  `test/prompt.test.js` without flagging it explicitly.
- Move the temporal block above the cache breakpoint. That would bust the
  cache on every turn.
- Move user notes above the cache breakpoint. Per-user content must sit in
  the per-turn tail or the cache hit rate collapses.
- Hard-code the operator handle / name. Use `config.operator.*`.

### `src/duckdb.js` — three-layer SQL guard

The `query_duckdb` tool exposes SELECT access to multi-year option chains.
Three independent layers must hold simultaneously:

1. `isReadOnlySelect(sql)` — single-statement SELECT/WITH only, keyword
   blocklist, function-name deny list.
2. The DuckDB attach is `READ_ONLY` per-shard.
3. Engine-level `SET enable_external_access = false` + `SET
   lock_configuration = true` applied **after** the attach.

If you find yourself loosening any of these to make a query work, stop —
the query is wrong, not the guard. The function-name deny list and the
engine lockdown both prevent the same class of exploit (`SELECT * FROM
read_csv('/etc/passwd')`); leaving only one in place is not safe.

`test/duckdbGuard.test.js` pins the predicate. Don't relax it.

### `src/agent.js` — privacy clamp on tool inputs

Inside the agent loop, before any tool executes, the agent forcibly overrides
`search_chat_history`'s `guild_id` and `channel_id` against the **caller's
actual** Discord context. This is defense in depth against prompt injection
that tries to widen the scope to other guilds or other users' DMs.

If you add a new privacy-sensitive tool, add it to that clamping block.
`SECURITY.md > Prompt-injection-aware tool clamping` is the authoritative
description of this layer.

### `src/db.js` — schema migrations

Migrations are idempotent and tracked in `schema_meta` by name. Bumping the
schema is appending a new entry to the `migrations[]` array; previously-run
blocks are skipped on restart.

**Don't:**
- Rename or delete an existing migration. The `name` is the idempotency key;
  a rename re-runs the block, which on most ALTERs will throw and abort
  startup.
- Drop columns. The bot still reads historic rows; a dropped column is a
  silent NULL coercion at best, a runtime error at worst.
- Add indexes without naming them. The `IF NOT EXISTS` clause only works
  when the index has a stable name.

### `src/pricing.js` — cost accounting

Each supported model needs an entry. The startup logs a warn if the
configured `ANTHROPIC_MODEL` has no pricing entry; cost tracking records
`null` until the entry exists. The daily budget cap silently fails open
during that window. If you add a model id, add a `PRICING` entry in the
same PR, or the budget enforcement becomes a no-op.

### `migrations/discord_chat_memory_*.sql` — pgvector schema

Two SQL files ship for fresh Supabase deployments. Migration 001 creates the
table, the HNSW index, RLS, and the `search_discord_memory` RPC. Migration
002 adds `UNIQUE (local_id)` — required for the embedder's
`on_conflict=local_id` upsert. **Both must be applied in order**. If you
change the embedding dim or the RPC signature, you need a migration 003 plus
a coordinated change to `pgvector.js` and `embeddings.js`.

---

## What "done" looks like

Before declaring a change ready:

1. **Tests pass.** `npm test` runs the full suite (~3s on a fresh checkout).
   `npm run lint` runs ESLint. CI runs both on every push.
2. **The static check passes.** CI also runs `node --check` against every
   source module. If you introduce a syntax error or an invalid ESM import,
   the static check catches it before the test suite even loads.
3. **You added a test for new behavior.** New tools, new commands, new
   migrations, and changes to the system prompt all need test coverage. See
   `test/` for the existing style — no live API calls, per-process tmp
   SQLite stores, prepared statements pinned by name.
4. **The doc-of-truth for that surface is updated.** New env var → update
   `docs/CONFIG.md` AND `.env.example`. New tool → update `docs/TOOLS.md`
   AND the catalog table in `ARCHITECTURE.md`. New command → update
   `docs/COMMANDS.md` AND `scripts/register-commands.js` AND `bot.js`.
5. **The change passes `npm run verify`** if it touches any external
   integration. The verify script pings every configured service and reports
   per-service status. It catches credential/schema errors before users hit
   them.

For UI-affecting changes (the bot's Discord output): there is no automated
way to verify the rendered Discord embed. Read the embed-building code,
double-check field limits (25 fields per embed, ~6000 chars total, 2000
chars per message), and run the bot manually if the user agrees.

---

## How to run things locally

```bash
npm install                     # install deps (no native compilation)
cp .env.example .env.local      # fill in DISCORD_*, ANTHROPIC_API_KEY at minimum
npm run verify                  # ping every configured external service
npm run register                # register slash commands with Discord
npm start                       # run the bot
npm test                        # run the full test suite (~3s)
npm run lint                    # ESLint flat config
npm run backup                  # online SQLite VACUUM INTO snapshot
npm run postmortem -- --hours 168  # audit log + feedback rollup
```

A deployment with no Supabase, no Voyage, no DuckDB still runs — the bot
becomes a tool-free conversational model with short-term memory only. Test
with the minimum required env vars (DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID,
ANTHROPIC_API_KEY) before adding optional integrations.

---

## How to make changes

**Small, logical commits.** One commit per coherent unit of work. The commit
message body explains the **why**, not the **what** (the diff is the what).
No em-dashes (matching the bot's voice rules keeps the codebase consistent).

**Adding a tool.** See `CONTRIBUTING.md > Adding a tool`. Drop a file in
`src/tools/` exporting `{ spec, execute }`. Register in `src/tools/index.js`
under the right gating bucket (`SUPABASE_MODULES`, `MEMORY_MODULES`,
`DUCKDB_MODULES`). Set a cache TTL in `TOOL_TTLS`. Add a test. Update
`docs/TOOLS.md` and the catalog in `ARCHITECTURE.md`.

**Adding a slash command.** Three places to update in lockstep:

1. `scripts/register-commands.js` — Discord-side registration. Choices,
   ranges, max-lengths declared here are enforced by Discord before the
   handler ever runs. Use them as the outer guardrail.
2. `src/bot.js` — handler function plus a `case` in `handleSlashCommand`.
3. `docs/COMMANDS.md` — the source-of-truth entry for the command.

Commands are not visible until `npm run register` is run against the target
guild/global scope. Guild-scoped registration is instant; global takes ~1h
to propagate.

**Adding a migration.** Append a new entry to the `migrations[]` array in
`src/db.js` with a unique `name` (e.g. `010_<what>`). Make the SQL
idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
Don't rename, reorder, or delete existing migrations. If you need to add
a column, use `ALTER TABLE` inside a new migration block.

**Adding an env var.** Update `src/config.js` (parser + validation), then
`.env.example` (annotated section), then `docs/CONFIG.md` (the SoT entry).
If it's an optional integration, gate the dependent feature on the
configured-ness of the env var and make sure the bot still starts cleanly
without it.

---

## What you should not do

These rules exist because the alternative cost real time in the past.

- **Don't invent file paths or function names.** Read the file first. The
  repo is small enough to map directly.
- **Don't add backwards-compatibility shims for code you just wrote.** If
  you renamed a function in this PR, just update the call sites — there is
  no external consumer of internal exports.
- **Don't add `// removed X` or `// TODO refactor` comments.** Delete the
  code or open a follow-up. Stale comments rot.
- **Don't bypass commit hooks** (`--no-verify`, `--no-gpg-sign`). If the
  hook fails, investigate.
- **Don't push to `main` without explicit user direction.** The repo has
  no protected-branch enforcement; rely on the convention.
- **Don't redistribute raw chain data through any tool.** Per-strike IV
  grids, per-contract Greeks, and raw bid/ask are out of scope per the
  data-licensing contract. Tools return computed metrics only.
- **Don't reach for new dependencies** (the dep list is intentionally tiny:
  `@anthropic-ai/sdk`, `@duckdb/node-api`, `discord.js`). If you think you
  need one, justify it in the PR description.
- **Don't loosen the voice tests** in `test/prompt.test.js`. The constraints
  there are the contract with the community.

---

## Where to look when you need to know X

| You need to know… | Look at… |
|---|---|
| Which env vars exist and what they do | `docs/CONFIG.md` |
| Which slash commands exist and what they accept | `docs/COMMANDS.md` |
| Which tools the model can call | `docs/TOOLS.md` |
| The schemas the bot reads from Supabase / DuckDB / Voyage | `DATA_CONTRACTS.md` |
| How a turn flows end-to-end | `ARCHITECTURE.md > Turn lifecycle` |
| How memory is modeled (short-term, long-term, user notes) | `ARCHITECTURE.md > Memory model` |
| What the lifecycle/drain semantics are | `src/lifecycle.js` + `ARCHITECTURE.md > Lifecycle` |
| How to add or evolve a schema migration safely | `docs/MIGRATIONS.md` |
| How the test suite is structured and what it pins | `docs/TESTING.md` |
| How to debug a misbehaving production instance | `docs/OPERATIONS.md` |
| How to wire the bot to a brand-new Supabase / DuckDB / Voyage setup | `docs/DATA_SETUP.md` |
| Why a specific safety guard exists | `SECURITY.md` |
| Examples of what good bot output looks like | `docs/EXAMPLES.md` |
| Recent changes and rationale | `CHANGELOG.md` + `git log` |

---

## When you finish

The PR description should:

1. Name the change in one short sentence.
2. Explain the **why** in two or three sentences. The diff is the what.
3. Note any new env var, new tool, new command, new migration — these need
   the SoT docs updated in the same PR.
4. Note any docs you updated.
5. Confirm `npm test && npm run lint` passes.

If the change touches an external contract (Supabase schema, DuckDB shard
shape, Voyage model dim, the pgvector RPC), update `DATA_CONTRACTS.md` in
the same PR. The data contracts doc is a runtime contract; a missing column
or wrong type is a runtime failure with no warning.

That is enough orientation. Read the files for what you need; the code is
small and well-commented. When in doubt, prefer reading the existing test
to inferring intent from the production code.
