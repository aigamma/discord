# Migrations Reference

Single source of truth for schema evolution. The bot owns two schemas:

1. **Local SQLite** — `data/conversation.db`. Migrations are inline in
   `src/db.js`, applied at module import time, tracked by name in
   `schema_meta`.
2. **Supabase pgvector** — `discord_chat_memory` table. Migrations ship as
   SQL files in `migrations/`, applied manually via `psql` or the Supabase
   SQL editor.

This document is the contract for both. If you change either schema,
update this file in the same PR.

---

## SQLite migrations

### Semantics

- **Append-only.** Migrations are entries in the `migrations[]` array at
  the top of `src/db.js`. New work goes to the bottom of the array.
- **Idempotent.** Each entry's SQL must work on a fresh database AND on a
  database where previous migrations have already run. Use
  `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `ALTER
  TABLE` (with care — see "What not to do").
- **Tracked by name.** The `schema_meta` table records every applied
  migration by its `name` field. On startup, `db.js` reads applied names
  into a Set and skips entries that match.
- **Transactional.** Each migration is wrapped in `BEGIN ... COMMIT` /
  `ROLLBACK`. A partial failure rolls back and aborts startup with a
  clear error.

### The current migration list

| Name | What |
|---|---|
| `001_messages` | The `messages` table, plus `(channel_id, created_at DESC)`, `(user_id, created_at DESC)`, and the partial `embedding IS NULL AND role='user'` index. |
| `002_audit` | The `turns` table (per-turn audit log) plus `(channel_id, created_at DESC)`. |
| `003_pgvector_sync` | The `pgvector_sync` table (which embedded rows have been mirrored to Supabase). |
| `004_feedback` | The `feedback` table with `UNIQUE(assistant_message_id, user_id)` and a sentiment index. |
| `005_user_notes` | The `user_notes` table for `/remember`. |
| `006_channel_cutoffs` | The `channel_cutoffs` table for non-destructive `/forget`. |
| `007_turns_lookup_indexes` | Indexes on `turns(user_message_id)` and `turns(assistant_message_id)` for the embedder's LEFT JOIN. |
| `008_messages_discord_id_index` | Partial index on `messages(discord_message_id) WHERE role='assistant'` for reaction-event lookups. |
| `009_turns_user_time_index` | `turns(user_id, created_at DESC)` for the budget-cap query. |

### Adding a migration

1. **Pick a name.** Use `NNN_<short_descriptor>` where `NNN` is the next
   sequence number. Names are immutable after the migration ships; a
   typo in the name means future bots will re-run the SQL on every
   startup.
2. **Write idempotent SQL.** `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX
   IF NOT EXISTS`. For ALTER TABLE, see below.
3. **Append to `migrations[]` in `src/db.js`.** Always at the bottom.
   Reordering changes which migrations run in which order on a
   half-migrated store and creates incoherent state.
4. **Update this document** with a row in the table above.
5. **Update `ARCHITECTURE.md > Storage > SQLite`** if the change is
   structural (new table, new column on an existing table). Pure
   index additions don't need an architecture update.
6. **Add a test** that exercises the new table or index. The existing
   `test/memory.test.js` is the model: persist some rows, read them
   back, assert.

### What not to do

- **Don't rename a migration.** The `name` is the idempotency key; a
  rename re-runs the SQL block, which on most ALTERs will throw and
  abort startup.
- **Don't reorder migrations.** They run in array order. A reorder
  changes the dependency graph on every install that hasn't run the
  full sequence yet (i.e. every fresh deployment forever).
- **Don't drop columns.** SQLite's `ALTER TABLE DROP COLUMN` works on
  3.35+, but every code path that read the column still expects it.
  Either ignore the column at the application layer or open a
  multi-PR deprecation: stop reading the column → ship → drop it in
  a later migration once every running process is past the "stop
  reading" version.
- **Don't add unindexed `NOT NULL` columns with a default.** ALTER TABLE
  ADD COLUMN with a default writes the default into every existing
  row, locking the WAL for the duration. On a small store this is
  invisible; on a year-old store it blocks every reader. Prefer
  nullable columns plus a backfill script.
- **Don't make a migration depend on a row in another table.** Schema
  migrations should be pure DDL. If you need a backfill, do it in
  code at the next startup or in a separate one-shot script.
- **Don't use `IF NOT EXISTS` on a UNIQUE constraint.** SQLite doesn't
  support `ADD CONSTRAINT IF NOT EXISTS`. Use a unique index instead
  (`CREATE UNIQUE INDEX IF NOT EXISTS ...`) which has the same effect.

### Inspecting the live state

```sql
-- Which migrations have run?
SELECT name, datetime(applied_at/1000, 'unixepoch') AS when_applied
FROM schema_meta ORDER BY applied_at;

