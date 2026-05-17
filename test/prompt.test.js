import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// The prompt module reads config at import time; ensure required env values
// are present so the import doesn't fail before assertions run.
process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const { buildSystemPrompt } = await import('../src/prompt.js');

test('prompt: contains the core persona block', () => {
  const p = buildSystemPrompt();
  assert.ok(p.includes('[CORE PERSONA AND IDENTITY]'));
  assert.ok(p.includes('Options Alchemy') || p.includes('private Discord channel'));
});

test('prompt: contains explicit behavioral bans', () => {
  const p = buildSystemPrompt();
  for (const banned of [
    'Never open',
    'Never compliment',
    'Never use em-dashes',
    'Never use bullets',
    'Never end with a question',
  ]) {
    assert.ok(p.includes(banned), `expected to find "${banned}" in the prompt`);
  }
});

test('prompt: contains the 25-delta risk reversal definition', () => {
  const p = buildSystemPrompt();
  assert.ok(p.includes('25-delta risk reversal'));
  assert.ok(p.includes('put-wing-minus-call-wing') || p.includes('25-delta put') && p.includes('25-delta call'));
});

test('prompt: defines GEX sign convention so model interprets net_gex consistently', () => {
  const p = buildSystemPrompt();
  // The convention pin: positive net_gex = dealers long gamma = pinning.
  // Without this in the prompt, model outputs flip-flop on which sign
  // means which regime turn-to-turn.
  assert.ok(p.includes('net_gex') || p.includes('GEX'));
  assert.ok(p.includes('long gamma'));
  assert.ok(p.includes('short gamma'));
  assert.ok(p.includes('volatility flip') || p.includes('vol_flip'));
});

test('prompt: temporal context block carries a current ET timestamp', () => {
  const p = buildSystemPrompt();
  assert.ok(p.includes('[TIME AND MARKET SESSION]'));
  assert.ok(p.includes('Current date and time in New York'));
  const yearRegex = /20\d{2}/;
  assert.ok(yearRegex.test(p));
});

test('prompt: MODEL_PLACEHOLDER is replaced', () => {
  const p = buildSystemPrompt();
  assert.ok(!p.includes('MODEL_PLACEHOLDER'), 'placeholder must be substituted');
  assert.ok(/claude-(opus|sonnet|haiku)/.test(p), 'a real model id should appear');
});

test('prompt: contains operator identity block with the configured values', async () => {
  const { config } = await import('../src/config.js');
  const p = buildSystemPrompt();
  assert.ok(p.includes('[OPERATOR IDENTITY]'));
  assert.ok(p.includes(config.operator.handle), `expected handle "${config.operator.handle}" in prompt`);
  assert.ok(p.includes(config.operator.name), `expected name "${config.operator.name}" in prompt`);
  assert.ok(p.includes(config.operator.communityName), `expected community "${config.operator.communityName}" in prompt`);
});

// agent.js splits the prompt at exactly `\n\n[TIME AND MARKET SESSION]`
// so the static prefix carries cache_control: ephemeral and the per-turn
// temporal tail varies freely. If prompt composition drifts (someone
// inserts a block between SITE_DEFINITIONS and the temporal context, or
// re-titles the section, or removes the blank line) the splitter
// silently falls through to the "one block, cache the whole thing"
// path — and Anthropic's prompt cache misses on every single turn at
// $3/MTok for Sonnet input. This test pins the contract.
test('prompt: cache-break marker is exactly the form agent.js expects', () => {
  const p = buildSystemPrompt();
  const splitMarker = '\n\n[TIME AND MARKET SESSION]';
  const occurrences = p.split(splitMarker).length - 1;
  assert.equal(occurrences, 1, `expected exactly one cache-break marker; got ${occurrences}`);
  const tail = p.slice(p.indexOf(splitMarker) + 2);
  assert.ok(tail.startsWith('[TIME AND MARKET SESSION]'));
  assert.ok(tail.includes('Current date and time in New York'));
});
