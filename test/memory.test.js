import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const tmp = mkdtempSync(join(tmpdir(), 'bot-memory-test-'));
process.env.CONVERSATION_DB_PATH = join(tmp, 'test.db');
test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows file locks */ }
});

const {
  persistMessage, persistTurn,
  loadShortTermContext, totalMessageCount,
  usageSummary,
  recordFeedback, feedbackCounts,
  attachDiscordMessageId, findAssistantMessage,
  loadChannelHistoryForSummary,
} = await import('../src/memory.js');

const ch = 'mem-test-' + Date.now();

test('memory: persist + read short-term context preserves chronological order', () => {
  persistMessage({ channelId: ch, userId: 'A', username: 'Blue', role: 'user', content: 'first' });
  persistMessage({ channelId: ch, userId: 'bot', role: 'assistant', content: 'reply-to-first' });
  persistMessage({ channelId: ch, userId: 'B', username: 'Alpha', role: 'user', content: 'second' });
  persistMessage({ channelId: ch, userId: 'bot', role: 'assistant', content: 'reply-to-second' });

  const ctx = loadShortTermContext({ channelId: ch, isMultiUser: true });
  assert.equal(ctx.length, 4);
  // oldest first
  assert.match(ctx[0].content, /\[Blue\]: first/);
  assert.equal(ctx[1].content, 'reply-to-first');
  assert.match(ctx[2].content, /\[Alpha\]: second/);
  assert.equal(ctx[3].content, 'reply-to-second');
});

test('memory: dm channel (isMultiUser=false) drops the username prefix', () => {
  const dmCh = 'dm-' + Date.now();
  persistMessage({ channelId: dmCh, userId: 'X', username: 'Blue', role: 'user', content: 'hello' });
  const ctx = loadShortTermContext({ channelId: dmCh, isMultiUser: false });
  assert.equal(ctx[0].content, 'hello'); // no [Blue]: prefix
});

test('memory: feedback persists with idempotent (msg, user) key', () => {
  const aMid = persistMessage({ channelId: ch, userId: 'bot', role: 'assistant', content: 'rate me' });
  recordFeedback({ assistantMessageId: aMid, userId: 'A', channelId: ch, sentiment: 'up', emoji: '👍' });
  recordFeedback({ assistantMessageId: aMid, userId: 'B', channelId: ch, sentiment: 'down', emoji: '👎' });
  // re-recording from the same user should replace, not duplicate
  recordFeedback({ assistantMessageId: aMid, userId: 'A', channelId: ch, sentiment: 'down', emoji: '👎' });

  const fb = feedbackCounts(24);
  // Now: A=down, B=down
  assert.ok(fb.down >= 2);
});

test('memory: usageSummary aggregates over the window', () => {
  const userId = 'usage-' + Date.now();
  for (let i = 0; i < 3; i++) {
    const uM = persistMessage({ channelId: ch, userId, role: 'user', content: 'q' + i });
    const aM = persistMessage({ channelId: ch, userId: 'bot', role: 'assistant', content: 'a' + i });
    persistTurn({
      channelId: ch, userId,
      userMessageId: uM, assistantMessageId: aM,
      model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 0,
      inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0, costUsd: 0.01, latencyMs: 500, error: null,
    });
  }

  const u = usageSummary(24);
  assert.ok(u.total.turns >= 3);
  assert.ok(u.total.cost_usd >= 0.03 - 1e-6);
  assert.ok(u.by_model.some((m) => m.model === 'claude-sonnet-4-6'));
});

test('memory: findAssistantMessage by discord_message_id roundtrip', () => {
  const aMid = persistMessage({ channelId: ch, userId: 'bot', role: 'assistant', content: 'attached' });
  attachDiscordMessageId(aMid, 'discord-msg-999');
  const found = findAssistantMessage('discord-msg-999');
  assert.ok(found);
  assert.equal(found.id, aMid);
});

test('memory: loadChannelHistoryForSummary returns oldest-first within the cap', () => {
  const cap = totalMessageCount();
  assert.ok(cap > 0);
  const hist = loadChannelHistoryForSummary({ channelId: ch, limit: 4 });
  assert.equal(hist.length, 4);
  // First should be older than last
  assert.ok(hist[0].created_at <= hist[hist.length - 1].created_at);
});
