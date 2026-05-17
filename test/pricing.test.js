import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { priceUsage } from '../src/pricing.js';

test('pricing: sonnet 4.6 basic input + output', () => {
  const cost = priceUsage('claude-sonnet-4-6', {
    input_tokens: 1_000_000,
    output_tokens: 0,
  });
  assert.equal(cost, 3.0, 'input pricing $3 / 1M for sonnet 4.6');
});

test('pricing: sonnet 4.6 input + output combined', () => {
  const cost = priceUsage('claude-sonnet-4-6', {
    input_tokens: 1000,
    output_tokens: 200,
  });
  // 1000 * 3 / 1M + 200 * 15 / 1M = 0.003 + 0.003 = 0.006
  assert.equal(cost, 0.006);
});

test('pricing: cache writes and reads priced separately', () => {
  const cost = priceUsage('claude-sonnet-4-6', {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
  });
  // 1M * 3.75 / 1M + 1M * 0.30 / 1M = 4.05
  assert.equal(cost, 4.05);
});

test('pricing: opus 4.7 is 5x more expensive on input', () => {
  const sonnet = priceUsage('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0 });
  const opus = priceUsage('claude-opus-4-7', { input_tokens: 1_000_000, output_tokens: 0 });
  assert.equal(opus / sonnet, 5);
});

test('pricing: haiku 4.5 cheaper than sonnet', () => {
  const haiku = priceUsage('claude-haiku-4-5-20251001', { input_tokens: 1_000_000, output_tokens: 0 });
  assert.equal(haiku, 1.0);
});

test('pricing: unknown model returns null', () => {
  assert.equal(priceUsage('claude-imaginary-99', { input_tokens: 1000 }), null);
});

test('pricing: null usage returns null', () => {
  assert.equal(priceUsage('claude-sonnet-4-6', null), null);
});

test('pricing: missing token fields treated as zero', () => {
  const cost = priceUsage('claude-sonnet-4-6', { input_tokens: 500 });
  // 500 * 3 / 1M = 0.0015
  assert.equal(cost, 0.0015);
});
