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
import { loadShortTermContext, persistMessage, persistTurn, loadUserNotesAsBlock } from './memory.js';
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
  // Server-tool counts (currently web_search_requests). Accumulate per key
  // so a multi-round turn with searches in multiple rounds bills correctly.
  if (usage.server_tool_use && typeof usage.server_tool_use === 'object') {
    acc.server_tool_use ??= {};
    for (const [k, v] of Object.entries(usage.server_tool_use)) {
      if (Number.isFinite(v)) acc.server_tool_use[k] = (acc.server_tool_use[k] || 0) + v;
    }
  }
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
// across turns. Per-turn temporal + per-user notes sit after the
// breakpoint and vary freely.
function buildSystemBlocks({ userId } = {}) {
  const userNotesBlock = userId ? loadUserNotesAsBlock(userId) : null;
  const full = buildSystemPrompt({ userNotesBlock });
  const splitMarker = '\n\n[TIME AND MARKET SESSION]';
  const idx = full.indexOf(splitMarker);
  if (idx === -1) {
    return [{ type: 'text', text: full, cache_control: { type: 'ephemeral' } }];
  }
  const stable = full.slice(0, idx);
  const tail = full.slice(idx + 2);
  return [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: tail },
  ];
}

/**
 * Run one Sonnet turn end-to-end: load short-term context, build the
 * system prompt with cache-control breakpoint, stream the model response
 * with tool-use loops, persist the user message + assistant message + an
 * audit row in `turns`, and return the final text along with cost and
 * usage attribution.
 *
 * @param {object} args
 * @param {string} args.channelId            Discord channel id.
 * @param {string|null} [args.guildId]       Discord guild id (null for DMs).
 * @param {string} args.userId               Discord user id of the asker.
 * @param {string|null} [args.username]      Display name for multi-user prefix.
 * @param {string|null} [args.discordMessageId]  The user's source Discord message id.
 * @param {boolean} [args.isMultiUser=false] Prefix user content with `[name]:` when true.
 * @param {string} args.userMessage          The question text (raw, unprefixed).
 * @param {string|null} [args.modelOverride] Override the configured default model.
 * @param {(text: string) => void} [args.onProgress] Streaming callback; fires per text delta.
 * @param {(toolNames: string[]) => void} [args.onToolStart] Fires when a round resolves to tool_use.
 * @returns {Promise<{
 *   text: string,
 *   toolUses: Array<{name: string, input: object, round: number}>,
 *   usage: {input_tokens: number, output_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number},
 *   cost: number|null,
 *   latency: number,
 *   stopReason: string,
 *   model: string,
 *   assistantMessageId: number|null,
 * }>}
 */
export async function answer({
  channelId,
  guildId = null,
  userId,
  username = null,
  discordMessageId = null,
  isMultiUser = false,
  userMessage,
  modelOverride = null,
  onProgress = null,
  onToolStart = null,
}) {
  if (isShuttingDown()) {
    throw new Error('Bot is shutting down; new requests refused.');
  }
  const releaseWork = beginWork();
  try {
    return await answerInner({
      channelId, guildId, userId, username, discordMessageId, isMultiUser,
      userMessage, modelOverride, onProgress, onToolStart,
    });
  } finally {
    releaseWork();
  }
}

