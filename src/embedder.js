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
let embedRuns = 0;
let embedded = 0;
let synced = 0;
let failures = 0;

async function embedTick() {
  const rows = getPendingEmbeddings(EMBED_BATCH_SIZE);
  if (rows.length === 0) return;

  const texts = rows.map((r) => r.content.slice(0, 8000));
  const vectors = await embed(texts, { inputType: 'document' });

  for (let i = 0; i < rows.length; i++) {
    setEmbedding(rows[i].id, vecToBlob(vectors[i]), config.voyage.model);
  }
  embedded += rows.length;
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
    await embedTick();
  } catch (err) {
    failures++;
    console.error('[embedder] embed tick failed:', err?.message || err);
  }
  try {
    await pgvectorTick();
  } catch (err) {
    failures++;
    console.error('[embedder] pgvector sync failed:', err?.message || err);
  } finally {
    running = false;
  }
}

export function startBackgroundEmbedder() {
  if (!voyageEnabled()) {
    console.log('[embedder] Voyage not configured; skipping background embedding');
    return null;
  }
  if (timer) return timer;

  const pending = pendingEmbeddingsCount();
  console.log(`[embedder] starting; ${pending} pending; pgvector ${pgvectorEnabled() ? 'enabled' : 'disabled'}; tick every ${INTERVAL_MS / 1000}s`);

  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  setTimeout(() => { tick().catch(() => {}); }, 1000);
  return timer;
}

export function stopBackgroundEmbedder() {
  if (timer) {
    clearInterval(timer);
    timer = null;
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
