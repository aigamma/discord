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
  ORDER BY created_at DESC
  LIMIT ?
`);

const deleteChannelSince = db.prepare(`
  DELETE FROM messages WHERE channel_id = ? AND created_at >= ?
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
  SELECT m.id, m.channel_id, m.user_id, m.username, m.content, m.created_at, m.embedding
  FROM messages m
  WHERE m.embedding IS NOT NULL AND m.role = 'user'
`);

const selectAssistantForUser = db.prepare(`
  SELECT m.content, m.created_at
  FROM turns t
  JOIN messages m ON m.id = t.assistant_message_id
  WHERE t.user_message_id = ?
  LIMIT 1
`);

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
export function loadShortTermContext({ channelId, isMultiUser = false }) {
  const turns = config.memory.shortTermTurns;
  const windowMs = config.memory.shortTermMinutes * 60 * 1000;
  const since = Date.now() - windowMs;

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

// Clear the short-term window for a channel (used by the /forget slash
// command). Returns count of deleted rows.
export function clearShortTermContext({ channelId }) {
  const windowMs = config.memory.shortTermMinutes * 60 * 1000;
  const since = Date.now() - windowMs;
  const result = deleteChannelSince.run(channelId, since);
  return Number(result.changes);
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

export function setEmbedding(id, blob, model) {
  updateEmbedding.run(blob, model, id);
}

// Returns every embedded user message paired with its embedding (deserialized).
// Iterates in chunks so the entire corpus does not have to land in memory at
// once for very large stores. Used by the semantic-search tool.
export function* iterEmbeddedUserMessages() {
  for (const row of selectEmbeddedUserMessages.iterate()) {
    yield row;
  }
}

export function getAssistantResponseFor(userMessageId) {
  return selectAssistantForUser.get(userMessageId);
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

export function usageSummary(hours = 24) {
  const since = Date.now() - hours * 3600 * 1000;
  return {
    window_hours: hours,
    total: selectUsageSummary.get(since),
    by_user: selectUsageByUser.all(since),
    by_model: selectUsageByModel.all(since),
  };
}
