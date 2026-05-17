import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const { createProgressReporter } = await import('../src/progressReporter.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('progress: small deltas debounced; final emit always lands', async () => {
  const edits = [];
  const reporter = createProgressReporter({
    editText: async (text) => { edits.push(text); },
  });
  // First update fires after the debounce timer; without waiting nothing emits.
  reporter.update('a');
  reporter.update('ab');
  reporter.update('abc');
  await sleep(50);
  assert.equal(edits.length, 0, 'sub-threshold delta should not emit');

  await reporter.finalize('abc final');
  assert.equal(edits.length, 1, 'finalize always emits exactly once');
  assert.equal(edits[0], 'abc final');
});

test('progress: first edit lands fast; subsequent updates debounced', async () => {
  const edits = [];
  const reporter = createProgressReporter({
    editText: async (text) => { edits.push(text); },
  });
  const big = 'x'.repeat(200);
  reporter.update(big);
  await sleep(50);
  assert.equal(edits.length, 1, 'first edit should land quickly');

  // Subsequent updates should NOT immediately fire; the debounce timer governs.
  const bigger = 'x'.repeat(400);
  reporter.update(bigger);
  await sleep(100);
  assert.equal(edits.length, 1, 'second edit should be debounced behind the timer');

  await sleep(900);
  assert.equal(edits.length, 2, 'second edit lands after the debounce window');

  await reporter.finalize(bigger);
  assert.equal(edits.length, 3, 'finalize lands a final edit');
});

test('progress: finalize after no updates still emits', async () => {
  const edits = [];
  const reporter = createProgressReporter({
    editText: async (text) => { edits.push(text); },
  });
  await reporter.finalize('only the final text');
  assert.equal(edits.length, 1);
  assert.equal(edits[0], 'only the final text');
});

test('progress: edit errors do not crash the reporter', async () => {
  const reporter = createProgressReporter({
    editText: async () => { throw new Error('discord 429'); },
  });
  const big = 'y'.repeat(200);
  reporter.update(big);
  await sleep(900);
  // Should not throw. Falling to ground here = no exception.
  await reporter.finalize(big);
});
