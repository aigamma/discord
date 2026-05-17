// Owner-only /admin operations. Authorization gates on the OWNER_DISCORD_USER_ID
// env var: anything that fails that check returns a refusal silently to the
// caller and logs at warn level. No subcommand mutates Discord state; the
// blast radius is local SQLite + the embedder queue.

import { config } from './config.js';
import { logger } from './logger.js';
import { clearAllEmbeddings, recentFeedback } from './memory.js';
import { reset as resetRateLimit } from './rateLimiter.js';
import { runBackup } from './backup.js';
import { clearAllChatMemory, isEnabled as pgvectorEnabled } from './pgvector.js';
import { clear as clearToolCache } from './toolCache.js';

export function isOwner(userId) {
  return Boolean(config.discord.ownerId) && userId === config.discord.ownerId;
}

export async function rebuildEmbeddings() {
  const cleared = clearAllEmbeddings();
  let pgvectorCleared = null;
  if (pgvectorEnabled()) {
    try {
      pgvectorCleared = await clearAllChatMemory();
    } catch (err) {
      logger.warn('admin: pgvector wipe failed; local resync will produce duplicates until reconciled', { err });
    }
  }
  // Also flush the tool result cache so search_chat_history's 30-second
  // TTL doesn't serve stale-corpus results in the window between the
  // rebuild and the background embedder's first catch-up tick.
  clearToolCache();
  logger.info('admin: embeddings cleared for rebuild', { cleared, pgvector_cleared: pgvectorCleared });
  return {
    cleared,
    pgvector_cleared: pgvectorCleared,
    note: 'Background embedder will re-embed and re-sync on the next tick. Tool cache flushed.',
  };
}

export function triggerBackup() {
  const r = runBackup({});
  logger.info('admin: backup', {
    out_path: r.outPath,
    mb: r.mb,
    elapsed_ms: r.elapsedMs,
    rotated: r.rotated.length,
  });
  return r;
}

export function resetUserRateLimit(userId) {
  const cleared = resetRateLimit(userId);
  logger.info('admin: rate limit reset', { user_id: userId, cleared });
  return { cleared, user_id: userId };
}

export function feedbackReport(hours = 168) {
  // Fetch generously so the 'N more not shown' tail count in /admin
  // feedback reflects actual volume rather than capping at SQL-limit
  // minus embed-budget.
  const rows = recentFeedback({ hours, limit: 200 });
  return { window_hours: hours, count: rows.length, rows };
}
