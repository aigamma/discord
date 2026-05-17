// logger: Error auto-flattening at every level. Captures the structured
// JSON output (the production format) by stubbing process.stdout.write
// for the duration of each test.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
process.env.LOG_FORMAT = 'json'; // force structured output regardless of TTY
process.env.LOG_LEVEL = 'debug'; // emit everything

const { logger } = await import('../src/logger.js');

function captureWrite() {
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return { lines, restore: () => { process.stdout.write = original; } };
}

function parseLast(lines) {
  return JSON.parse(lines[lines.length - 1]);
}

test('logger.error: Error instance flattens to {name, message, stack}', () => {
  const cap = captureWrite();
  try {
    const err = new TypeError('expected number, got string');
    logger.error('demo failed', { err });
  } finally {
    cap.restore();
  }
  const obj = parseLast(cap.lines);
  assert.equal(obj.level, 'error');
  assert.equal(obj.err.name, 'TypeError');
  assert.equal(obj.err.message, 'expected number, got string');
  assert.ok(obj.err.stack);
  assert.ok(obj.err.stack.includes('TypeError'));
});

test('logger.warn: Error instance also flattens (regression: previously was {})', () => {
  const cap = captureWrite();
  try {
    const err = new Error('flaky upstream');
    logger.warn('transient blip', { err });
  } finally {
    cap.restore();
  }
  const obj = parseLast(cap.lines);
  assert.equal(obj.err.message, 'flaky upstream');
  assert.equal(obj.err.name, 'Error');
});

test('logger.info: Error flattens', () => {
  const cap = captureWrite();
  try {
    logger.info('did the thing', { err: new RangeError('out of range') });
  } finally {
    cap.restore();
  }
  const obj = parseLast(cap.lines);
  assert.equal(obj.err.name, 'RangeError');
  assert.equal(obj.err.message, 'out of range');
});

test('logger.debug: Error flattens', () => {
  const cap = captureWrite();
  try {
    logger.debug('checking', { err: new Error('debug detail') });
  } finally {
    cap.restore();
  }
  const obj = parseLast(cap.lines);
  assert.equal(obj.err.message, 'debug detail');
});

test('logger: non-Error err passes through unchanged', () => {
  const cap = captureWrite();
  try {
    logger.warn('precomputed', { err: 'already a string' });
    logger.warn('with code', { err: { code: 'ECONNRESET', message: 'reset' } });
  } finally {
    cap.restore();
  }
  const a = JSON.parse(cap.lines[0]);
  const b = JSON.parse(cap.lines[1]);
  assert.equal(a.err, 'already a string');
  assert.equal(b.err.code, 'ECONNRESET');
  assert.equal(b.err.message, 'reset');
});

test('logger.child: Error flattens through child loggers too', () => {
  const cap = captureWrite();
  try {
    const child = logger.child({ component: 'embedder' });
    child.warn('tick failed', { err: new Error('voyage 429') });
  } finally {
    cap.restore();
  }
  const obj = parseLast(cap.lines);
  assert.equal(obj.component, 'embedder');
  assert.equal(obj.err.message, 'voyage 429');
});

test('logger: no fields renders cleanly', () => {
  const cap = captureWrite();
  try {
    logger.info('startup complete');
  } finally {
    cap.restore();
  }
  const obj = parseLast(cap.lines);
  assert.equal(obj.msg, 'startup complete');
  assert.ok(!('err' in obj));
});
