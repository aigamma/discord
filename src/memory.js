// Conversation memory. Two layers:
//
//   - Short-term: the last N messages in the same channel within a sliding
//     time window. Loaded from SQLite on every turn so the bot can recall
//     what was said seconds or minutes ago. Multi-user channels prefix
//     each user message with the speaker's Discord display name so the
//     model can attribute statements correctly.
//
//   - Long-term: every Q&A persisted forever. Searchable by similarity
//     once the Voyage embeddings layer is wired up (next batch).
//
// All reads/writes go through prepared statements held in this module.

import { db } from './db.js';
import { config } from './config.js';

const insertMessage = db.prepare(`
  INSERT INTO messages (
    channel_id, guild_id, user_id, username, discord_message_id,
    role, content, model, tool_uses,
    input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens,
    cost_usd, latency_ms, created_at
  ) VALUES (
    @channel_id, @guild_id, @user_id, @username, @discord_message_id,
    @role, @content, @model, @tool_uses,
    @input_tokens, @output_tokens,
    @cache_creation_input_tokens, @cache_read_input_tokens,
    @cost_usd, @latency_ms, @created_at
  )
`);

const insertTurn = db.prepare(`
  INSERT INTO turns (
    channel_id, user_id, user_message_id, assistant_message_id,
    model, stop_reason, tool_rounds,
    input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens,
    cost_usd, latency_ms, error, created_at
  ) VALUES (
    @channel_id, @user_id, @user_message_id, @assistant_message_id,
    @model, @stop_reason, @tool_rounds,
    @input_tokens, @output_tokens,
    @cache_creation_input_tokens, @cache_read_input_tokens,
    @cost_usd, @latency_ms, @error, @created_at
  )
`);

