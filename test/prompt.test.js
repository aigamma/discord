import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// The prompt module reads config at import time; ensure required env values
// are present so the import doesn't fail before assertions run.
process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const { buildSystemPrompt, _buildTemporalContextForTest } = await import('../src/prompt.js');

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

// Holiday calendar pins — these dates must produce a 'market closed
// for <holiday>' session label even though the day is a weekday. The
// audience is quantitative traders; mislabeling Dec 25 as 'regular
// session' is a credibility-puncturing error the bot can't afford.
test('prompt: Christmas Day labels session as market-closed-for-holiday', () => {
  // 2026-12-25 was a Friday. Build at noon ET so the weekday check
  // would otherwise call this "regular session". The Market session:
  // line is what counts — the static description text below it
  // contains "regular session" descriptively and isn't load-bearing.
  const noonET = new Date('2026-12-25T17:00:00.000Z'); // 12:00 ET in winter
  const block = _buildTemporalContextForTest(noonET);
  assert.ok(/closed for Christmas Day/.test(block), `expected closed-for-Christmas label; got: ${block}`);
  assert.ok(/Market session: US equity market closed for Christmas Day/.test(block));
});

test('prompt: MLK Day labels session as market-closed-for-holiday', () => {
  // 2026-01-19 was a Monday at 13:00 ET — would normally be regular
  // session. The holiday lookup must override.
  const noonET = new Date('2026-01-19T18:00:00.000Z'); // 13:00 ET in winter
  const block = _buildTemporalContextForTest(noonET);
  assert.ok(/closed for Martin Luther King Jr\. Day/.test(block));
});

test('prompt: early-close day before 13:00 ET shows shortened session', () => {
  // 2026-11-27 is the day after Thanksgiving — NYSE early close at 13:00 ET.
  // At 11:30 ET the market is open but the prompt must flag the early close.
  const morningET = new Date('2026-11-27T16:30:00.000Z'); // 11:30 ET in winter
  const block = _buildTemporalContextForTest(morningET);
  assert.ok(/shortened/.test(block));
  assert.ok(/13:00 ET/.test(block));
});

test('prompt: early-close day AFTER 13:00 ET shows market-closed', () => {
  // 2026-11-27 day after Thanksgiving at 14:00 ET — market is closed.
  const afternoonET = new Date('2026-11-27T19:00:00.000Z'); // 14:00 ET in winter
  const block = _buildTemporalContextForTest(afternoonET);
  assert.ok(/early-close completed/.test(block));
});

test('prompt: regular weekday outside calendar still labels normal session', () => {
  // 2026-05-18 is a Monday at 10:30 ET — no holiday or early close.
  // Build a moment we control to avoid system-clock drift in test runs.
  const tuesday = new Date('2026-05-19T14:30:00.000Z'); // 10:30 ET in summer (EDT)
  const block = _buildTemporalContextForTest(tuesday);
  assert.ok(/regular session/.test(block));
});

test('prompt: weekend correctly labeled outside calendar logic', () => {
  // 2026-05-16 was a Saturday.
  const saturday = new Date('2026-05-16T14:30:00.000Z');
  const block = _buildTemporalContextForTest(saturday);
  assert.ok(/weekend/.test(block));
});

test('prompt: year past the calendar still produces a valid session label', () => {
  // 2030-12-25 is a Wednesday — outside the NYSE_HOLIDAYS map (which
  // covers through 2027). Code must fall back to weekday/time logic
  // instead of throwing or labeling weirdly. A separate warn fires
  // through logger.warn — not asserted here, just exercised.
  const futureDate = new Date('2030-12-25T17:00:00.000Z'); // 12:00 ET in winter
  const block = _buildTemporalContextForTest(futureDate);
  // Wednesday at noon ET would normally be regular session. Without the
  // 2030 holiday data, we hit that branch rather than a holiday branch.
  assert.ok(/regular session|early-close/.test(block),
    `expected weekday fallback label; got: ${block}`);
  // The Market session field must still be present and non-empty.
  assert.ok(/Market session: \S+/.test(block));
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
