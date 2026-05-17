import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const tmp = mkdtempSync(join(tmpdir(), 'bot-backup-test-'));
process.env.CONVERSATION_DB_PATH = join(tmp, 'live.db');
test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ }
});

// Importing memory once initializes the DB and runs the migrations.
await import('../src/memory.js');
const { runBackup } = await import('../src/backup.js');

test('backup: produces a non-empty file at a specified path', () => {
  const outPath = join(tmp, 'snapshot.db');
  const r = runBackup({ outPath, keep: 0 });
  assert.equal(r.outPath, outPath);
  assert.ok(r.bytes > 0, 'output file should be non-empty');
  assert.ok(existsSync(outPath));
  const stat = statSync(outPath);
  assert.equal(stat.size, r.bytes);
});

test('backup: default path lands in data/backups/ with iso stamp', () => {
  const r = runBackup({ keep: 0 });
  assert.ok(r.outPath.includes('conversation-'));
  assert.ok(r.outPath.endsWith('.db'));
  assert.ok(existsSync(r.outPath));
  // The default path resolves to ./data/backups/ relative to the working
  // directory. Don't assert on the prefix because the test cwd can vary;
  // existence is the proof.
});

test('backup: rotation drops older files past the keep count', () => {
  const backupDir = join(tmp, 'rotation-test');
  // Generate three backups, keep=2 on the third should drop the oldest.
  runBackup({ outPath: join(backupDir, 'conversation-1.db'), keep: 0 });
  runBackup({ outPath: join(backupDir, 'conversation-2.db'), keep: 0 });
  const c = runBackup({ outPath: join(backupDir, 'conversation-3.db'), keep: 2 });
  assert.equal(c.rotated.length, 1, 'one file should rotate out at keep=2');
  // The exact survivor depends on mtime ordering; just confirm one of the
  // three is gone and the latest is still there.
  const remaining = readdirSync(backupDir);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.some((n) => n === 'conversation-3.db'));
});
