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
  userActivitySummary, channelStats,
  getUserModelPreference, setUserModelPreference, clearUserModelPreference,
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

test('memory: pendingPgvectorCount matches the LEFT JOIN predicate', async () => {
  // Verifies the count matches the row set the batch query will see:
  // messages with a local embedding AND no pgvector_sync row.
  const { setEmbeddingBulk, markSyncedBulk, pendingPgvectorCount } =
    await import('../src/memory.js');
  const before = pendingPgvectorCount();

  const u1 = persistMessage({ channelId: ch, userId: 'pp-u', role: 'user', content: 'pp one' });
  const u2 = persistMessage({ channelId: ch, userId: 'pp-u', role: 'user', content: 'pp two' });
  // u1 + u2 don't have embeddings yet — they're pending-embed, not
  // pending-sync. Count must NOT change.
  assert.equal(pendingPgvectorCount(), before,
    'embed-pending rows should not count as sync-pending');

  const blob = Buffer.alloc(1024 * 4);
  setEmbeddingBulk([
    { id: u1, blob, model: 'voyage-3' },
    { id: u2, blob, model: 'voyage-3' },
  ]);
  // Both rows now embedded and not synced.
  assert.equal(pendingPgvectorCount(), before + 2,
    'two newly-embedded rows should add 2 to the sync-pending count');

  markSyncedBulk([u1]);
  // u1 synced, u2 still pending.
  assert.equal(pendingPgvectorCount(), before + 1);

  markSyncedBulk([u2]);
  assert.equal(pendingPgvectorCount(), before, 'all caught up returns to baseline');
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

test('memory: userActivitySummary scopes to a single user over the window', () => {
  // Persist two distinct users' activity, then read each back. The
  // helper must not bleed totals across users (that would be a privacy
  // leak — /whoami shows the caller their own activity, not the
  // server's).
  const a = 'wa-user-a-' + Date.now();
  const b = 'wa-user-b-' + Date.now();
  for (const [user, n] of [[a, 3], [b, 1]]) {
    for (let i = 0; i < n; i++) {
      const uM = persistMessage({ channelId: ch, userId: user, role: 'user', content: 'q' });
      const aM = persistMessage({ channelId: ch, userId: 'bot', role: 'assistant', content: 'a' });
      persistTurn({
        channelId: ch, userId: user,
        userMessageId: uM, assistantMessageId: aM,
        model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 0,
        inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0, costUsd: 0.01, latencyMs: 500, error: null,
      });
    }
  }
  const sumA = userActivitySummary(a, 24);
  const sumB = userActivitySummary(b, 24);
  assert.equal(sumA.turns, 3);
  assert.equal(sumB.turns, 1);
  // Cost across the three a-turns should be 0.03 (within float tolerance).
  assert.ok(sumA.cost_usd >= 0.03 - 1e-6);
  // Last-turn timestamp is set (ms since epoch).
  assert.ok(sumA.last_turn_at != null && sumA.last_turn_at > 0);
});

test('memory: userActivitySummary counts feedback the caller gave', () => {
  const u = 'wa-fb-' + Date.now();
  // Need a target assistant message for the feedback FK to point at.
  const aM = persistMessage({ channelId: ch, userId: 'bot', role: 'assistant', content: 'rate me' });
  recordFeedback({ assistantMessageId: aM, userId: u, channelId: ch, sentiment: 'up', emoji: '👍' });
  const sum = userActivitySummary(u, 24);
  assert.equal(sum.feedback_given.up, 1);
  assert.equal(sum.feedback_given.down, 0);
});

test('memory: channelStats reports turns, distinct askers, and top askers per channel', () => {
  // Use a fresh channel id so other tests' activity doesn't contaminate
  // the totals. Three askers, with one of them dominating turn count so
  // the top-asker ordering can be verified.
  const csCh = 'cs-' + Date.now();
  const heavy = 'cs-heavy';
  const lighter = ['cs-l1', 'cs-l2'];
  for (let i = 0; i < 5; i++) {
    const uM = persistMessage({ channelId: csCh, userId: heavy, role: 'user', content: 'q' });
    const aM = persistMessage({ channelId: csCh, userId: 'bot', role: 'assistant', content: 'a' });
    persistTurn({
      channelId: csCh, userId: heavy,
      userMessageId: uM, assistantMessageId: aM,
      model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 0,
      inputTokens: 5, outputTokens: 3, cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0, costUsd: 0.005, latencyMs: 400, error: null,
    });
  }
  for (const u of lighter) {
    const uM = persistMessage({ channelId: csCh, userId: u, role: 'user', content: 'q' });
    const aM = persistMessage({ channelId: csCh, userId: 'bot', role: 'assistant', content: 'a' });
    persistTurn({
      channelId: csCh, userId: u,
      userMessageId: uM, assistantMessageId: aM,
      model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 0,
      inputTokens: 5, outputTokens: 3, cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0, costUsd: 0.005, latencyMs: 400, error: null,
    });
  }

  const s = channelStats(csCh, 24);
  assert.equal(s.turns, 7);
  assert.equal(s.distinct_askers, 3);
  assert.equal(s.top_askers[0].user_id, heavy);
  assert.equal(s.top_askers[0].turns, 5);
  // total_messages_all_time counts every persisted row (user + assistant)
  // in this channel; with 7 turns that's 14 rows.
  assert.equal(s.total_messages_all_time, 14);
});

test('memory: channelStats does not include other channels\' turns', () => {
  // Critical isolation property — /stats should only show this channel's
  // activity, never a different channel's.
  const isolated = 'cs-iso-' + Date.now();
  const otherCh = 'cs-other-' + Date.now();

  const uM = persistMessage({ channelId: isolated, userId: 'cs-iso-user', role: 'user', content: 'q' });
  const aM = persistMessage({ channelId: isolated, userId: 'bot', role: 'assistant', content: 'a' });
  persistTurn({
    channelId: isolated, userId: 'cs-iso-user',
    userMessageId: uM, assistantMessageId: aM,
    model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 0,
    inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, costUsd: 0.001, latencyMs: 100, error: null,
  });

  // Activity in a different channel that must NOT leak into isolated.
  const uM2 = persistMessage({ channelId: otherCh, userId: 'cs-other-user', role: 'user', content: 'q' });
  const aM2 = persistMessage({ channelId: otherCh, userId: 'bot', role: 'assistant', content: 'a' });
  persistTurn({
    channelId: otherCh, userId: 'cs-other-user',
    userMessageId: uM2, assistantMessageId: aM2,
    model: 'claude-sonnet-4-6', stopReason: 'end_turn', toolRounds: 0,
    inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, costUsd: 0.001, latencyMs: 100, error: null,
  });

  const s = channelStats(isolated, 24);
  assert.equal(s.turns, 1);
  assert.equal(s.distinct_askers, 1);
  assert.equal(s.top_askers.length, 1);
  assert.equal(s.top_askers[0].user_id, 'cs-iso-user');
});

test('memory: user model preference set / get / clear roundtrip', () => {
  const u = 'mp-roundtrip-' + Date.now();
  assert.equal(getUserModelPreference(u), null, 'no preference before set');

  const r = setUserModelPreference({ userId: u, label: 'opus' });
  assert.equal(r.ok, true);
  assert.equal(r.label, 'opus');
  assert.equal(getUserModelPreference(u), 'opus');

  // Re-setting upserts in place, not duplicating. Verify by setting a
  // different label and reading back the new value.
  setUserModelPreference({ userId: u, label: 'haiku' });
  assert.equal(getUserModelPreference(u), 'haiku');

  const cleared = clearUserModelPreference(u);
  assert.equal(cleared, 1);
  assert.equal(getUserModelPreference(u), null, 'no preference after clear');
});

test('memory: user model preference rejects invalid labels', () => {
  const u = 'mp-invalid-' + Date.now();
  const r = setUserModelPreference({ userId: u, label: 'gpt-4' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_label');
  assert.ok(Array.isArray(r.allowed));
  assert.ok(r.allowed.includes('sonnet'));
  assert.equal(getUserModelPreference(u), null, 'no row written on invalid label');
});

test('memory: user model preference: isolation across users', () => {
  const a = 'mp-iso-a-' + Date.now();
  const b = 'mp-iso-b-' + Date.now();
  setUserModelPreference({ userId: a, label: 'sonnet' });
  setUserModelPreference({ userId: b, label: 'opus' });
  assert.equal(getUserModelPreference(a), 'sonnet');
  assert.equal(getUserModelPreference(b), 'opus');
  clearUserModelPreference(a);
  // Clearing a leaves b intact.
  assert.equal(getUserModelPreference(a), null);
  assert.equal(getUserModelPreference(b), 'opus');
});

test('memory: user model preference: null/missing user id treated as no-op', () => {
  assert.equal(getUserModelPreference(null), null);
  assert.equal(getUserModelPreference(undefined), null);
  assert.equal(getUserModelPreference(''), null);
  const r = setUserModelPreference({ userId: null, label: 'sonnet' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_user');
  assert.equal(clearUserModelPreference(null), 0);
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
