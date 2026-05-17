import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Stub config-required env vars (rateLimiter transitively imports config).
process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

// Use a small limit so we can test the bucket fill quickly without depending
// on the real default 10/min.
process.env.RATE_LIMIT_REQUESTS_PER_MINUTE = '5';
const { check } = await import('../src/rateLimiter.js');

test('rate limit: first request allowed, count increments', () => {
  const userA = 'u-' + Math.random();
  const r1 = check(userA);
  assert.equal(r1.allowed, true);
  assert.equal(r1.count, 1);
  const r2 = check(userA);
  assert.equal(r2.allowed, true);
  assert.equal(r2.count, 2);
});

test('rate limit: blocks at the limit, reports retry-in', () => {
  const user = 'u-' + Math.random();
  for (let i = 0; i < 5; i++) {
    const r = check(user);
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
  }
  const blocked = check(user);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryInSeconds > 0 && blocked.retryInSeconds <= 60);
  assert.equal(blocked.limit, 5);
});

test('rate limit: users isolated from each other', () => {
  const userA = 'iso-a-' + Math.random();
  const userB = 'iso-b-' + Math.random();
  for (let i = 0; i < 5; i++) {
    assert.equal(check(userA).allowed, true);
  }
  assert.equal(check(userA).allowed, false);
  assert.equal(check(userB).allowed, true, 'second user should be unaffected');
});
