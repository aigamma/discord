// One-shot SQLite backup via VACUUM INTO. Online and consistent: the
// running bot can keep writing while this runs, and the output file is a
// fully self-contained copy (no WAL/SHM siblings needed).
//
// Usage:
//   node --env-file=.env.local scripts/backup-db.js              -> ./data/backups/conversation-<ISO>.db
//   node --env-file=.env.local scripts/backup-db.js -o my.db     -> custom path
//
// Suitable for a cron job: keep the most recent N backups and let older
// ones rotate out.

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

import { mkdirSync, statSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const { db } = await import('../src/db.js');

const args = process.argv.slice(2);
let outPath = null;
let keep = parseInt(process.env.BACKUP_KEEP || '14', 10);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' || args[i] === '--out') outPath = args[++i];
  else if (args[i] === '--keep') keep = parseInt(args[++i], 10);
}

const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
if (!outPath) {
  outPath = resolve(`./data/backups/conversation-${isoStamp}.db`);
}
mkdirSync(dirname(outPath), { recursive: true });

const t0 = Date.now();
// VACUUM INTO is the SQLite-recommended online backup primitive. Takes
// a brief read lock; the WAL keeps the running bot writable through it.
db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
const elapsed = Date.now() - t0;

const size = statSync(outPath).size;
console.log(JSON.stringify({
  level: 'info',
  msg: 'backup complete',
  out_path: outPath,
  bytes: size,
  mb: +(size / 1024 / 1024).toFixed(2),
  elapsed_ms: elapsed,
}));

// Rotate: keep only the most recent N files in the backup directory.
const dir = dirname(outPath);
if (existsSync(dir) && keep > 0) {
  const files = readdirSync(dir)
    .filter((n) => n.startsWith('conversation-') && n.endsWith('.db'))
    .map((n) => ({ name: n, path: join(dir, n), mtime: statSync(join(dir, n)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of files.slice(keep)) {
    unlinkSync(old.path);
    console.log(JSON.stringify({ level: 'info', msg: 'backup rotated out', removed: old.name }));
  }
}
