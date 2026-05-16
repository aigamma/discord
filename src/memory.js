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
