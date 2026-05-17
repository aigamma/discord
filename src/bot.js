// Discord client wiring. Surfaces:
//
//   /ask <question>         Slash command. Defers, runs the agent, edits in the reply.
//   /forget                 Clears this channel's short-term context window.
//   /usage [hours]          Cost + token summary for the last N hours (ephemeral).
//   /search <query>         Direct semantic search over channel history.
//   @<bot> <question>       Mention in any channel. Treats the text after the
//                           mention as the question.
//
// Each turn carries channel/user context into the agent so memory and audit
// log work. Per-user rate-limit is applied to every turn.

import { AttachmentBuilder, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { answer } from './agent.js';
import { config } from './config.js';
import {
  addUserNote,
  attachDiscordMessageId,
  clearShortTermContext,
  clearUserNotes,
  exportChannel,
  feedbackCounts,
  findAssistantMessage,
  listUserNotes,
  recordFeedback,
  removeFeedback,
  totalMessageCount,
  usageSummary,
} from './memory.js';
import { execute as searchHistory } from './tools/searchChatHistory.js';
import { check as checkRateLimit } from './rateLimiter.js';
import { isReady as duckdbReady, getAttachedShards } from './duckdb.js';
import { getEmbedderStats } from './embedder.js';
import { getToolCacheStats } from './tools/index.js';
import { checkPgvectorReachable, isEnabled as pgvectorEnabled } from './pgvector.js';
import { summarize } from './summarize.js';
import { createProgressReporter } from './progressReporter.js';
import { checkBudget, isBudgetEnabled } from './budget.js';
import { feedbackReport, isOwner, rebuildEmbeddings, resetUserRateLimit, triggerBackup } from './admin.js';
import { logger } from './logger.js';

const MODEL_CHOICES = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  haiku: 'claude-haiku-4-5-20251001',
};

const FEEDBACK_EMOJI = {
  '👍': 'up',
  '👎': 'down',
};

const MAX_DISCORD_MESSAGE = 2000;

