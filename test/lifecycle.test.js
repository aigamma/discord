// lifecycle: in-flight counter behavior is independent of the actual
// signal handlers. installLifecycle wires signal handlers as a side
// effect; we exercise the counter directly. The drain promise and
// shutdown signaling paths are exercised at the integration level.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const { beginWork, inFlightCount, isShuttingDown } = await import('../src/lifecycle.js');

test('lifecycle: beginWork increments inFlightCount', () => {
  const before = inFlightCount();
  const release = beginWork();
  assert.equal(inFlightCount(), before + 1);
  release();
  assert.equal(inFlightCount(), before);
});

test('lifecycle: release is idempotent', () => {
  // A try/finally with an extra catch path can call release twice (or a
  // future refactor that double-wraps the closure). The guard prevents
  // inFlight from dropping below the actual count, which would let the
  // drain promise resolve while real work is still in flight.
  const before = inFlightCount();
  const release = beginWork();
  assert.equal(inFlightCount(), before + 1);
  release();
  assert.equal(inFlightCount(), before);
  release();
  assert.equal(inFlightCount(), before, 'double-release must NOT decrement again');
  release();
  assert.equal(inFlightCount(), before, 'triple-release also no-op');
});

test('lifecycle: many concurrent works tracked correctly', () => {
  const before = inFlightCount();
  const releases = [];
  for (let i = 0; i < 10; i++) releases.push(beginWork());
  assert.equal(inFlightCount(), before + 10);
  for (const r of releases) r();
  assert.equal(inFlightCount(), before);
});

test('lifecycle: isShuttingDown false before any signal', () => {
  assert.equal(isShuttingDown(), false);
});
