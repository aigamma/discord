// Background embedder + pgvector syncer. Two concurrent jobs on one timer:
//
//   1. Embed any persisted user messages that don't yet have a Voyage
//      embedding stored locally.
//   2. Push embedded rows up to the Supabase pgvector index if they have
//      not been synced yet.
//
// Local SQLite is source of truth — pgvector is a downstream search index.
// On Supabase failure the local rows still carry their embeddings; sync
// retries on the next tick. The bot's search tool falls back to local
// cosine when pgvector is unreachable so search never goes hard down.

import { embed, vecToBlob, blobToVec, isEnabled as voyageEnabled } from './embeddings.js';
import { logger } from './logger.js';
import { config } from './config.js';
import {
  getPendingEmbeddings,
  pendingEmbeddingsCount,
  setEmbedding,
  getPendingPgvectorRows,
  markSynced,
  getAssistantRowFor,
} from './memory.js';
import { upsertChatMemory, isEnabled as pgvectorEnabled } from './pgvector.js';

const INTERVAL_MS = 10_000;
const EMBED_BATCH_SIZE = 32;
const SYNC_BATCH_SIZE = 64;

let running = false;
let timer = null;
let initialKick = null;
let embedRuns = 0;
let embedded = 0;
let synced = 0;
let failures = 0;

async function embedTick() {
  const rows = getPendingEmbeddings(EMBED_BATCH_SIZE);
  if (rows.length === 0) return;

  const texts = rows.map((r) => r.content.slice(0, 8000));
  const vectors = await embed(texts, { inputType: 'document' });

  // Defensive: if Voyage returns fewer vectors than requested (a length
  // mismatch theoretically possible on partial response), don't write
  // garbage to setEmbedding. Skip the orphans; the SQL query will return
  // them again next tick. Logged so the operator can investigate.
  let writes = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = vectors[i];
    if (!v || typeof v.byteLength !== 'number') {
      try { logger.warn('embedder: voyage returned no vector for row', { row_id: rows[i].id, batch_index: i }); } catch { /* */ }
      continue;
    }
    setEmbedding(rows[i].id, vecToBlob(v), config.voyage.model);
    writes++;
  }
  embedded += writes;
  embedRuns++;
}

async function pgvectorTick() {
  if (!pgvectorEnabled()) return;
  const rows = getPendingPgvectorRows(SYNC_BATCH_SIZE);
  if (rows.length === 0) return;

  const payload = rows.map((r) => {
    const base = {
      local_id: r.id,
      channel_id: r.channel_id,
      guild_id: r.guild_id,
      user_id: r.user_id,
      username: r.username,
      role: r.role,
      content: r.content,
      embedding: blobToVec(r.embedding),
      embedding_model: r.embedding_model,
    };
    if (r.role === 'user') {
      const reply = getAssistantRowFor(r.id);
      if (reply) {
        base.reply_local_id = reply.local_id;
        base.reply_content = reply.content;
      }
    }
    return base;
  });

  await upsertChatMemory(payload);
  for (const row of rows) markSynced(row.id);
  synced += rows.length;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    try {
      await embedTick();
    } catch (err) {
      failures++;
      try { logger.error('embedder embed tick failed', { err }); } catch { /* logger refused */ }
    }
    try {
      await pgvectorTick();
    } catch (err) {
      failures++;
      try { logger.error('embedder pgvector sync failed', { err }); } catch { /* logger refused */ }
    }
  } finally {
    running = false;
  }
}

export function startBackgroundEmbedder() {
  if (!voyageEnabled()) {
    logger.info('embedder skipped: Voyage not configured');
    return null;
  }
  if (timer) return timer;

  const pending = pendingEmbeddingsCount();
  logger.info('embedder started', {
    pending,
    pgvector_enabled: pgvectorEnabled(),
    interval_seconds: INTERVAL_MS / 1000,
  });

  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  // Track the initial kick so a shutdown signal landing in the first
  // second cancels it cleanly. Without this, a tick could fire against
  // a closing SQLite DB right after lifecycle.onShutdown started.
  initialKick = setTimeout(() => {
    initialKick = null;
    tick().catch(() => {});
  }, 1000);
  return timer;
}

// Stop scheduling new ticks and await the in-flight one if any. The
// embedder writes to SQLite and Supabase, both of which we want to
// finish cleanly before shutdown closes the database.
export async function stopBackgroundEmbedder({ waitMs = 5000 } = {}) {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (initialKick) {
    clearTimeout(initialKick);
    initialKick = null;
  }
  if (!running) return;
  const deadline = Date.now() + waitMs;
  // ESLint can't see that `running` is mutated by the concurrent tick()
  // function in its finally block. The loop terminates either when tick
  // completes (running flips to false) or when the deadline elapses.
  // eslint-disable-next-line no-unmodified-loop-condition
  while (running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (running) {
    logger.warn('embedder still running at shutdown deadline; in-flight write may be lost', { wait_ms: waitMs });
  }
}

export function getEmbedderStats() {
  return {
    embed_runs: embedRuns,
    embedded_total: embedded,
    synced_total: synced,
    failures,
    pending_embed: pendingEmbeddingsCount(),
  };
}