const selectRecent = db.prepare(`
  SELECT id, user_id, username, role, content, created_at
  FROM messages
  WHERE channel_id = ? AND created_at >= ?
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);

const setChannelCutoff = db.prepare(`
  INSERT OR REPLACE INTO channel_cutoffs (channel_id, context_cutoff_ms) VALUES (?, ?)
`);
const getChannelCutoff = db.prepare(`
  SELECT context_cutoff_ms FROM channel_cutoffs WHERE channel_id = ?
`);

const countMessages = db.prepare('SELECT COUNT(*) AS n FROM messages');

const selectPendingEmbeddings = db.prepare(`
  SELECT id, content
  FROM messages
  WHERE embedding IS NULL
    AND role = 'user'
    AND length(content) >= 4
  ORDER BY id ASC
  LIMIT ?
`);

const updateEmbedding = db.prepare(`
  UPDATE messages
  SET embedding = ?, embedding_model = ?
  WHERE id = ?
`);

const countPendingEmbeddings = db.prepare(`
  SELECT COUNT(*) AS n FROM messages WHERE embedding IS NULL AND role = 'user' AND length(content) >= 4
`);

const selectEmbeddedUserMessages = db.prepare(`
  SELECT m.id, m.channel_id, m.guild_id, m.user_id, m.username, m.content, m.created_at, m.embedding
  FROM messages m
  WHERE m.embedding IS NOT NULL AND m.role = 'user'
`);

// Channel- and guild-filtered variants used by the search tool's
// SQLite fallback. Pushing the filter into SQL avoids loading the
// entire embedded corpus into JS just to drop most of it.
const selectEmbeddedUserMessagesByChannel = db.prepare(`
  SELECT m.id, m.channel_id, m.guild_id, m.user_id, m.username, m.content, m.created_at, m.embedding
  FROM messages m
  WHERE m.embedding IS NOT NULL AND m.role = 'user' AND m.channel_id = ?
`);
const selectEmbeddedUserMessagesByGuild = db.prepare(`
  SELECT m.id, m.channel_id, m.guild_id, m.user_id, m.username, m.content, m.created_at, m.embedding
  FROM messages m
  WHERE m.embedding IS NOT NULL AND m.role = 'user' AND m.guild_id = ?
`);

const selectGuildIdFor = db.prepare(`SELECT guild_id FROM messages WHERE id = ? LIMIT 1`);
export function getGuildIdFor(localId) {
  const row = selectGuildIdFor.get(localId);
  return row?.guild_id ?? null;
}

const selectAssistantForUser = db.prepare(`
  SELECT m.content, m.created_at
  FROM turns t
  JOIN messages m ON m.id = t.assistant_message_id
  WHERE t.user_message_id = ?
  LIMIT 1
`);

const selectAssistantRowForUser = db.prepare(`
  SELECT m.id AS local_id, m.content
  FROM turns t
  JOIN messages m ON m.id = t.assistant_message_id
  WHERE t.user_message_id = ?
  LIMIT 1
`);

const updateDiscordMessageId = db.prepare(`
  UPDATE messages SET discord_message_id = ? WHERE id = ?
`);

export function attachDiscordMessageId(localId, discordMessageId) {
  if (discordMessageId) updateDiscordMessageId.run(discordMessageId, localId);
}

// Pull each pending row + its paired assistant reply in one query so the
// embedder doesn't do an N+1 `getAssistantRowFor` per batch row. Joins:
//   m   = the embedded message (always role='user' since we only embed
//         user messages)
//   t   = its audit-log turn (links user_message_id to assistant_message_id)
//   am  = the assistant message row referenced by the turn (the reply)
//   s   = pgvector_sync; LEFT JOIN + WHERE NULL gives "not yet synced"
const selectPendingPgvectorSync = db.prepare(`
  SELECT m.id, m.channel_id, m.guild_id, m.user_id, m.username, m.role,
         m.content, m.embedding, m.embedding_model,
         am.id AS reply_local_id, am.content AS reply_content
  FROM messages m
  LEFT JOIN turns t ON t.user_message_id = m.id
  LEFT JOIN messages am ON am.id = t.assistant_message_id
  LEFT JOIN pgvector_sync s ON s.local_id = m.id
  WHERE m.embedding IS NOT NULL
    AND s.local_id IS NULL
  ORDER BY m.id ASC
  LIMIT ?
`);

const markPgvectorSynced = db.prepare(`
  INSERT OR REPLACE INTO pgvector_sync (local_id, synced_at) VALUES (?, ?)
`);

const findAssistantByDiscordId = db.prepare(`
  SELECT id FROM messages
  WHERE role = 'assistant'
    AND discord_message_id = ?
  LIMIT 1
`);

const insertFeedback = db.prepare(`
  INSERT OR REPLACE INTO feedback
    (assistant_message_id, user_id, channel_id, sentiment, emoji, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const deleteFeedback = db.prepare(`
  DELETE FROM feedback WHERE assistant_message_id = ? AND user_id = ?
`);

const feedbackSummary = db.prepare(`
  SELECT sentiment, COUNT(*) AS n
  FROM feedback
  WHERE created_at >= ?
  GROUP BY sentiment
`);

const selectChannelHistoryForSummary = db.prepare(`
  SELECT role, username, content, created_at
  FROM messages
  WHERE channel_id = ?
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);

/**
 * Persist a single message (user or assistant) to the SQLite store.
 * Returns the local row id, which can be cross-referenced from the
 * `turns` audit log and is the join key for the pgvector mirror.
 *
 * @param {object} args
 * @param {string} args.channelId
 * @param {string|null} [args.guildId]
 * @param {string} args.userId
 * @param {string|null} [args.username]
 * @param {string|null} [args.discordMessageId]
 * @param {'user'|'assistant'|'system'} args.role
 * @param {string} args.content
 * @param {string|null} [args.model]
 * @param {Array|null} [args.toolUses]
 * @param {number|null} [args.inputTokens]
 * @param {number|null} [args.outputTokens]
 * @param {number|null} [args.cacheCreationInputTokens]
 * @param {number|null} [args.cacheReadInputTokens]
 * @param {number|null} [args.costUsd]
 * @param {number|null} [args.latencyMs]
 * @returns {number} Local row id.
 */
export function persistMessage({
  channelId,
  guildId = null,
  userId,
  username = null,
  discordMessageId = null,
  role,
  content,
  model = null,
  toolUses = null,
  inputTokens = null,
  outputTokens = null,
  cacheCreationInputTokens = null,
  cacheReadInputTokens = null,
  costUsd = null,
  latencyMs = null,
}) {
  const result = insertMessage.run({
    channel_id: channelId,
    guild_id: guildId,
    user_id: userId,
    username,
    discord_message_id: discordMessageId,
    role,
    content,
    model,
    tool_uses: toolUses ? JSON.stringify(toolUses) : null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cost_usd: costUsd,
    latency_ms: latencyMs,
    created_at: Date.now(),
  });
  return Number(result.lastInsertRowid);
}

export function persistTurn({
  channelId,
  userId,
  userMessageId,
  assistantMessageId,
  model,
  stopReason,
  toolRounds,
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  costUsd,
  latencyMs,
  error,
}) {
  insertTurn.run({
    channel_id: channelId,
    user_id: userId,
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
    model,
    stop_reason: stopReason,
    tool_rounds: toolRounds,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cost_usd: costUsd,
    latency_ms: latencyMs,
    error,
    created_at: Date.now(),
  });
}

// Load short-term context for a channel. Returns oldest-first message array
// shaped for the Anthropic messages API. Multi-user channels: each user
// message gets a "[displayName]: " prefix so the model can attribute lines.
// DM channels (one human author) and slash-command channels skip the
// prefix to keep prompts clean.
//
// Honors per-channel /forget cutoffs: any cutoff later than the rolling
// time-window cutoff overrides it, so a user who ran /forget recently
// gets a clean conversation start.
export function loadShortTermContext({ channelId, isMultiUser = false }) {
  const turns = config.memory.shortTermTurns;
  const windowMs = config.memory.shortTermMinutes * 60 * 1000;
  const rollingSince = Date.now() - windowMs;
  const cutoffRow = getChannelCutoff.get(channelId);
  const since = cutoffRow ? Math.max(rollingSince, cutoffRow.context_cutoff_ms) : rollingSince;

  const rowsDesc = selectRecent.all(channelId, since, turns);
  const rows = rowsDesc.slice().reverse();

  const messages = [];
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const prefix = isMultiUser && r.role === 'user' && r.username
      ? `[${r.username}]: `
      : '';
    messages.push({ role: r.role, content: prefix + r.content });
  }
  return messages;
}

// Advance the per-channel forget cutoff to the current time. The next
// short-term context load filters out everything before this cutoff.
// Non-destructive: messages stay in the table and are still searchable
// via search_chat_history. Returns the cutoff timestamp that was set.
export function clearShortTermContext({ channelId }) {
  const cutoff = Date.now();
  setChannelCutoff.run(channelId, cutoff);
  return cutoff;
}

export function totalMessageCount() {
  return countMessages.get().n;
}

export function pendingEmbeddingsCount() {
  return countPendingEmbeddings.get().n;
}

export function getPendingEmbeddings(limit = 32) {
  return selectPendingEmbeddings.all(limit);
}

// Bulk-only by design — the embedder always writes in batches and a
// per-row helper would be dead code with no fsync amortization. If a
// future caller needs single-row writes, it should still go through
// setEmbeddingBulk with a one-element array for consistent transaction
// semantics.
const setEmbeddingBulkBegin = db.prepare('BEGIN');
const setEmbeddingBulkCommit = db.prepare('COMMIT');
const setEmbeddingBulkRollback = db.prepare('ROLLBACK');
export function setEmbeddingBulk(entries) {
  if (!entries || entries.length === 0) return;
  setEmbeddingBulkBegin.run();
  try {
    for (const e of entries) updateEmbedding.run(e.blob, e.model, e.id);
    setEmbeddingBulkCommit.run();
  } catch (err) {
    try { setEmbeddingBulkRollback.run(); } catch { /* nested fail */ }
    throw err;
  }
}

// Returns embedded user messages paired with their embeddings. Pushes
// channel_id / guild_id filters into SQL so a search restricted to a
// single channel doesn't scan the whole corpus to drop most rows.
// Iterates lazily — never loads the whole result set into memory.
export function* iterEmbeddedUserMessages({ channelId = null, guildId = null } = {}) {
  // channelId takes precedence (most selective; uses idx_messages_channel_time).
  const iter = channelId
    ? selectEmbeddedUserMessagesByChannel.iterate(channelId)
    : guildId
      ? selectEmbeddedUserMessagesByGuild.iterate(guildId)
      : selectEmbeddedUserMessages.iterate();
  for (const row of iter) {
    yield row;
  }
}

export function getAssistantResponseFor(userMessageId) {
  return selectAssistantForUser.get(userMessageId);
}

export function getAssistantRowFor(userMessageId) {
  return selectAssistantRowForUser.get(userMessageId);
}

export function getPendingPgvectorRows(limit = 32) {
  return selectPendingPgvectorSync.all(limit);
}

// Count rows that have a local embedding but no pgvector_sync row.
// Operators need this on /health: a stuck sync queue (Supabase down,
// auth expired, schema drift) wouldn't otherwise surface until search
// got noticeably stale. Counts the same predicate the batch query uses.
const countPendingPgvectorSync = db.prepare(`
  SELECT COUNT(*) AS n
  FROM messages m
  LEFT JOIN pgvector_sync s ON s.local_id = m.id
  WHERE m.embedding IS NOT NULL AND s.local_id IS NULL
`);
export function pendingPgvectorCount() {
  return countPendingPgvectorSync.get().n;
}

// Bulk-only by design. The embedder always marks the rows it just
// successfully upserted to pgvector in a single batch; a per-row helper
// would be dead code.
const markPgvectorSyncedBulkBegin = db.prepare('BEGIN');
const markPgvectorSyncedBulkCommit = db.prepare('COMMIT');
const markPgvectorSyncedBulkRollback = db.prepare('ROLLBACK');
export function markSyncedBulk(localIds) {
  if (!localIds || localIds.length === 0) return;
  const now = Date.now();
  markPgvectorSyncedBulkBegin.run();
  try {
    for (const id of localIds) markPgvectorSynced.run(id, now);
    markPgvectorSyncedBulkCommit.run();
  } catch (err) {
    try { markPgvectorSyncedBulkRollback.run(); } catch { /* nested fail */ }
    throw err;
  }
}

export function findAssistantMessage(discordMessageId) {
  return findAssistantByDiscordId.get(discordMessageId);
}

export function recordFeedback({ assistantMessageId, userId, channelId, sentiment, emoji = null }) {
  insertFeedback.run(assistantMessageId, userId, channelId, sentiment, emoji, Date.now());
}

export function removeFeedback({ assistantMessageId, userId }) {
  deleteFeedback.run(assistantMessageId, userId);
}

export function feedbackCounts(hours = 168) {
  const since = Date.now() - hours * 3600 * 1000;
  const rows = feedbackSummary.all(since);
  const out = { up: 0, down: 0, window_hours: hours };
  for (const r of rows) out[r.sentiment] = r.n;
  return out;
}

export function loadChannelHistoryForSummary({ channelId, limit }) {
  const desc = selectChannelHistoryForSummary.all(channelId, limit);
  return desc.slice().reverse();
}

const selectUserSpendSince = db.prepare(`
  SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM turns
  WHERE user_id = ? AND created_at >= ?
`);

export function userSpendSince(userId, sinceMs) {
  return selectUserSpendSince.get(userId, sinceMs).spend;
}

const clearEmbeddings = db.prepare(`
  UPDATE messages SET embedding = NULL, embedding_model = NULL WHERE role = 'user'
`);
const clearPgvectorSync = db.prepare(`DELETE FROM pgvector_sync`);

export function clearAllEmbeddings() {
  const t = db.exec.bind(db);
  t('BEGIN');
  try {
    const res = clearEmbeddings.run();
    clearPgvectorSync.run();
    t('COMMIT');
    return res.changes;
  } catch (e) {
    t('ROLLBACK');
    throw e;
  }
}

const selectRecentFeedback = db.prepare(`
  SELECT
    f.id, f.assistant_message_id, f.user_id, f.channel_id, f.sentiment,
    f.created_at,
    am.content AS reply_content,
    am.model   AS model,
    um.content AS question_content
  FROM feedback f
  LEFT JOIN messages am ON am.id = f.assistant_message_id
  LEFT JOIN turns t      ON t.assistant_message_id = f.assistant_message_id
  LEFT JOIN messages um  ON um.id = t.user_message_id
  WHERE f.created_at >= ?
  ORDER BY f.created_at DESC
  LIMIT ?
`);

export function recentFeedback({ hours = 168, limit = 20 } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  return selectRecentFeedback.all(since, limit);
}

// Channel export: full message list with role, content, model, cost, and
// tool uses. Excludes the binary embedding column. Capped at 10000 rows
// so an unbounded export against a high-volume channel doesn't load
// hundreds of MB into memory before the Discord 24MB attachment limit
// rejects the upload anyway. Most channels won't approach this; the
// /export response surfaces the truncation when it happens.
const EXPORT_ROW_CAP = 10000;
const selectChannelExport = db.prepare(`
  SELECT id, role, user_id, username, content, model,
         tool_uses, input_tokens, output_tokens, cost_usd, latency_ms,
         created_at
  FROM messages
  WHERE channel_id = ?
  ORDER BY id ASC
  LIMIT ?
`);

export function exportChannel(channelId) {
  // Fetch one row beyond the cap so callers can tell 'exactly cap' from
  // 'cap reached, more available' without a separate COUNT query.
  const probeRows = selectChannelExport.all(channelId, EXPORT_ROW_CAP + 1);
  const truncated = probeRows.length > EXPORT_ROW_CAP;
  const rows = truncated ? probeRows.slice(0, EXPORT_ROW_CAP) : probeRows;
  const messages = rows.map((r) => ({
    id: r.id,
    role: r.role,
    user_id: r.user_id,
    username: r.username,
    content: r.content,
    model: r.model,
    tool_uses: r.tool_uses ? JSON.parse(r.tool_uses) : null,
    tokens: {
      input: r.input_tokens,
      output: r.output_tokens,
    },
    cost_usd: r.cost_usd,
    latency_ms: r.latency_ms,
    created_at: new Date(r.created_at).toISOString(),
  }));
  return { messages, truncated, cap: EXPORT_ROW_CAP };
}

// ---- User notes ---------------------------------------------------------
// Opt-in per-user context. Each note is a short free-form line the user
// asked the bot to remember about them. Surfaces in the system prompt
// AFTER the cache breakpoint so it does not invalidate the shared cached
// prefix.

const MAX_NOTES_PER_USER = 12;
const MAX_NOTE_CHARS = 280;

const insertUserNote = db.prepare(`
  INSERT INTO user_notes (user_id, content, created_at) VALUES (?, ?, ?)
`);
const selectUserNotes = db.prepare(`
  SELECT id, content, created_at FROM user_notes
  WHERE user_id = ?
  ORDER BY created_at ASC, id ASC
`);
const deleteUserNoteById = db.prepare(`
  DELETE FROM user_notes WHERE id = ? AND user_id = ?
`);
const deleteAllUserNotes = db.prepare(`
  DELETE FROM user_notes WHERE user_id = ?
`);
const countUserNotes = db.prepare(`
  SELECT COUNT(*) AS n FROM user_notes WHERE user_id = ?
`);

export function addUserNote({ userId, content }) {
  const trimmed = (content || '').trim().slice(0, MAX_NOTE_CHARS);
  if (!trimmed) return { ok: false, reason: 'empty' };
  const existing = countUserNotes.get(userId).n;
  if (existing >= MAX_NOTES_PER_USER) {
    return { ok: false, reason: 'full', cap: MAX_NOTES_PER_USER };
  }
  const result = insertUserNote.run(userId, trimmed, Date.now());
  return { ok: true, id: Number(result.lastInsertRowid), remaining: MAX_NOTES_PER_USER - existing - 1 };
}

export function listUserNotes(userId) {
  return selectUserNotes.all(userId);
}

export function deleteUserNote({ userId, id }) {
  const r = deleteUserNoteById.run(id, userId);
  return Number(r.changes);
}

export function clearUserNotes(userId) {
  const r = deleteAllUserNotes.run(userId);
  return Number(r.changes);
}

export function loadUserNotesAsBlock(userId, username = null) {
  if (!userId) return null;
  const rows = selectUserNotes.all(userId);
  if (rows.length === 0) return null;
  const lines = rows.map((r, i) => `${i + 1}. ${r.content}`);
  const who = username ? `the current asker (${username})` : 'the current asker';
  return `[NOTES FOR THIS ASKER]\n${who} has asked you to remember the following. Apply them when relevant; do not announce that you are doing so. These notes pertain to ${who} only, not to other speakers in the channel.\n\n${lines.join('\n')}`;
}

// Aggregate usage stats over a rolling window (default 24h) for the /usage
// command. Returns total turns, tokens, cost, plus a per-user breakdown.
const selectUsageSummary = db.prepare(`
  SELECT
    COUNT(*)            AS turns,
    SUM(input_tokens)   AS input_tokens,
    SUM(output_tokens)  AS output_tokens,
    SUM(cache_creation_input_tokens) AS cache_creation_tokens,
    SUM(cache_read_input_tokens)     AS cache_read_tokens,
    SUM(cost_usd)       AS cost_usd,
    AVG(latency_ms)     AS avg_latency_ms
  FROM turns
  WHERE created_at >= ?
`);

// Pull the sorted latencies separately so /usage can compute p50/p95.
// SQLite older than 3.43 doesn't ship PERCENTILE_CONT; doing the sort
// in JS sidesteps the version dependency and the cost is bounded by
// the time window (typically <1k turns/day for this community).
const selectTurnLatencies = db.prepare(`
  SELECT latency_ms FROM turns
  WHERE created_at >= ? AND latency_ms IS NOT NULL
  ORDER BY latency_ms ASC
`);

const selectUsageByUser = db.prepare(`
  SELECT user_id, COUNT(*) AS turns, SUM(cost_usd) AS cost_usd, SUM(input_tokens + output_tokens) AS tokens
  FROM turns
  WHERE created_at >= ?
  GROUP BY user_id
  ORDER BY cost_usd DESC
  LIMIT 10
`);

const selectUsageByModel = db.prepare(`
  SELECT model, COUNT(*) AS turns, SUM(cost_usd) AS cost_usd
  FROM turns
  WHERE created_at >= ?
  GROUP BY model
  ORDER BY cost_usd DESC
`);

// Tool-use counts + average latency from the assistant message rows'
// tool_uses JSON. Each entry carries {name, input, round, latency_ms};
// the average is over entries where latency_ms is non-null (server-side
// tools like web_search currently emit null latency since their cost
// surfaces from Anthropic's usage payload, not from executeTool).
// SQLite's json_each() is fine on small stores; the time-range index
// keeps the scan bounded.
const selectToolUseCounts = db.prepare(`
  SELECT
    j.value->>'name' AS tool,
    COUNT(*) AS calls,
    AVG(CAST(j.value->>'latency_ms' AS REAL)) AS avg_latency_ms
  FROM messages m, json_each(m.tool_uses) j
  WHERE m.role = 'assistant'
    AND m.tool_uses IS NOT NULL
    AND m.created_at >= ?
  GROUP BY tool
  ORDER BY calls DESC
`);

// R-7 linear-interpolation percentile (Excel.PERCENTILE.INC). Exported
// so /usage and the postmortem script compute identical p50/p95 over
// the same window — without the shared helper, /usage used R-7 while
// postmortem used nearest-neighbor and the two reports disagreed on
// the same data.
//
// Expects a NON-empty, sorted-ascending array; returns null when
// empty. Returns Math.round(value) so callers don't have to.
export function percentile(sortedAsc, p) {
  if (!sortedAsc || sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return Math.round(sortedAsc[0]);
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sortedAsc[lo]);
  const frac = idx - lo;
  return Math.round(sortedAsc[lo] + frac * (sortedAsc[hi] - sortedAsc[lo]));
}

export function usageSummary(hours = 24) {
  const since = Date.now() - hours * 3600 * 1000;
  // SQLite versions without json_each will throw; treat as zero tool calls.
  let byTool;
  try {
    byTool = selectToolUseCounts.all(since);
  } catch {
    byTool = [];
  }
  // p50/p95 derived in JS over the sorted latency rows so SQLite version
  // skew on PERCENTILE_CONT doesn't matter. selectTurnLatencies already
  // orders ASC; pass straight to the shared percentile() helper.
  const latencies = selectTurnLatencies.all(since).map((r) => r.latency_ms);
  return {
    window_hours: hours,
    total: selectUsageSummary.get(since),
    p50_latency_ms: percentile(latencies, 0.5),
    p95_latency_ms: percentile(latencies, 0.95),
    by_user: selectUsageByUser.all(since),
    by_model: selectUsageByModel.all(since),
    by_tool: byTool,
  };
}

// ---- Per-user activity (drives /whoami) --------------------------------
// Caller's own activity over a window. Mirrors usageSummary's shape but
// scoped to a single user so /whoami can render an at-a-glance card
// without an owner-only data leak.

const selectUserActivity = db.prepare(`
  SELECT
    COUNT(*) AS turns,
    SUM(cost_usd) AS cost_usd,
    SUM(input_tokens + output_tokens) AS tokens,
    AVG(latency_ms) AS avg_latency_ms
  FROM turns
  WHERE user_id = ? AND created_at >= ?
`);

const selectUserFeedbackGiven = db.prepare(`
  SELECT sentiment, COUNT(*) AS n
  FROM feedback
  WHERE user_id = ? AND created_at >= ?
  GROUP BY sentiment
`);

const selectUserLastTurn = db.prepare(`
  SELECT MAX(created_at) AS last_at FROM turns WHERE user_id = ?
`);

export function userActivitySummary(userId, hours = 168) {
  const since = Date.now() - hours * 3600 * 1000;
  const activity = selectUserActivity.get(userId, since);
  const feedback = selectUserFeedbackGiven.all(userId, since);
  const fb = { up: 0, down: 0 };
  for (const r of feedback) fb[r.sentiment] = r.n;
  const lastRow = selectUserLastTurn.get(userId);
  return {
    user_id: userId,
    window_hours: hours,
    turns: activity?.turns ?? 0,
    cost_usd: activity?.cost_usd ?? 0,
    tokens: activity?.tokens ?? 0,
    avg_latency_ms: activity?.avg_latency_ms ?? null,
    feedback_given: fb,
    last_turn_at: lastRow?.last_at ?? null,
  };
}

// ---- Per-channel stats (drives /stats) ----------------------------------
// Channel-level rollup so anyone in the channel can see a snapshot of how
// the bot is being used here. Distinct from /usage (which is server-wide)
// and /whoami (which is user-scoped).

const selectChannelTotals = db.prepare(`
  SELECT
    COUNT(*) AS turns,
    COUNT(DISTINCT user_id) AS askers,
    SUM(cost_usd) AS cost_usd,
    SUM(input_tokens + output_tokens) AS tokens,
    AVG(latency_ms) AS avg_latency_ms
  FROM turns
  WHERE channel_id = ? AND created_at >= ?
`);

const selectChannelTopAskers = db.prepare(`
  SELECT user_id, COUNT(*) AS turns
  FROM turns
  WHERE channel_id = ? AND created_at >= ?
  GROUP BY user_id
  ORDER BY turns DESC
  LIMIT 5
`);

// Tool counts scoped to a channel. Joins messages (which carry the
// channel_id and the tool_uses JSON) on the audit row's
// assistant_message_id so the channel filter applies before json_each
// expands the array. Falls back to an empty array if json_each is
// missing (old SQLite), matching usageSummary's behavior.
const selectChannelToolCounts = db.prepare(`
  SELECT
    j.value->>'name' AS tool,
    COUNT(*) AS calls
  FROM messages m, json_each(m.tool_uses) j
  WHERE m.role = 'assistant'
    AND m.tool_uses IS NOT NULL
    AND m.channel_id = ?
    AND m.created_at >= ?
  GROUP BY tool
  ORDER BY calls DESC
  LIMIT 10
`);

const selectChannelTotalAllTime = db.prepare(`
  SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?
`);

// ---- Per-user model preference (drives /model) -------------------------
// Stored as a short label (sonnet|opus|haiku) — see migration 010 in
// db.js for the rationale. Callers in bot.js resolve the label to the
// current model id via MODEL_CHOICES.

const ALLOWED_MODEL_LABELS = new Set(['sonnet', 'opus', 'haiku']);

const selectUserPreference = db.prepare(`
  SELECT preferred_model, updated_at FROM user_preferences WHERE user_id = ?
`);
const upsertUserPreference = db.prepare(`
  INSERT INTO user_preferences (user_id, preferred_model, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      preferred_model = excluded.preferred_model,
      updated_at = excluded.updated_at
`);
const deleteUserPreference = db.prepare(`
  DELETE FROM user_preferences WHERE user_id = ?
`);

export function getUserModelPreference(userId) {
  if (!userId) return null;
  const row = selectUserPreference.get(userId);
  return row?.preferred_model || null;
}

export function setUserModelPreference({ userId, label }) {
  if (!userId) return { ok: false, reason: 'no_user' };
  // Validate at the data layer too — bot.js gates the choice via
  // Discord's addChoices, but a future caller (admin tool, migration
  // script, REST endpoint) could pass an arbitrary string. Keep the
  // table consistent.
  if (!ALLOWED_MODEL_LABELS.has(label)) {
    return { ok: false, reason: 'invalid_label', allowed: [...ALLOWED_MODEL_LABELS] };
  }
  upsertUserPreference.run(userId, label, Date.now());
  return { ok: true, label };
}

export function clearUserModelPreference(userId) {
  if (!userId) return 0;
  const r = deleteUserPreference.run(userId);
  return Number(r.changes);
}

export function channelStats(channelId, hours = 168) {
  const since = Date.now() - hours * 3600 * 1000;
  const totals = selectChannelTotals.get(channelId, since) || {};
  const askers = selectChannelTopAskers.all(channelId, since);
  let tools;
  try {
    tools = selectChannelToolCounts.all(channelId, since);
  } catch {
    tools = [];
  }
  const allTime = selectChannelTotalAllTime.get(channelId)?.n ?? 0;
  return {
    channel_id: channelId,
    window_hours: hours,
    turns: totals.turns ?? 0,
    distinct_askers: totals.askers ?? 0,
    cost_usd: totals.cost_usd ?? 0,
    tokens: totals.tokens ?? 0,
    avg_latency_ms: totals.avg_latency_ms ?? null,
    top_askers: askers,
    top_tools: tools,
    total_messages_all_time: allTime,
  };
}
