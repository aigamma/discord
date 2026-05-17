// Owner-only /admin operations. Authorization gates on the OWNER_DISCORD_USER_ID
// env var: anything that fails that check returns a refusal silently to the
// caller and logs at warn level. No subcommand mutates Discord state; the
// blast radius is local SQLite + the embedder queue.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { logger } from './logger.js';
import { clearAllEmbeddings, recentFeedback } from './memory.js';
import { reset as resetRateLimit } from './rateLimiter.js';

const execAsync = promisify(exec);

export function isOwner(userId) {
  return Boolean(config.discord.ownerId) && userId === config.discord.ownerId;
}

export async function rebuildEmbeddings() {
  const cleared = clearAllEmbeddings();
  logger.info('admin: embeddings cleared for rebuild', { cleared });
  return { cleared, note: 'Background embedder will re-embed on the next tick.' };
}

export async function triggerBackup() {
  const t0 = Date.now();
  const { stdout, stderr } = await execAsync('node --env-file=.env.local scripts/backup-db.js');
  return {
    elapsed_ms: Date.now() - t0,
    stdout: stdout.split('\n').filter(Boolean).slice(-3),
    stderr: stderr ? stderr.slice(0, 400) : null,
  };
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
