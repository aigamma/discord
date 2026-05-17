// Anthropic tool-use loop with conversation memory and cost accounting.
//
// Flow per turn:
//   1. Load short-term context from SQLite (last N channel messages, time-windowed)
//   2. Append the new user message
//   3. Call Anthropic; if stop_reason === 'tool_use', execute tools, loop
//   4. Persist user + assistant + tool-use audit, plus a `turns` row
//
// The model and system prompt are cache-broken (cache_control: ephemeral on
// the system block + the last tool definition) so a sustained channel
// conversation reuses Anthropic's prompt cache across turns inside the
// 5-minute sliding window. This is the same pattern aigamma.com's chat
// function uses.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { getToolSpecs, executeTool } from './tools/index.js';
import { loadShortTermContext, persistMessage, persistTurn } from './memory.js';
import { priceUsage } from './pricing.js';
import { beginWork, isShuttingDown } from './lifecycle.js';
import { logger } from './logger.js';

const MAX_TOOL_ROUNDS = 8;
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 8000];

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Anthropic's server-side tools sit alongside the bot's own tools. The model
// invokes them inside a single API call; results come back as content blocks
// without round-tripping through our executeTool. We just register them.
function getServerTools() {
  const out = [];
  if (config.anthropic.webSearchEnabled) {
    out.push({ type: 'web_search_20250305', name: 'web_search' });
  }
  if (config.anthropic.webFetchEnabled) {
    out.push({ type: 'web_fetch_20250910', name: 'web_fetch' });
  }
  return out;
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const transient = status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
      if (!transient || attempt === RETRY_ATTEMPTS - 1) throw err;
      const wait = RETRY_BACKOFF_MS[attempt] || 5000;
      logger.warn('anthropic transient error; retrying', { status, attempt: attempt + 1, wait_ms: wait });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function accumulateUsage(acc, usage) {
  if (!usage) return acc;
  acc.input_tokens += usage.input_tokens || 0;
  acc.output_tokens += usage.output_tokens || 0;
  acc.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  acc.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  return acc;
}

function buildToolsWithCache(specs) {
  const all = [...specs, ...getServerTools()];
  if (!all.length) return undefined;
  const tools = all.map((s) => ({ ...s }));
  tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
  return tools;
}

// Split the system prompt at the temporal block so the static prefix
// (persona + identity + constraints + definitions + tools) stays cacheable
// across turns and only the per-turn timestamp invalidates the second block.
function buildSystemBlocks() {
  const full = buildSystemPrompt();
  const splitMarker = '\n\n[TIME AND MARKET SESSION]';
  const idx = full.indexOf(splitMarker);
  if (idx === -1) {
    return [{ type: 'text', text: full, cache_control: { type: 'ephemeral' } }];
  }
  const stable = full.slice(0, idx);
  const temporal = full.slice(idx + 2);
  return [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: temporal },
  ];
}

export async function answer({
  channelId,
  guildId = null,
  userId,
  username = null,
  discordMessageId = null,
  isMultiUser = false,
  userMessage,
  modelOverride = null,
}) {
  if (isShuttingDown()) {
    throw new Error('Bot is shutting down; new requests refused.');
  }
  const releaseWork = beginWork();
  const t0 = Date.now();
  const model = modelOverride || config.anthropic.model;
  const toolSpecs = getToolSpecs();
  const tools = buildToolsWithCache(toolSpecs);
  const systemBlocks = buildSystemBlocks();

  const historicalMessages = loadShortTermContext({ channelId, isMultiUser });
  const userContent = isMultiUser && username ? `[${username}]: ${userMessage}` : userMessage;
  const messages = [...historicalMessages, { role: 'user', content: userContent }];

  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const allToolUses = [];
  let stopReason = null;
  let toolRounds = 0;
  let finalText = '';

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await withRetry(() => client.messages.create({
        model,
        max_tokens: config.anthropic.maxTokens,
        system: systemBlocks,
        tools,
        messages,
      }));

      accumulateUsage(usage, response.usage);
      stopReason = response.stop_reason;

      if (response.stop_reason !== 'tool_use') {
        finalText = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        break;
      }

      toolRounds++;
      messages.push({ role: 'assistant', content: response.content });

      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        allToolUses.push({ name: block.name, input: block.input, round });
        const result = await executeTool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    const latency = Date.now() - t0;
    const userMessageId = persistMessage({
      channelId, guildId, userId, username, discordMessageId,
      role: 'user', content: userMessage, model,
      latencyMs: 0,
    });
    persistTurn({
      channelId, userId,
      userMessageId, assistantMessageId: null,
      model, stopReason: 'error', toolRounds,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
      costUsd: priceUsage(model, usage),
      latencyMs: latency,
      error: err?.message || String(err),
    });
    releaseWork();
    throw err;
  }

  const latency = Date.now() - t0;
  const cost = priceUsage(model, usage);

  if (!finalText && toolRounds >= MAX_TOOL_ROUNDS) {
    finalText = '_(Hit the tool-use round limit before reaching a final answer.)_';
    stopReason = 'tool_rounds_exceeded';
  }

  const userMessageId = persistMessage({
    channelId, guildId, userId, username, discordMessageId,
    role: 'user', content: userMessage, model,
  });

  const assistantMessageId = persistMessage({
    channelId, guildId,
    userId: 'bot', username: 'bot',
    role: 'assistant', content: finalText, model,
    toolUses: allToolUses,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    costUsd: cost,
    latencyMs: latency,
  });

  persistTurn({
    channelId, userId,
    userMessageId, assistantMessageId,
    model, stopReason, toolRounds,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    costUsd: cost,
    latencyMs: latency,
    error: null,
  });

  logger.info('turn completed', {
    channel_id: channelId,
    user_id: userId,
    model,
    stop_reason: stopReason,
    tool_rounds: toolRounds,
    cost_usd: cost,
    latency_ms: latency,
  });

  releaseWork();
  return {
    text: finalText,
    toolUses: allToolUses,
    usage,
    cost,
    latency,
    stopReason,
    model,
    assistantMessageId,
  };
}
