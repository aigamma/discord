// /summarize handler: pulls recent channel history, asks the model for a
// tight brief, returns the assistant's reply.
//
// Bypasses the full agent loop because summaries do not need tool-use —
// the model summarizes what it sees, nothing more. Skips persistence:
// summaries are utility output, not contributions to chat memory.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { loadChannelHistoryForSummary } from './memory.js';
import { priceUsage } from './pricing.js';
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

export async function summarize({ channelId, lookbackMessages = 100, onProgress = null }) {
  const rows = loadChannelHistoryForSummary({ channelId, limit: lookbackMessages });
  if (rows.length === 0) {
    return { text: 'Nothing to summarize. No messages persisted in this channel yet.' };
  }
  const transcript = formatTranscript(rows);
  const t0 = Date.now();

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

  let accumulated = '';
  stream.on('text', (_delta, snapshot) => {
    accumulated = snapshot;
    if (onProgress) {
      try { onProgress(accumulated); } catch { /* swallow */ }
    }
  });

  const response = await stream.finalMessage();
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const latency = Date.now() - t0;
  const cost = priceUsage(config.anthropic.model, response.usage);
  logger.info('summary produced', {
    channel_id: channelId,
    messages_summarized: rows.length,
    model: config.anthropic.model,
    cost_usd: cost,
    latency_ms: latency,
  });

  return { text, latency, cost, messagesSummarized: rows.length };
}
