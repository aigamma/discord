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
