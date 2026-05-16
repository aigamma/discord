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
import { clearShortTermContext, usageSummary } from './memory.js';
import { execute as searchHistory } from './tools/searchChatHistory.js';
import { check as checkRateLimit } from './rateLimiter.js';

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
    console.error('ask_command_failed', err);
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

async function handleSlashCommand(interaction) {
  switch (interaction.commandName) {
    case 'ask':    return handleAsk(interaction);
    case 'forget': return handleForget(interaction);
    case 'usage':  return handleUsage(interaction);
    case 'search': return handleSearch(interaction);
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
    console.error('mention_handler_failed', err);
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
    console.log(`Logged in as ${c.user.tag} (id ${c.user.id})`);
    console.log(`Model: ${config.anthropic.model} (max ${config.anthropic.maxTokens} tokens/turn)`);
    console.log(`Supabase tools: ${config.supabase.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Voyage embeddings: ${config.voyage.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Web search: ${config.anthropic.webSearchEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Web fetch: ${config.anthropic.webFetchEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Short-term context: last ${config.memory.shortTermTurns} turns within ${config.memory.shortTermMinutes}m`);
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
