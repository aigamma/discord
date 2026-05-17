// Online SQLite backup primitive. Uses VACUUM INTO against the running
// db connection so the bot can keep writing through the snapshot. Output
// is a fully self-contained .db file (no WAL/SHM siblings needed).
//
// Two callers:
//   - scripts/backup-db.js  — CLI for cron / one-off snapshots.
//   - /admin backup         — operator-triggered, in-process call.

import { mkdirSync, statSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { db } from './db.js';

export function runBackup({ outPath = null, keep = 14 } = {}) {
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resolvedOut = outPath
    ? resolve(outPath)
    : resolve(`./data/backups/conversation-${isoStamp}.db`);
  mkdirSync(dirname(resolvedOut), { recursive: true });

  const t0 = Date.now();
  db.exec(`VACUUM INTO '${resolvedOut.replace(/'/g, "''")}'`);
  const elapsedMs = Date.now() - t0;
  const bytes = statSync(resolvedOut).size;

  const rotated = [];
  const dir = dirname(resolvedOut);
  if (existsSync(dir) && keep > 0) {
    const files = readdirSync(dir)
      .filter((n) => n.startsWith('conversation-') && n.endsWith('.db'))
      .map((n) => ({ name: n, path: join(dir, n), mtime: statSync(join(dir, n)).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(keep)) {
      unlinkSync(old.path);
      rotated.push(old.name);
    }
  }

  return { outPath: resolvedOut, bytes, mb: +(bytes / 1024 / 1024).toFixed(2), elapsedMs, rotated };
}
