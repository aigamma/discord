// Pure tests for the chunk() helper. bot.js uses it to fan a long
// assistant reply across multiple Discord messages, since Discord caps
// each message at 2000 characters.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { chunk, MAX_DISCORD_MESSAGE } = await import('../src/textChunks.js');

test('chunk: short text returns single element', () => {
  assert.deepEqual(chunk('hello world'), ['hello world']);
});

test('chunk: text exactly at the cap stays in one part', () => {
  const text = 'a'.repeat(MAX_DISCORD_MESSAGE);
  const parts = chunk(text);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].length, MAX_DISCORD_MESSAGE);
});

test('chunk: text just over the cap splits cleanly', () => {
  const text = 'a'.repeat(MAX_DISCORD_MESSAGE + 1);
  const parts = chunk(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, MAX_DISCORD_MESSAGE);
  assert.equal(parts[1].length, 1);
});

test('chunk: prefers blank-line breaks when present', () => {
  // ~1000 chars, blank line, ~1500 chars (total > MAX_DISCORD_MESSAGE).
  const a = 'a'.repeat(1000);
  const b = 'b'.repeat(1500);
  const parts = chunk(`${a}\n\n${b}`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], a);
  assert.equal(parts[1], b);
});

test('chunk: falls back to single newline when no blank line in the window', () => {
  // No blank line, but a single newline at position ~1800.
  const a = 'a'.repeat(1800);
  const b = 'b'.repeat(400);
  const parts = chunk(`${a}\n${b}`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], a);
  assert.equal(parts[1], b);
});

test('chunk: falls back to space when no newline in the window', () => {
  // No newline; space at position 1500.
  const a = 'a'.repeat(1500);
  const b = 'b'.repeat(600);
  const parts = chunk(`${a} ${b}`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], a);
  assert.equal(parts[1], b);
});

test('chunk: 2500 unbroken characters get hard-cut at the cap', () => {
  const text = 'x'.repeat(2500);
  const parts = chunk(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, MAX_DISCORD_MESSAGE);
  assert.equal(parts[1].length, 500);
});

test('chunk: three-way split on a 5000-char input', () => {
  const text = 'y'.repeat(5000);
  const parts = chunk(text);
  assert.equal(parts.length, 3);
  // First two should be exactly the cap; last is the remainder.
  assert.equal(parts[0].length, MAX_DISCORD_MESSAGE);
  assert.equal(parts[1].length, MAX_DISCORD_MESSAGE);
  assert.equal(parts[2].length, 5000 - 2 * MAX_DISCORD_MESSAGE);
});

test('chunk: trimStart drops leading whitespace from each subsequent part', () => {
  // The break char is the space; after slice, the next part starts at the
  // space, which trimStart should strip.
  const a = 'a'.repeat(1500);
  const b = 'b'.repeat(600);
  const parts = chunk(`${a} ${b}`);
  assert.ok(!parts[1].startsWith(' '), 'leading space should be trimmed');
});

test('chunk: empty string returns single empty element', () => {
  assert.deepEqual(chunk(''), ['']);
});