-- Current table layout
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;

-- Current indexes
SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY tbl_name, name;

-- Integrity check
PRAGMA integrity_check;
```

The bot's `/health` slash command runs `PRAGMA integrity_check(1)` and
surfaces the result; `npm run verify` runs the full migration chain
against a probe store before users hit it.

---

## Supabase pgvector migrations

### Semantics

- **Manual application.** Unlike SQLite, the bot does NOT apply these
  automatically. Run them once when setting up a Supabase project, then
  again only when this document adds a new file.
- **Files in `migrations/`.** Each is a self-contained SQL file. The
  bot reads from `discord_chat_memory`, never from the file.
- **Order-sensitive.** Apply in numeric order; each builds on the
  previous.

### The current migration list

| File | What |
|---|---|
| `discord_chat_memory_001.sql` | Creates the `discord_chat_memory` table with `vector(1024)`, the HNSW index on `embedding` using `vector_cosine_ops`, RLS enabled, and the `search_discord_memory` RPC. |
| `discord_chat_memory_002_unique_local_id.sql` | Adds `UNIQUE (local_id)`. **Required** — without it, every embedder sync fails with PostgREST `'no unique constraint'`. The bot's upsert uses `on_conflict=local_id`. |

### Adding a migration

1. **Pick a filename.** `discord_chat_memory_NNN_<descriptor>.sql` in
   `migrations/`.
2. **Make it idempotent where you can.** `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`. ALTER TABLE statements are not
   idempotent by default — wrap them in `DO $$ ... END $$` blocks or
   use `IF NOT EXISTS` clauses where supported.
3. **Update this document** with a row in the table above.
4. **Update `DATA_CONTRACTS.md > Supabase: table the bot WRITES`** if
   the schema changes shape.
5. **Update `docs/DATA_SETUP.md > 4b`** so a fresh deployment runs the
   new file.
6. **Coordinate with the embedding-dim change** (if any). The vector
   column dim must match `voyage-3`'s output (1024). Switching to a
   different embedding model with a different dim is a coordinated
   change: new migration that recreates the column + index + RPC,
   plus a code change in `embeddings.js`, plus an
   `/admin rebuild-embeddings` to reseed the corpus.

### What not to do

- **Don't `DROP TABLE discord_chat_memory`.** Even if a downstream
  re-sync would reconstruct it, the running bot can't write to a
  table that's mid-drop. Schedule a maintenance window or use a
  fresh table name and update the bot's queries.
- **Don't change the HNSW operator class** from `vector_cosine_ops`
  to L2 or inner-product without updating the RPC. The bot's
  similarity computation in the RPC is `1 - (embedding <=> query)`
  which is cosine-distance-based.
- **Don't change the embedding dim** without coordinating with the
  embedder. The local SQLite store carries Float32 buffers whose
  byteLength assumes the dim; a mismatch shows up as silent NULL
  embeddings or garbled search results.

---

## Application-layer migration patterns

Sometimes a change isn't purely schema — it's a backfill or a
re-derivation. Examples:

### Backfilling a new column

The migration adds the column nullable. A separate one-shot script
(in `scripts/`) backfills the values. The bot's read path handles
both NULL (pre-backfill) and the populated value.

### Re-embedding the corpus

When the embedding model changes (or `voyage-3` itself updates the
underlying weights), running `/admin rebuild-embeddings` from
Discord wipes every local embedding blob and every
`pgvector_sync` row, deletes every row from the Supabase
`discord_chat_memory` table, and flushes the tool cache. The
background embedder catches up over the next several ticks.

### Renaming a tool

Tool names appear in `messages.tool_uses[].name` for every persisted
turn. Renaming `get_iv_percentile` to `get_iv_rank` would orphan
every historical row. Strategy: ship the new name with a wrapper
that delegates to the old, keep both registered, deprecate the old
in a later release once the audit-log search patterns have flipped.

### Changing a tool's output shape

Tool outputs are JSON-stringified into `tool_uses[].input` and the
content of the `tool_result` block. The model sees the new shape
immediately on next call; the audit log carries both shapes
forever. Postmortem / analytics queries that depend on a specific
JSON path need to handle both during the transition window.

---

## Checklist for any migration PR

- [ ] Migration name / filename is unique and follows the convention.
- [ ] SQL is idempotent (CREATE … IF NOT EXISTS where possible).
- [ ] This document updated (table row + any new "what not to do" notes).
- [ ] `ARCHITECTURE.md` updated if the schema shape changed.
- [ ] `DATA_CONTRACTS.md` updated if a pgvector schema changed.
- [ ] `docs/DATA_SETUP.md` updated if a fresh deployment needs the new file.
- [ ] Test added that exercises the new state.
- [ ] `npm test && npm run lint` pass.
