// /summarize handler: pulls recent channel history, asks the model for a
// tight brief, returns the assistant's reply.
//
// Bypasses the full agent loop because summaries do not need tool-use —
// the model summarizes what it sees, nothing more. Skips persistence:
// summaries are utility output, not contributions to chat memory.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { loadChannelHistoryForSummary, persistMessage, persistTurn } from './memory.js';
import { priceUsage } from './pricing.js';
import { withAnthropicRetry } from './anthropicRetry.js';
import { beginWork, isShuttingDown } from './lifecycle.js';
import { logger } from './logger.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM = `You produce tight briefs of trading-channel conversation. The reader missed the last hour or two and wants to know what was discussed without scrolling. Constraints:

Begin with the substance, not a preamble. Never write "Here is a summary" or any variant.
Cover topics in the order they arose. One short paragraph per topic. No bullets.
Name participants by Discord handle when attribution matters. Skip attribution when the topic is general.
Quote a specific number, level, or call when it appeared in the discussion. Vague is useless.
Skip pleasantries, greetings, and any chitchat that did not contain market or strategic content.
Cap at six paragraphs total. End with a declarative sentence. Never close with a question or a hook.
No em-dashes. No metaphors or analogies. No emojis.`;

// Per-message cap. Messages larger than this get truncated with an
// elision marker. Prevents a pathological paste from blowing up the
// summarization request's context. Median chat message is well under
// 1KB; the 2KB cap retains substance and bounds total transcript size.
const MAX_LINE_CHARS = 2000;

function formatTranscript(rows) {
  const lines = [];
  for (const r of rows) {
    const t = new Date(r.created_at).toISOString().slice(11, 16);
    const speaker = r.role === 'assistant' ? 'bot' : (r.username || 'user');
    const content = r.content.length > MAX_LINE_CHARS
      ? r.content.slice(0, MAX_LINE_CHARS) + ' …[truncated]'
      : r.content;
    lines.push(`[${t}] ${speaker}: ${content}`);
  }
  return lines.join('\n');
}

export async function summarize({ channelId, guildId = null, userId = null, lookbackMessages = 100, onProgress = null }) {
  if (isShuttingDown()) {
    throw new Error('Bot is shutting down; new requests refused.');
  }
  const releaseWork = beginWork();
  try {
    return await summarizeInner({ channelId, guildId, userId, lookbackMessages, onProgress });
  } finally {
    releaseWork();
  }
}

async function summarizeInner({ channelId, guildId, userId, lookbackMessages, onProgress }) {
  const rows = loadChannelHistoryForSummary({ channelId, limit: lookbackMessages });
  if (rows.length === 0) {
    return { text: 'Nothing to summarize. No messages persisted in this channel yet.' };
  }
  const transcript = formatTranscript(rows);
  const t0 = Date.now();

  // Wrap creation + finalMessage in the retry — wrapping only stream()
  // misses the actual transient failure path (network errors surface
  // from finalMessage, not from the sync return).
  const response = await withAnthropicRetry(async () => {
    const stream = client.messages.stream({
      model: config.anthropic.model,
      max_tokens: 1500,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Summarize the following channel transcript. ${rows.length} messages, oldest first:\n\n${transcript}`,
        },
      ],
    });
    stream.on('text', (_delta, snapshot) => {
      if (onProgress) {
        try { onProgress(snapshot); } catch { /* swallow */ }
      }
    });
    return await stream.finalMessage();
  });
  let text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  // Surface max_tokens truncation so the operator can see the summary
  // cut off mid-sentence rather than wondering why it stopped abruptly.
  // Matches the pattern agent.js uses for the same stop reason.
  if (response.stop_reason === 'max_tokens' && text) {
    text += '\n\n_(summary truncated at the max-tokens limit)_';
  }

  const latency = Date.now() - t0;
  const cost = priceUsage(config.anthropic.model, response.usage);
  logger.info('summary produced', {
    channel_id: channelId,
    messages_summarized: rows.length,
    model: config.anthropic.model,
    cost_usd: cost,
    latency_ms: latency,
  });

  // Record into the audit log so /usage, the daily cost cap, and the
  // postmortem report all see /summarize cost. Skipped silently when
  // userId is missing (the older calling convention before the
  // audit-thread-through change).
  if (userId) {
    try {
      // No user-message row: a synthetic '[/summarize messages=N]' line
      // would pollute the embeddings corpus and surface as a confusing hit
      // in search_chat_history. The turns row references user_message_id
      // null (column is nullable), which the audit log handles.
      const aMid = persistMessage({
        channelId, guildId,
        userId: 'bot', username: 'bot',
        role: 'assistant', content: text, model: config.anthropic.model,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? null,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? null,
        costUsd: cost,
        latencyMs: latency,
      });
      persistTurn({
        channelId, userId,
        userMessageId: null, assistantMessageId: aMid,
        model: config.anthropic.model,
        stopReason: response.stop_reason || 'end_turn',
        toolRounds: 0,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? null,
        cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? null,
        costUsd: cost,
        latencyMs: latency,
        error: null,
      });
    } catch (persistErr) {
      logger.error('summarize audit-log write failed', { err: persistErr });
    }
  }

  return { text, latency, cost, messagesSummarized: rows.length };
}
