// Background embedder. Polls for unembedded user messages, batches them
// through Voyage, writes embeddings back to SQLite. Runs in-process on a
// loose interval (default 10s); a single failed batch is logged and retried
// on the next tick.
//
// Embeds only user messages because:
//   - Search semantics match: queries are user-style; matching against
//     past user questions surfaces topically related discussions.
//   - The paired assistant response is recoverable via the turns table.
//   - Halves the embedding cost (and call rate).

import { embed, vecToBlob, isEnabled } from './embeddings.js';
import { config } from './config.js';
import { getPendingEmbeddings, pendingEmbeddingsCount, setEmbedding } from './memory.js';

const INTERVAL_MS = 10_000;
const BATCH_SIZE = 32;

let running = false;
let timer = null;
let runs = 0;
let embedded = 0;
let failures = 0;

async function tick() {
  if (running) return;
  running = true;
  try {
    const rows = getPendingEmbeddings(BATCH_SIZE);
    if (rows.length === 0) return;

    const texts = rows.map((r) => r.content.slice(0, 8000));
    const vectors = await embed(texts, { inputType: 'document' });

    for (let i = 0; i < rows.length; i++) {
      setEmbedding(rows[i].id, vecToBlob(vectors[i]), config.voyage.model);
    }
    embedded += rows.length;
    runs++;
  } catch (err) {
    failures++;
    console.error('[embedder] batch failed:', err?.message || err);
  } finally {
    running = false;
  }
}

export function startBackgroundEmbedder() {
  if (!isEnabled()) {
    console.log('[embedder] Voyage not configured; skipping background embedding');
    return null;
  }
  if (timer) return timer;

  const pending = pendingEmbeddingsCount();
  console.log(`[embedder] starting; ${pending} message(s) pending; tick every ${INTERVAL_MS / 1000}s`);

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
  return { runs, embedded, failures, pending: pendingEmbeddingsCount() };
}
