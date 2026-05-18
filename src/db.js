// SQLite wrapper for conversation persistence. Uses Node 22's built-in
// node:sqlite — no native compilation step, no @types friction, no
// better-sqlite3 dependency to wrestle with on Windows.
//
// The DB file lives at config.memory.dbPath (default ./data/conversation.db).
// Schema migrations run at module init: idempotent CREATE TABLE IF NOT EXISTS
// + ALTER TABLE for column additions. Bumping the schema is a matter of
// appending a new migration block to migrations[]; previously-run blocks are
// tracked in the `schema_meta` table by name.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const absPath = resolve(config.memory.dbPath);
mkdirSync(dirname(absPath), { recursive: true });

export const db = new DatabaseSync(absPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_meta (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
`);

const applied = new Set(
  db.prepare('SELECT name FROM schema_meta').all().map((r) => r.name)
);

const migrations = [
  {
    name: '001_messages',
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        guild_id TEXT,
        user_id TEXT NOT NULL,
        username TEXT,
        discord_message_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        model TEXT,
        tool_uses TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cost_usd REAL,
        latency_ms INTEGER,
        embedding BLOB,
        embedding_model TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_time
        ON messages(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_user_time
        ON messages(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_embedding_pending
        ON messages(id) WHERE embedding IS NULL AND role = 'user';
    `,
  },
  {
    name: '002_audit',
    sql: `
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_message_id INTEGER,
        assistant_message_id INTEGER,
        model TEXT,
        stop_reason TEXT,
        tool_rounds INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cost_usd REAL,
        latency_ms INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_message_id) REFERENCES messages(id),
        FOREIGN KEY (assistant_message_id) REFERENCES messages(id)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_channel_time ON turns(channel_id, created_at DESC);
    `,
  },
  {
    name: '003_pgvector_sync',
    sql: `
      -- Tracks which embedded rows have been synced to the Supabase pgvector
      -- index. The embedder writes a row here after a successful upsert.
      -- A missing row means "needs sync".
      CREATE TABLE IF NOT EXISTS pgvector_sync (
        local_id INTEGER PRIMARY KEY,
        synced_at INTEGER NOT NULL
      );
    `,
  },
  {
    name: '004_feedback',
    sql: `
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assistant_message_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        sentiment TEXT NOT NULL CHECK (sentiment IN ('up', 'down')),
        emoji TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (assistant_message_id, user_id),
        FOREIGN KEY (assistant_message_id) REFERENCES messages(id)
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_sentiment ON feedback(sentiment, created_at DESC);
    `,
  },
  {
    name: '005_user_notes',
    sql: `
      CREATE TABLE IF NOT EXISTS user_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_notes_user
        ON user_notes(user_id, created_at DESC);
    `,
  },
  {
    name: '006_channel_cutoffs',
    sql: `
      -- Per-channel forget cutoff. /forget sets context_cutoff_ms to the
      -- current time. loadShortTermContext filters out messages older than
      -- this timestamp from the short-term window so they no longer feed
      -- into the model. Long-term semantic search is unaffected — the
      -- messages stay in the messages table and remain searchable.
      CREATE TABLE IF NOT EXISTS channel_cutoffs (
        channel_id TEXT PRIMARY KEY,
        context_cutoff_ms INTEGER NOT NULL
      );
    `,
  },
  {
    name: '007_turns_lookup_indexes',
    sql: `
      -- Indexes for the JOINs the embedder's pgvector-pending query
      -- and the postmortem report do per row. Without them, every
      -- LEFT JOIN turns ON t.user_message_id = m.id was a full scan
      -- of turns — measurable on a long-lived store, invisible on a
      -- fresh one. SQLite does NOT auto-index foreign-key columns.
      CREATE INDEX IF NOT EXISTS idx_turns_user_message
        ON turns(user_message_id);
      CREATE INDEX IF NOT EXISTS idx_turns_assistant_message
        ON turns(assistant_message_id);
    `,
  },
  {
    name: '008_messages_discord_id_index',
    sql: `
      -- findAssistantByDiscordId queries on role + discord_message_id
      -- per reaction event. Without this index the lookup is a full
      -- table scan of messages — fine on a small store, slow on a
      -- year-old one with hundreds of thousands of rows. Partial
      -- index limits storage cost to assistant rows only (the only
      -- ones whose discord_message_id we ever look up via this
      -- query).
      CREATE INDEX IF NOT EXISTS idx_messages_discord_id
        ON messages(discord_message_id)
        WHERE role = 'assistant' AND discord_message_id IS NOT NULL;
    `,
  },
  {
    name: '009_turns_user_time_index',
    sql: `
      -- checkBudget runs userSpendSince(userId, startOfUtcDay) on
      -- every gated /ask, /summarize, and @mention when the budget
      -- cap is enabled. Without (user_id, created_at) the query
      -- either scans the table or uses idx_turns_channel_time
      -- backwards. Either way it's O(n) on the turns count for a
      -- query that should be O(log n) + the matching rows.
      -- Composite covers the user filter plus the created_at range
      -- predicate in one B-tree seek.
      CREATE INDEX IF NOT EXISTS idx_turns_user_time
        ON turns(user_id, created_at DESC);
    `,
  },
  {
    name: '010_user_preferences',
    sql: `
      -- Per-user model preference for /ask and @mention. Stored as a
      -- short label (sonnet|opus|haiku) rather than the full model id
      -- so a future model-version bump (e.g. sonnet-4.6 → sonnet-4.7)
      -- does not require migrating every saved preference. The
      -- runtime resolution maps label → current model id via the
      -- MODEL_CHOICES table in src/bot.js.
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY,
        preferred_model TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

for (const m of migrations) {
  if (applied.has(m.name)) continue;
  db.exec('BEGIN');
  try {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_meta (name, applied_at) VALUES (?, ?)').run(
      m.name,
      Date.now()
    );
    db.exec('COMMIT');
    logger.info('sqlite migration applied', { name: m.name });
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`sqlite migration ${m.name} failed: ${err.message}`, { cause: err });
  }
}

process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
});
