import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const { get, set, keyFor, stats, clear } = await import('../src/toolCache.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('cache: keys are canonical (object key order does not matter)', () => {
  const k1 = keyFor('tool', { a: 1, b: 2 });
  const k2 = keyFor('tool', { b: 2, a: 1 });
  assert.equal(k1, k2);
});

test('cache: array order DOES matter (input semantics)', () => {
  const k1 = keyFor('tool', { syms: ['A', 'B'] });
  const k2 = keyFor('tool', { syms: ['B', 'A'] });
  assert.notEqual(k1, k2);
});

test('cache: set + get roundtrip; miss after clear', () => {
  clear();
  assert.equal(get('foo', { x: 1 }), null);
  set('foo', { x: 1 }, { value: 'hello' }, 30);
  assert.deepEqual(get('foo', { x: 1 }), { value: 'hello' });
});

test('cache: TTL expiry clears the entry', async () => {
  clear();
  set('expiring', { x: 1 }, { v: 1 }, 1); // 1 second
  assert.deepEqual(get('expiring', { x: 1 }), { v: 1 });
  await sleep(1100);
  assert.equal(get('expiring', { x: 1 }), null);
});

test('cache: ttl 0 means no-cache (set is a no-op)', () => {
  clear();
  set('skipped', { x: 1 }, { v: 1 }, 0);
  assert.equal(get('skipped', { x: 1 }), null);
});

test('cache: stats reflect hit/miss accounting', () => {
  clear();
  // 1 miss, then 1 set, then 2 hits, then 1 miss
  assert.equal(get('a', {}), null);          // miss
  set('a', {}, { x: 1 }, 30);
  assert.deepEqual(get('a', {}), { x: 1 });  // hit
  assert.deepEqual(get('a', {}), { x: 1 });  // hit
  assert.equal(get('b', {}), null);          // miss
  const s = stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 2);
  assert.equal(s.hit_rate, 0.5);
});
