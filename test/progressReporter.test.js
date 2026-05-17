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

test('progress: cancel stops pending edits without landing one', async () => {
  const edits = [];
  const reporter = createProgressReporter({
    editText: async (text) => { edits.push(text); },
  });
  reporter.update('x'.repeat(200)); // queues a pending flush
  reporter.cancel();                  // synchronously clears the timer before it fires
  await sleep(900);
  assert.equal(edits.length, 0, 'cancel should prevent the pending edit from landing');
  // After cancel, finalize is also a no-op
  await reporter.finalize('this should not land');
  assert.equal(edits.length, 0);
});

test('progress: serializes edits when editText is slow (no concurrent calls)', async () => {
  // Reproduces the rate-limit collision: a slow Discord edit (longer
  // than MIN_EDIT_INTERVAL_MS) used to let the next scheduled flush
  // fire before the previous returned, producing concurrent edits on
  // the same message and a 429 on the second. With the inFlight guard
  // there must never be two concurrent editText() calls in flight.
  let concurrent = 0;
  let maxConcurrent = 0;
  const edits = [];
  const reporter = createProgressReporter({
    editText: async (text) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(1200); // longer than MIN_EDIT_INTERVAL_MS (800)
      edits.push(text);
      concurrent--;
    },
  });
  // Update three times with rapidly-growing text. The first triggers
  // the slow edit; subsequent updates should NOT spawn a concurrent
  // edit even though the debounce timer would otherwise allow it.
  reporter.update('x'.repeat(100));
  await sleep(50);
  reporter.update('x'.repeat(300));
  await sleep(900);
  reporter.update('x'.repeat(500));
  await sleep(2000);
  assert.equal(maxConcurrent, 1, `must serialize Discord edits; observed ${maxConcurrent} concurrent`);
  await reporter.finalize('x'.repeat(600));
});

test('progress: finalize is idempotent (double-call lands one edit)', async () => {
  const edits = [];
  const reporter = createProgressReporter({
    editText: async (text) => { edits.push(text); },
  });
  await reporter.finalize('first');
  await reporter.finalize('second');
  await reporter.finalize('third');
  assert.equal(edits.length, 1, 'only the first finalize should land an edit');
  assert.equal(edits[0], 'first');
});
