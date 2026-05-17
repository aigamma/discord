import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

// Pin the SQLite store to a per-process tmp dir so we don't pollute the
// live conversation.db.
const tmp = mkdtempSync(join(tmpdir(), 'bot-budget-test-'));
process.env.CONVERSATION_DB_PATH = join(tmp, 'test.db');

test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows file locks */ }
});

// Budget config is read at config-import time; set it before any imports
// from the bot.
process.env.DAILY_USER_COST_CAP_USD = '0.50';

const { checkBudget, isBudgetEnabled } = await import('../src/budget.js');
const { persistMessage, persistTurn } = await import('../src/memory.js');

test('budget: enabled when cap set', () => {
  assert.equal(isBudgetEnabled(), true);
});

test('budget: zero spend → allowed with full headroom', () => {
  const r = checkBudget('user-never-charged');
  assert.equal(r.allowed, true);
  assert.equal(r.spent, 0);
  assert.equal(r.cap, 0.5);
  assert.equal(r.remaining, 0.5);
  assert.ok(r.reset_in_seconds > 0 && r.reset_in_seconds <= 86400);
});

test('budget: spent below cap → allowed with reduced headroom', () => {
  const userId = 'user-partial-' + Date.now();
  const uMid = persistMessage({ channelId: 'c', userId, role: 'user', content: 'q' });
  const aMid = persistMessage({ channelId: 'c', userId: 'bot', role: 'assistant', content: 'a' });
  persistTurn({
    channelId: 'c', userId,
    userMessageId: uMid, assistantMessageId: aMid,
    model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 0,
    inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, costUsd: 0.20, latencyMs: 500, error: null,
  });

  const r = checkBudget(userId);
  assert.equal(r.allowed, true);
  assert.equal(r.spent, 0.20);
  assert.equal(r.remaining, 0.3);
});

test('budget: spent at-or-above cap → refused', () => {
  const userId = 'user-blocked-' + Date.now();
  const uMid = persistMessage({ channelId: 'c', userId, role: 'user', content: 'q' });
  const aMid = persistMessage({ channelId: 'c', userId: 'bot', role: 'assistant', content: 'a' });
  persistTurn({
    channelId: 'c', userId,
    userMessageId: uMid, assistantMessageId: aMid,
    model: 'claude-opus-4-7', stopReason: 'end_turn', toolRounds: 0,
    inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, costUsd: 0.50, latencyMs: 1500, error: null,
  });

  const r = checkBudget(userId);
  assert.equal(r.allowed, false);
  assert.equal(r.spent, 0.50);
  assert.equal(r.remaining, 0);
});

test('budget: users isolated', () => {
  const userA = 'iso-a-' + Date.now();
  const userB = 'iso-b-' + Date.now();
  const uMid = persistMessage({ channelId: 'c', userId: userA, role: 'user', content: 'q' });
  const aMid = persistMessage({ channelId: 'c', userId: 'bot', role: 'assistant', content: 'a' });
  persistTurn({
    channelId: 'c', userId: userA,
    userMessageId: uMid, assistantMessageId: aMid,
    model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 0,
    inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, costUsd: 0.49, latencyMs: 1, error: null,
  });
  assert.equal(checkBudget(userA).allowed, true);
  assert.equal(checkBudget(userB).allowed, true);
  assert.equal(checkBudget(userB).spent, 0);
});
