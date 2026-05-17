import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const tmp = mkdtempSync(join(tmpdir(), 'bot-notes-test-'));
process.env.CONVERSATION_DB_PATH = join(tmp, 'test.db');
test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ }
});

const {
  addUserNote, listUserNotes, clearUserNotes, deleteUserNote,
  loadUserNotesAsBlock,
} = await import('../src/memory.js');

test('user notes: add + list roundtrip', () => {
  const u = 'u-add-' + Math.random();
  assert.deepEqual(listUserNotes(u), []);
  const r = addUserNote({ userId: u, content: 'I prefer puts over calls' });
  assert.equal(r.ok, true);
  assert.ok(r.id > 0);
  const notes = listUserNotes(u);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, 'I prefer puts over calls');
});

test('user notes: empty content rejected', () => {
  const u = 'u-empty-' + Math.random();
  assert.equal(addUserNote({ userId: u, content: '' }).ok, false);
  assert.equal(addUserNote({ userId: u, content: '   ' }).ok, false);
});

test('user notes: cap enforced at 12 notes per user', () => {
  const u = 'u-cap-' + Math.random();
  for (let i = 0; i < 12; i++) {
    assert.equal(addUserNote({ userId: u, content: `note ${i}` }).ok, true);
  }
  const overflow = addUserNote({ userId: u, content: 'one too many' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'full');
  assert.equal(overflow.cap, 12);
});

test('user notes: content truncated to 280 chars', () => {
  const u = 'u-trunc-' + Math.random();
  const long = 'x'.repeat(500);
  const r = addUserNote({ userId: u, content: long });
  assert.equal(r.ok, true);
  const notes = listUserNotes(u);
  assert.equal(notes[0].content.length, 280);
});

test('user notes: users isolated', () => {
  const u1 = 'u-iso1-' + Math.random();
  const u2 = 'u-iso2-' + Math.random();
  addUserNote({ userId: u1, content: 'user-one note' });
  assert.deepEqual(listUserNotes(u2), []);
  assert.equal(listUserNotes(u1).length, 1);
});

test('user notes: clearUserNotes wipes only the caller', () => {
  const u1 = 'u-clr1-' + Math.random();
  const u2 = 'u-clr2-' + Math.random();
  addUserNote({ userId: u1, content: 'first' });
  addUserNote({ userId: u1, content: 'second' });
  addUserNote({ userId: u2, content: 'someone elses note' });
  assert.equal(clearUserNotes(u1), 2);
  assert.deepEqual(listUserNotes(u1), []);
  assert.equal(listUserNotes(u2).length, 1);
});

test('user notes: deleteUserNote requires matching user (security)', () => {
  const owner = 'u-own-' + Math.random();
  const other = 'u-other-' + Math.random();
  const r = addUserNote({ userId: owner, content: 'private' });
  // Wrong user_id: should be a no-op
  assert.equal(deleteUserNote({ userId: other, id: r.id }), 0);
  assert.equal(listUserNotes(owner).length, 1);
  // Right user_id: success
  assert.equal(deleteUserNote({ userId: owner, id: r.id }), 1);
});

test('user notes: loadUserNotesAsBlock formats for prompt', () => {
  const u = 'u-blk-' + Math.random();
  assert.equal(loadUserNotesAsBlock(u), null);
  addUserNote({ userId: u, content: 'I trade SPX' });
  addUserNote({ userId: u, content: 'I dislike calendar spreads' });
  const block = loadUserNotesAsBlock(u);
  assert.ok(block.includes('[NOTES FOR THIS ASKER]'));
  assert.ok(block.includes('1. I trade SPX'));
  assert.ok(block.includes('2. I dislike calendar spreads'));
});

test('user notes: loadUserNotesAsBlock embeds username when provided', () => {
  const u = 'u-named-' + Math.random();
  addUserNote({ userId: u, content: 'I want concise answers' });
  const block = loadUserNotesAsBlock(u, 'Blue');
  assert.ok(block.includes('Blue'), 'username should appear in the block header');
});