async function answerInner({
  channelId,
  guildId,
  userId,
  username,
  discordMessageId,
  isMultiUser,
  userMessage,
  modelOverride,
  onProgress,
  onToolStart,
}) {
  const t0 = Date.now();
  const model = modelOverride || config.anthropic.model;
  const toolSpecs = getToolSpecs();
  const tools = buildToolsWithCache(toolSpecs);
  const systemBlocks = buildSystemBlocks({ userId });

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

  // Cumulative across all rounds so commentary the model emits before a
  // tool call ("I'll check VIX.") doesn't vanish when the next round
  // starts streaming. Each round's stream contributes a fresh suffix.
  let runningText = '';

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = await withRetry(async () =>
        client.messages.stream({
          model,
          max_tokens: config.anthropic.maxTokens,
          system: systemBlocks,
          tools,
          messages,
        })
      );

      const roundStart = runningText;
      stream.on('text', (_delta, snapshot) => {
        runningText = roundStart + (roundStart && snapshot ? '\n' : '') + snapshot;
        if (onProgress) {
          try { onProgress(runningText); } catch { /* swallow */ }
        }
      });

      const response = await stream.finalMessage();
      accumulateUsage(usage, response.usage);
      stopReason = response.stop_reason;

      // pause_turn means the model wants to continue but hit a soft context
      // boundary. Append the partial assistant content and loop again so the
      // model can resume from where it left off. No tool_results needed
      // because no tool was invoked. Still counts against MAX_TOOL_ROUNDS so
      // a runaway can't loop forever.
      if (response.stop_reason === 'pause_turn') {
        toolRounds++;
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

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

      // Capture server-side tool calls (web_search, web_fetch) for the
      // audit log even though Anthropic executes them on our behalf.
      // Without this, /usage's 'by tool' breakdown undercounts and the
      // turns audit row can't explain why a turn cost what it did.
      for (const block of response.content) {
        if (block.type === 'server_tool_use') {
          allToolUses.push({ name: block.name, input: block.input, round, server: true });
        }
      }

      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      if (onToolStart && toolUseBlocks.length > 0) {
        try { onToolStart(toolUseBlocks.map((b) => b.name)); } catch { /* swallow */ }
      }

      // Tools in a single round are independent — Anthropic invokes them
      // as a batch and the order of results doesn't matter for the model's
      // next step. Parallelize so a five-tool round doesn't pay the sum of
      // five Supabase round trips.
      for (const block of toolUseBlocks) {
        allToolUses.push({ name: block.name, input: block.input, round });
      }
      const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
        // Defense in depth: clamp privacy-sensitive tool inputs against
        // the caller's actual context so a model (or a prompt-injection
        // attempt) cannot widen the scope. Currently only
        // search_chat_history is affected; new privacy-sensitive tools
        // should be added here as they land.
        let toolInput = block.input;
        if (block.name === 'search_chat_history') {
          toolInput = {
            ...toolInput,
            guild_id: guildId || null,
            // In a DM (no guildId), force channel-only scope so a model
            // can't pull from other users' DMs even by passing channel_id
            // = null.
            channel_id: guildId ? toolInput?.channel_id ?? null : channelId,
          };
        }
        const result = await executeTool(block.name, toolInput);
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      }));
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
    throw err;
  }

  const latency = Date.now() - t0;
  const cost = priceUsage(model, usage);

  if (!finalText && toolRounds >= MAX_TOOL_ROUNDS) {
    finalText = '_(Hit the tool-use round limit before reaching a final answer.)_';
    stopReason = 'tool_rounds_exceeded';
  }

  // Truncation hint: when Anthropic stops because the response hit
  // max_tokens, the visible reply is mid-sentence. The user deserves a
  // signal rather than wondering why the bot trailed off. Appended only
  // when text was produced; otherwise the empty-response placeholder
  // path handles it.
  if (stopReason === 'max_tokens' && finalText) {
    finalText += '\n\n_(response truncated at the max-tokens limit)_';
  }

  // Persistence is best-effort against the user-visible reply. If the
  // SQLite store is full or temporarily broken, the user still gets the
  // model's answer; we just lose the audit row for that turn.
  let userMessageId;
  let assistantMessageId;
  try {
    userMessageId = persistMessage({
      channelId, guildId, userId, username, discordMessageId,
      role: 'user', content: userMessage, model,
    });
    assistantMessageId = persistMessage({
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
  } catch (persistErr) {
    logger.error('audit-log write failed; reply will still be delivered', { err: persistErr, channel_id: channelId });
  }

  logger.info('turn completed', {
    channel_id: channelId,
    user_id: userId,
    model,
    stop_reason: stopReason,
    tool_rounds: toolRounds,
    cost_usd: cost,
    latency_ms: latency,
  });

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
