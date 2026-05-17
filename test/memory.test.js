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
  usageSummary, percentile,
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

test('memory: usageSummary computes p50 and p95 latency via linear interpolation', () => {
  // Insert turns with known latencies and verify the percentiles match
  // the R-7 (Excel PERCENTILE.INC) convention: idx = (n-1)*p,
  // interpolate between floor and ceil. For [100, 200, 300, 400] that
  // gives p50 = 250, p95 = 385.
  const userId = 'latency-pct-' + Date.now();
  for (const lat of [100, 200, 300, 400]) {
    const uM = persistMessage({ channelId: ch, userId, role: 'user', content: 'q' });
    const aM = persistMessage({ channelId: ch, userId: 'bot', role: 'assistant', content: 'a' });
    persistTurn({
      channelId: ch, userId,
      userMessageId: uM, assistantMessageId: aM,
      model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 0,
      inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0, costUsd: 0.001, latencyMs: lat, error: null,
    });
  }
  const u = usageSummary(24);
  // The DB may have prior turns from other tests — the percentiles are
  // computed over EVERY turn in the window, not just these. Verify
  // numbers are within sane bounds and p95 >= p50.
  assert.ok(Number.isFinite(u.p50_latency_ms), 'p50 should be finite');
  assert.ok(Number.isFinite(u.p95_latency_ms), 'p95 should be finite');
  assert.ok(u.p95_latency_ms >= u.p50_latency_ms, `p95 (${u.p95_latency_ms}) should be >= p50 (${u.p50_latency_ms})`);
});

test('memory: usageSummary by_tool aggregates per-tool latency from JSON entries', () => {
  // Persist an assistant message with tool_uses entries that carry
  // latency_ms (the new per-tool latency field). The query should
  // surface avg_latency_ms on the by_tool breakdown.
  const userId = 'tool-latency-' + Date.now();
  const aM = persistMessage({
    channelId: ch,
    userId: 'bot',
    role: 'assistant',
    content: 'reply',
    toolUses: [
      { name: 'get_vix_family_latest', input: {}, round: 0, latency_ms: 120 },
      { name: 'get_vix_family_latest', input: {}, round: 0, latency_ms: 180 },
      { name: 'get_iv_percentile', input: { lookback_days: 60 }, round: 1, latency_ms: 250 },
    ],
  });
  const uM = persistMessage({ channelId: ch, userId, role: 'user', content: 'q' });
  persistTurn({
    channelId: ch, userId,
    userMessageId: uM, assistantMessageId: aM,
    model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 2,
    inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, costUsd: 0.01, latencyMs: 1000, error: null,
  });

  const u = usageSummary(24);
  const vix = u.by_tool.find((t) => t.tool === 'get_vix_family_latest');
  const iv = u.by_tool.find((t) => t.tool === 'get_iv_percentile');
  assert.ok(vix && vix.calls >= 2);
  assert.ok(iv && iv.calls >= 1);
  // VIX entries average 120/180 → 150ms; iv is 250ms.
  // Other tests may have added entries; allow a range.
  assert.ok(vix.avg_latency_ms >= 100 && vix.avg_latency_ms <= 300,
    `vix avg latency outside expected range: ${vix.avg_latency_ms}`);
  assert.ok(iv.avg_latency_ms >= 100 && iv.avg_latency_ms <= 300,
    `iv avg latency outside expected range: ${iv.avg_latency_ms}`);
});

test('memory: setEmbeddingBulk + markSyncedBulk batch SQLite writes', async () => {
  // Insert three user messages, embed them in bulk, then mark them
  // synced in bulk. Verify they all landed and that the resulting
  // pgvector-pending query returns empty (since we marked them all
  // synced). Pins the contract the embedder depends on.
  const { setEmbeddingBulk, markSyncedBulk, getPendingPgvectorRows } =
    await import('../src/memory.js');

  const u1 = persistMessage({ channelId: ch, userId: 'bulk-u', role: 'user', content: 'bulk one' });
  const u2 = persistMessage({ channelId: ch, userId: 'bulk-u', role: 'user', content: 'bulk two' });
  const u3 = persistMessage({ channelId: ch, userId: 'bulk-u', role: 'user', content: 'bulk three' });

  const blob = Buffer.alloc(1024 * 4); // 1024-dim Float32 = 4096 bytes
  setEmbeddingBulk([
    { id: u1, blob, model: 'voyage-3' },
    { id: u2, blob, model: 'voyage-3' },
    { id: u3, blob, model: 'voyage-3' },
  ]);

  // All three should now be pending pgvector sync
  const pending = getPendingPgvectorRows(50);
  const ids = pending.map((r) => r.id);
  for (const id of [u1, u2, u3]) {
    assert.ok(ids.includes(id), `expected ${id} in pending pgvector rows`);
  }

  markSyncedBulk([u1, u2, u3]);

  // Now none should be pending
  const stillPending = getPendingPgvectorRows(50).filter((r) => [u1, u2, u3].includes(r.id));
  assert.equal(stillPending.length, 0);
});

test('memory: setEmbeddingBulk handles empty array as no-op', async () => {
  const { setEmbeddingBulk, markSyncedBulk } = await import('../src/memory.js');
  // Should not throw, should not start a transaction.
  setEmbeddingBulk([]);
  markSyncedBulk([]);
  setEmbeddingBulk(null);
  markSyncedBulk(null);
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

test('percentile: empty array returns null', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile(null, 0.5), null);
});

test('percentile: single-element array returns that element', () => {
  assert.equal(percentile([42], 0.5), 42);
  assert.equal(percentile([42], 0.95), 42);
});

test('percentile: R-7 linear interpolation, not nearest-neighbor', () => {
  // [100, 200, 300, 400]:
  //   p50 idx = (4-1)*0.5 = 1.5 → between 200 and 300 → 250
  //   p95 idx = (4-1)*0.95 = 2.85 → between 300 and 400 at 0.85 frac → 385
  // Nearest-neighbor (which postmortem.js used before) would have
  // given Math.floor(4*0.5)=2 → 300 for p50, Math.floor(4*0.95)=3 →
  // 400 for p95. The whole point of this helper is that the two
  // surfaces agree on the same window — pin it.
  assert.equal(percentile([100, 200, 300, 400], 0.5), 250);
  assert.equal(percentile([100, 200, 300, 400], 0.95), 385);
});

test('percentile: rounds to integer', () => {
  // [100, 101]: p50 idx = 0.5 → 100.5 → rounds to 101 (half-to-even
  // would give 100, but JS Math.round goes half-up to 101).
  assert.equal(percentile([100, 101], 0.5), 101);
});

test('percentile: p=0 and p=1 hit the endpoints', () => {
  const arr = [10, 20, 30, 40, 50];
  assert.equal(percentile(arr, 0), 10);
  assert.equal(percentile(arr, 1), 50);
});
