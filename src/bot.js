// Discord client wiring. Two invocation surfaces:
//
//   1. /ask <question>   — slash command. Explicit, surfaces an ephemeral
//      "thinking..." while the model + tools run, edits in the final reply.
//
//   2. @<bot> <question> — mention in any channel the bot can see. Treats
//      the text after the mention as the question. Posts a typing indicator
//      while the model + tools run, then replies in-channel.
//
// Discord's per-message limit is 2000 characters. Replies longer than that
// are split on paragraph boundaries.

import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { answer } from './agent.js';
import { config } from './config.js';

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

async function handleSlashCommand(interaction) {
  if (interaction.commandName !== 'ask') return;
  const question = interaction.options.getString('question', true).trim();
  if (!question) {
    await interaction.reply({ content: 'Empty question.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  try {
    const { text } = await answer(question);
    const parts = chunk(text || '_(no response)_');
    await interaction.editReply(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      await interaction.followUp(parts[i]);
    }
  } catch (err) {
    console.error('slash_command_failed', err);
    await interaction.editReply(`Something went wrong: \`${err?.message || err}\``).catch(() => {});
  }
}

async function handleMention(message, clientId) {
  if (message.author.bot) return;
  if (!message.mentions.users.has(clientId)) return;

  const question = stripMention(message.content, clientId);
  if (!question) {
    await message.reply('Ask me something — e.g. `@bot what does VVIX:VIX look like right now?`');
    return;
  }

  await message.channel.sendTyping().catch(() => {});

  try {
    const { text } = await answer(question);
    const parts = chunk(text || '_(no response)_');
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
