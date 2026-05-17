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

import { ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { answer } from './agent.js';
import { config } from './config.js';
import { clearShortTermContext, totalMessageCount, usageSummary } from './memory.js';
import { execute as searchHistory } from './tools/searchChatHistory.js';
import { check as checkRateLimit } from './rateLimiter.js';
import { isReady as duckdbReady, getAttachedShards } from './duckdb.js';
import { getEmbedderStats } from './embedder.js';
import { checkPgvectorReachable, isEnabled as pgvectorEnabled } from './pgvector.js';
import { logger } from './logger.js';

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

  await interaction.deferReply();
  try {
    const result = await answer({
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      username: interaction.user.username,
      isMultiUser: isMultiUserChannel(interaction.channel),
      userMessage: question,
    });
    const text = result.text || '_(no response)_';
    const parts = chunk(text);
    await interaction.editReply(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      await interaction.followUp(parts[i]);
    }
  } catch (err) {
    logger.error('ask command failed', { err, user_id: interaction.user.id });
    await interaction.editReply(`Something went wrong: \`${err?.message || err}\``).catch(() => {});
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
    );

  if (data.by_model.length) {
    embed.addFields({
      name: 'By model',
      value: data.by_model.map((m) => `\`${m.model}\` — ${m.turns} turns, ${formatUsd(m.cost_usd)}`).join('\n'),
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
    embed.addFields({
      name: `${h.asked_by} · ${when} · sim ${h.similarity}`,
      value: [
        `> ${h.question.slice(0, 200)}`,
        h.reply ? h.reply.slice(0, 600) : '_(no reply persisted)_',
      ].join('\n'),
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

  await interaction.editReply({ embeds: [embed] });
}

async function handleSlashCommand(interaction) {
  switch (interaction.commandName) {
    case 'ask':    return handleAsk(interaction);
    case 'forget': return handleForget(interaction);
    case 'usage':  return handleUsage(interaction);
    case 'search': return handleSearch(interaction);
    case 'health': return handleHealth(interaction);
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

  await message.channel.sendTyping().catch(() => {});

  try {
    const result = await answer({
      channelId: message.channelId,
      guildId: message.guildId,
      userId: message.author.id,
      username: message.author.username,
      discordMessageId: message.id,
      isMultiUser: isMultiUserChannel(message.channel),
      userMessage: question,
    });
    const text = result.text || '_(no response)_';
    const parts = chunk(text);
    await message.reply(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      await message.channel.send(parts[i]);
    }
  } catch (err) {
    logger.error('mention handler failed', { err, user_id: message.author.id });
    await message.reply(`Something went wrong: \`${err?.message || err}\``).catch(() => {});
  }
}

export function buildClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
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
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    await handleMention(message, config.discord.clientId);
  });

  return client;
}
