// Discord client wiring. Two invocation surfaces:
//
//   1. /ask <question>   — slash command. Surfaces a deferred reply while
//      the model + tools run, then edits in the final reply.
//
//   2. @<bot> <question> — mention in any channel the bot can see. Treats
//      the text after the mention as the question. Posts a typing indicator
//      while the model + tools run, then replies in-channel.
//
// Each turn carries channel/user context into the agent so short-term
// conversation memory and audit logging work.
//
// Discord's per-message limit is 2000 characters. Replies longer than that
// are split on paragraph boundaries.

import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { answer } from './agent.js';
import { config } from './config.js';
import { clearShortTermContext } from './memory.js';

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

async function handleAsk(interaction) {
  const question = interaction.options.getString('question', true).trim();
  if (!question) {
    await interaction.reply({ content: 'Empty question.', flags: MessageFlags.Ephemeral });
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

async function handleSlashCommand(interaction) {
  if (interaction.commandName === 'ask') return handleAsk(interaction);
  if (interaction.commandName === 'forget') return handleForget(interaction);
}

async function handleMention(message, clientId) {
  if (message.author.bot) return;
  if (!message.mentions.users.has(clientId)) return;

  const question = stripMention(message.content, clientId);
  if (!question) {
    await message.reply('Ask me something. For example: `@bot what does VVIX:VIX look like right now?`');
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
    console.log(`Model: ${config.anthropic.model}`);
    console.log(`Supabase tools: ${config.supabase.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Voyage embeddings: ${config.voyage.enabled ? 'enabled' : 'disabled'}`);
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