function chunk(text) {
  if (text.length <= MAX_DISCORD_MESSAGE) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > MAX_DISCORD_MESSAGE) {
    let cut = remaining.lastIndexOf('\n\n', MAX_DISCORD_MESSAGE);
    if (cut < 500) cut = remaining.lastIndexOf('\n', MAX_DISCORD_MESSAGE);
    if (cut < 500) cut = remaining.lastIndexOf(' ', MAX_DISCORD_MESSAGE);
    if (cut < 500) cut = MAX_DISCORD_MESSAGE;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function stripMention(content, clientId) {
  return content
    .replace(new RegExp(`<@!?${clientId}>`, 'g'), '')
    .trim();
}

function isMultiUserChannel(channel) {
  if (!channel) return false;
  if (channel.type === ChannelType.DM) return false;
  return true;
}

function formatUsd(n) {
  if (n == null) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(2)}`;
}

async function handleAsk(interaction) {
  const question = interaction.options.getString('question', true).trim();
  const modelKey = interaction.options.getString('model') || null;
  const modelOverride = modelKey ? MODEL_CHOICES[modelKey] : null;

  if (!question) {
    await interaction.reply({ content: 'Empty question.', flags: MessageFlags.Ephemeral });
    return;
  }

  const rl = checkRateLimit(interaction.user.id);
  if (!rl.allowed) {
    await interaction.reply({
      content: `Rate limited. ${rl.count}/${rl.limit} requests used this minute. Try again in ${rl.retryInSeconds}s.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const bud = checkBudget(interaction.user.id);
  if (!bud.allowed) {
    await interaction.reply({
      content: `Daily cost cap of $${bud.cap.toFixed(2)} reached. Resets in ${Math.ceil(bud.reset_in_seconds / 3600)}h. Spent: $${bud.spent.toFixed(2)}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const reporter = createProgressReporter({
    editText: (text) => interaction.editReply(text),
    label: 'ask',
  });
  try {
    const result = await answer({
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      username: interaction.user.username,
      isMultiUser: isMultiUserChannel(interaction.channel),
      userMessage: question,
      modelOverride,
      onProgress: (text) => reporter.update(text),
      onToolStart: (names) => reporter.note(`_calling: ${names.join(', ')}_`),
    });
    const text = result.text || '_(no response)_';
    const parts = chunk(text);
    await reporter.finalize(parts[0]);
    const sentReply = await interaction.fetchReply().catch(() => null);
    if (result.assistantMessageId && sentReply?.id) {
      attachDiscordMessageId(result.assistantMessageId, sentReply.id);
    }
    for (let i = 1; i < parts.length; i++) {
      await interaction.followUp(parts[i]);
    }
  } catch (err) {
    reporter.cancel();
    logger.error('ask command failed', { err, user_id: interaction.user.id });
    await interaction.editReply(`Something went wrong: \`${err?.message || err}\``).catch(() => {});
  }
}

async function handleSummarize(interaction) {
  const limit = interaction.options.getInteger('messages') || 100;
  await interaction.deferReply();
  const reporter = createProgressReporter({
    editText: (text) => interaction.editReply(text),
    label: 'summarize',
  });
  try {
    const result = await summarize({
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      lookbackMessages: limit,
      onProgress: (text) => reporter.update(text),
    });
    const text = result.text || '_(no summary produced)_';
    const parts = chunk(text);
    await reporter.finalize(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      await interaction.followUp(parts[i]);
    }
  } catch (err) {
    reporter.cancel();
    logger.error('summarize failed', { err });
    await interaction.editReply(`Summary failed: \`${err?.message || err}\``).catch(() => {});
  }
}

async function handleForget(interaction) {
  const deleted = clearShortTermContext({ channelId: interaction.channelId });
  await interaction.reply({
    content: `Cleared ${deleted} message(s) from this channel's short-term context window.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleUsage(interaction) {
  const hours = interaction.options.getInteger('hours') || 24;
  const data = usageSummary(hours);
  const total = data.total || {};
  const fb = feedbackCounts(hours);

  const embed = new EmbedBuilder()
    .setTitle(`Usage — last ${hours}h`)
    .setColor(0x4a9eff)
    .addFields(
      { name: 'Turns', value: String(total.turns ?? 0), inline: true },
      { name: 'Cost', value: formatUsd(total.cost_usd ?? 0), inline: true },
      { name: 'Avg latency', value: total.avg_latency_ms ? `${Math.round(total.avg_latency_ms)}ms` : 'n/a', inline: true },
      { name: 'Input tokens', value: (total.input_tokens ?? 0).toLocaleString(), inline: true },
      { name: 'Output tokens', value: (total.output_tokens ?? 0).toLocaleString(), inline: true },
      { name: 'Cache read tokens', value: (total.cache_read_tokens ?? 0).toLocaleString(), inline: true },
      { name: 'Feedback', value: `${fb.up} up / ${fb.down} down`, inline: true },
    );

  if (data.by_model.length) {
    embed.addFields({
      name: 'By model',
      value: data.by_model.map((m) => `\`${m.model}\` ${m.turns} turns, ${formatUsd(m.cost_usd)}`).join('\n'),
    });
  }

  if (data.by_tool.length) {
    embed.addFields({
      name: 'By tool',
      value: data.by_tool.slice(0, 10).map((t) => `\`${t.tool}\` ${t.calls}`).join('\n'),
    });
  }

  if (isBudgetEnabled()) {
    const callerBudget = checkBudget(interaction.user.id);
    embed.addFields({
      name: 'Your daily cap',
      value: `$${callerBudget.spent.toFixed(4)} / $${callerBudget.cap.toFixed(2)} (resets in ${Math.ceil(callerBudget.reset_in_seconds / 3600)}h)`,
    });
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleSearch(interaction) {
  const query = interaction.options.getString('query', true).trim();
  const scope = interaction.options.getString('scope') || 'channel';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await searchHistory({
    query,
    limit: 5,
    channel_id: scope === 'channel' ? interaction.channelId : null,
  });

  if (result.error) {
    await interaction.editReply(`Search error: ${result.error}`);
    return;
  }
  if (!result.hits.length) {
    await interaction.editReply(`No matches above the similarity floor (scanned ${result.corpus_scanned} messages).`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Search results for "${query.slice(0, 80)}"`)
    .setColor(0x4a9eff)
    .setFooter({ text: `${result.hits.length} hit(s) · scanned ${result.corpus_scanned} messages` });

  for (const h of result.hits.slice(0, 5)) {
    const when = new Date(h.asked_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const headerSuffix = h.discord_url ? ` · [jump](${h.discord_url})` : '';
    embed.addFields({
      name: `${h.asked_by} · ${when} · sim ${h.similarity}`,
      value: [
        `> ${h.question.slice(0, 200)}`,
        h.reply ? h.reply.slice(0, 600) : '_(no reply persisted)_',
        headerSuffix ? `${headerSuffix}` : '',
      ].filter(Boolean).join('\n'),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleHealth(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const t0 = Date.now();
  const pgReachable = pgvectorEnabled() ? await checkPgvectorReachable() : null;
  const pgLatency = Date.now() - t0;
  const embedderStats = getEmbedderStats();

  const shards = duckdbReady() ? getAttachedShards() : [];
  const shardSummary = shards.length
    ? shards.map((s) => `\`${s.name}\` (${(s.sizeBytes / 1024 / 1024).toFixed(1)} MB)`).join(', ')
    : 'none attached';

  const mem = process.memoryUsage();

  const embed = new EmbedBuilder()
    .setTitle('Bot health')
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Process', value: `pid ${process.pid} · uptime ${Math.round(process.uptime())}s · rss ${(mem.rss / 1024 / 1024).toFixed(0)} MB`, inline: false },
      { name: 'Model', value: config.anthropic.model, inline: true },
      { name: 'Total messages', value: String(totalMessageCount()), inline: true },
      { name: 'Embed pending', value: String(embedderStats.pending_embed), inline: true },
      { name: 'Embedded total', value: String(embedderStats.embedded_total), inline: true },
      { name: 'Synced to pgvector', value: String(embedderStats.synced_total), inline: true },
      { name: 'Embedder failures', value: String(embedderStats.failures), inline: true },
      {
        name: 'Supabase pgvector',
        value: pgvectorEnabled()
          ? (pgReachable ? `reachable (${pgLatency}ms)` : 'UNREACHABLE')
          : 'disabled',
        inline: true,
      },
      { name: 'Voyage embeddings', value: config.voyage.enabled ? 'enabled' : 'disabled', inline: true },
      { name: 'Web search', value: config.anthropic.webSearchEnabled ? 'enabled' : 'disabled', inline: true },
      { name: 'DuckDB shards', value: shardSummary, inline: false },
    );

  const cache = getToolCacheStats();
  embed.addFields({
    name: 'Tool cache',
    value: `entries ${cache.entries} · hit rate ${(cache.hit_rate * 100).toFixed(0)}% (${cache.hits} hits / ${cache.misses} misses)`,
    inline: false,
  });

  // Lightweight database integrity probe — PRAGMA integrity_check returns
  // 'ok' on a clean store. Anything else is a flag for the operator.
  let integrity;
  try {
    const { db } = await import('./db.js');
    const row = db.prepare('PRAGMA integrity_check(1)').get();
    integrity = row?.integrity_check === 'ok' ? 'ok' : `degraded: ${row?.integrity_check ?? 'unknown'}`;
  } catch (err) {
    integrity = `probe failed: ${err?.message || err}`;
  }
  embed.addFields({ name: 'SQLite integrity', value: integrity, inline: true });

  await interaction.editReply({ embeds: [embed] });
}

async function handleRemember(interaction) {
  const note = interaction.options.getString('note', true).trim();
  if (!note) {
    await interaction.reply({ content: 'Empty note.', flags: MessageFlags.Ephemeral });
    return;
  }
  const r = addUserNote({ userId: interaction.user.id, content: note });
  if (!r.ok) {
    if (r.reason === 'full') {
      await interaction.reply({
        content: `You're at the ${r.cap}-note cap. Use \`/notes\` to review, \`/forget-notes\` to clear.`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({ content: 'Empty note.', flags: MessageFlags.Ephemeral });
    }
    return;
  }
  await interaction.reply({
    content: `Saved. ${r.remaining} slot${r.remaining === 1 ? '' : 's'} remaining.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleListNotes(interaction) {
  const notes = listUserNotes(interaction.user.id);
  if (notes.length === 0) {
    await interaction.reply({
      content: 'No notes saved. Add one with `/remember note:<text>`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const lines = notes.map((n, i) => `${i + 1}. ${n.content}`).join('\n');
  await interaction.reply({
    content: `**Your notes (${notes.length})**\n${lines}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleForgetNotes(interaction) {
  const cleared = clearUserNotes(interaction.user.id);
  await interaction.reply({
    content: cleared > 0 ? `Cleared ${cleared} note(s).` : 'No notes to clear.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleExport(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rows = exportChannel(interaction.channelId);
  if (rows.length === 0) {
    await interaction.editReply('No persisted messages in this channel.');
    return;
  }
  const payload = {
    channel_id: interaction.channelId,
    guild_id: interaction.guildId,
    exported_at: new Date().toISOString(),
    exported_by: interaction.user.id,
    message_count: rows.length,
    messages: rows,
  };
  const buf = Buffer.from(JSON.stringify(payload, null, 2));
  const stamp = new Date().toISOString().slice(0, 10);
  const file = new AttachmentBuilder(buf, { name: `channel-${interaction.channelId}-${stamp}.json` });
  await interaction.editReply({
    content: `Exported ${rows.length} message(s).`,
    files: [file],
  });
}

async function handleAbout(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('Strategic Trading Bot')
    .setColor(0x4a9eff)
    .setDescription(
      'Sonnet 4.6 with tool-use access to live market data, persisted chat memory, and the aigamma-backtester DuckDB shards. Engineered for Options Alchemy.'
    )
    .addFields(
      {
        name: 'Ask',
        value: '`/ask question:<text> model:<sonnet|opus|haiku>` or `@bot <text>`. The model decides which tools to call.',
      },
      {
        name: 'Live data',
        value: '`get_vix_family_latest`, `get_iv_percentile`, `get_gex_levels`, `get_spx_term_structure`, `get_stock_history`, `get_gex_history`, `get_realized_correlations`, `get_vrp_history`',
      },
      {
        name: 'Memory and research',
        value: '`search_chat_history` (semantic recall), `query_duckdb` (multi-year option chains and indicators), web search, web fetch',
      },
      {
        name: 'Commands',
        value: '`/ask`, `/search`, `/forget`, `/summarize`, `/usage`, `/health`, `/about`. React with 👍/👎 on any reply to flag quality.',
      },
      {
        name: 'Style',
        value: 'No fluff. No closing hooks. Final sentence declarative. Numbers always sourced from a tool; no invented values.',
      },
    )
    .setFooter({ text: 'Author: Blue (Eric Allione) · github.com/aigamma · MIT licensed' });

  await interaction.reply({ embeds: [embed] });
}

async function handleAdmin(interaction) {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
    logger.warn('admin command refused', { caller: interaction.user.id });
    return;
  }
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (sub === 'rebuild-embeddings') {
      const r = await rebuildEmbeddings();
      const pgNote = r.pgvector_cleared != null ? ` · wiped ${r.pgvector_cleared} pgvector row(s)` : '';
      await interaction.editReply(`Cleared ${r.cleared} local embedding(s)${pgNote}. ${r.note}`);
    } else if (sub === 'backup') {
      const r = triggerBackup();
      const rotatedNote = r.rotated.length ? ` · rotated ${r.rotated.length} old file(s)` : '';
      await interaction.editReply(`Backup wrote ${r.mb}MB to \`${r.outPath}\` in ${r.elapsedMs}ms${rotatedNote}.`);
    } else if (sub === 'reset-rate-limit') {
      const target = interaction.options.getString('user', true);
      const r = resetUserRateLimit(target);
      await interaction.editReply(r.cleared ? `Cleared rate limit for ${target}.` : `No active bucket for ${target}.`);
    } else if (sub === 'feedback') {
      const hours = interaction.options.getInteger('hours') || 168;
      const r = feedbackReport(hours);
      const header = `**Feedback in last ${hours}h** (${r.count} entries)\n`;
      const budget = 1900 - header.length; // leave headroom under the 2000-char limit
      let body = '';
      let included = 0;
      for (const f of r.rows.slice(0, 15)) {
        const when = new Date(f.created_at).toISOString().slice(0, 16).replace('T', ' ');
        const tag = f.sentiment === 'up' ? '👍' : '👎';
        const snippet = (f.reply_content || '').slice(0, 80).replace(/\n/g, ' ');
        const line = `${tag} ${when} <@${f.user_id}> · ${snippet}\n`;
        if (body.length + line.length > budget) break;
        body += line;
        included++;
      }
      const truncatedNote = included < Math.min(r.rows.length, 15)
        ? `\n_(${r.rows.length - included} more not shown)_`
        : '';
      await interaction.editReply(header + (body || '_(none)_') + truncatedNote);
    }
  } catch (err) {
    logger.error('admin subcommand failed', { sub, err });
    await interaction.editReply(`Admin error: \`${err?.message || err}\``).catch(() => {});
  }
}

async function handleSlashCommand(interaction) {
  switch (interaction.commandName) {
    case 'ask':       return handleAsk(interaction);
    case 'forget':    return handleForget(interaction);
    case 'usage':     return handleUsage(interaction);
    case 'search':    return handleSearch(interaction);
    case 'health':    return handleHealth(interaction);
    case 'summarize': return handleSummarize(interaction);
    case 'admin':     return handleAdmin(interaction);
    case 'about':     return handleAbout(interaction);
    case 'remember':       return handleRemember(interaction);
    case 'notes':          return handleListNotes(interaction);
    case 'forget-notes':   return handleForgetNotes(interaction);
    case 'export':         return handleExport(interaction);
  }
}

async function handleReactionChange(reaction, user, added) {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  const sentiment = FEEDBACK_EMOJI[reaction.emoji.name];
  if (!sentiment) return;
  if (reaction.message.author?.id !== reaction.client.user.id) return;

  const local = findAssistantMessage(reaction.message.id);
  if (!local) return;

  if (added) {
    recordFeedback({
      assistantMessageId: local.id,
      userId: user.id,
      channelId: reaction.message.channelId,
      sentiment,
      emoji: reaction.emoji.name,
    });
    logger.info('feedback recorded', {
      assistant_message_id: local.id,
      user_id: user.id,
      sentiment,
    });
  } else {
    removeFeedback({ assistantMessageId: local.id, userId: user.id });
    logger.info('feedback removed', {
      assistant_message_id: local.id,
      user_id: user.id,
    });
  }
}

async function handleMention(message, clientId) {
  if (message.author.bot) return;
  if (!message.mentions.users.has(clientId)) return;

  const question = stripMention(message.content, clientId);
  if (!question) {
    await message.reply('Ask me something. For example: `@bot what does VVIX:VIX look like right now?`');
    return;
  }

  const rl = checkRateLimit(message.author.id);
  if (!rl.allowed) {
    await message.reply(`Rate limited (${rl.count}/${rl.limit} this minute). Try again in ${rl.retryInSeconds}s.`);
    return;
  }

  const bud = checkBudget(message.author.id);
  if (!bud.allowed) {
    await message.reply(`Daily cost cap of $${bud.cap.toFixed(2)} reached. Resets in ${Math.ceil(bud.reset_in_seconds / 3600)}h.`);
    return;
  }

  await message.channel.sendTyping().catch(() => {});

  // Seed an initial reply so subsequent stream updates can edit it. The
  // placeholder is replaced on the first progress tick.
  const sent = await message.reply('_…_').catch(() => null);
  if (!sent) {
    await message.reply('Something went wrong sending the reply seed.').catch(() => {});
    return;
  }
  const reporter = createProgressReporter({
    editText: (text) => sent.edit(text),
    label: 'mention',
  });

  try {
    const result = await answer({
      channelId: message.channelId,
      guildId: message.guildId,
      userId: message.author.id,
      username: message.author.username,
      discordMessageId: message.id,
      isMultiUser: isMultiUserChannel(message.channel),
      userMessage: question,
      onProgress: (text) => reporter.update(text),
      onToolStart: (names) => reporter.note(`_calling: ${names.join(', ')}_`),
    });
    const text = result.text || '_(no response)_';
    const parts = chunk(text);
    await reporter.finalize(parts[0]);
    if (result.assistantMessageId) {
      attachDiscordMessageId(result.assistantMessageId, sent.id);
    }
    for (let i = 1; i < parts.length; i++) {
      await message.channel.send(parts[i]);
    }
  } catch (err) {
    reporter.cancel();
    logger.error('mention handler failed', { err, user_id: message.author.id });
    await sent.edit(`Something went wrong: \`${err?.message || err}\``).catch(() => {});
  }
}

export function buildClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  client.once(Events.ClientReady, (c) => {
    logger.info('discord ready', {
      bot_tag: c.user.tag,
      bot_id: c.user.id,
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      supabase: config.supabase.enabled,
      voyage: config.voyage.enabled,
      pgvector: pgvectorEnabled(),
      duckdb: duckdbReady(),
      web_search: config.anthropic.webSearchEnabled,
      web_fetch: config.anthropic.webFetchEnabled,
      short_term_turns: config.memory.shortTermTurns,
      short_term_minutes: config.memory.shortTermMinutes,
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleSlashCommand(interaction);
    } catch (err) {
      logger.error('slash command unhandled error', {
        command: interaction.commandName,
        user_id: interaction.user.id,
        err,
      });
      const reply = `Something went wrong: \`${err?.message || err}\``;
      // Try editReply first (covers the case where the handler deferred
      // but failed mid-flight); fall back to reply when no defer happened.
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    await handleMention(message, config.discord.clientId);
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleReactionChange(reaction, user, true).catch((err) =>
      logger.error('reaction add failed', { err })
    );
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    await handleReactionChange(reaction, user, false).catch((err) =>
      logger.error('reaction remove failed', { err })
    );
  });

  return client;
}
