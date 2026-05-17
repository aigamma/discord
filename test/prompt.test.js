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

test('prompt: contains operator identity block (Blue / Eric Allione)', () => {
  const p = buildSystemPrompt();
  assert.ok(p.includes('Blue'));
  assert.ok(p.includes('Eric Allione') || p.includes('Options Alchemy'));
});
