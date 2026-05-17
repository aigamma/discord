// Owner-only /admin operations. Authorization gates on the OWNER_DISCORD_USER_ID
// env var: anything that fails that check returns a refusal silently to the
// caller and logs at warn level. No subcommand mutates Discord state; the
// blast radius is local SQLite + the embedder queue.

import { config } from './config.js';
import { logger } from './logger.js';
import { clearAllEmbeddings, recentFeedback } from './memory.js';
import { reset as resetRateLimit } from './rateLimiter.js';
import { runBackup } from './backup.js';

export function isOwner(userId) {
  return Boolean(config.discord.ownerId) && userId === config.discord.ownerId;
}

export async function rebuildEmbeddings() {
  const cleared = clearAllEmbeddings();
  logger.info('admin: embeddings cleared for rebuild', { cleared });
  return { cleared, note: 'Background embedder will re-embed on the next tick.' };
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
  const rows = recentFeedback({ hours, limit: 25 });
  return { window_hours: hours, count: rows.length, rows };
}
