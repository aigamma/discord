// One-off script: register the bot's slash commands with Discord. Run after
// install and whenever the command surface changes.
//
//   npm run register

import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from '../src/config.js';

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Claude a strategic trading question')
    .addStringOption((opt) =>
      opt.setName('question').setDescription('Your question').setRequired(true).setMaxLength(1500)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('forget')
    .setDescription("Clear this channel's short-term conversation context window")
    .toJSON(),
  new SlashCommandBuilder()
    .setName('usage')
    .setDescription('Show recent token + cost summary (ephemeral)')
    .addIntegerOption((opt) =>
      opt.setName('hours').setDescription('Lookback window in hours (default 24)').setMinValue(1).setMaxValue(720)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search prior conversations by meaning')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('What are you looking for?').setRequired(true).setMaxLength(500)
    )
    .addStringOption((opt) =>
      opt
        .setName('scope')
        .setDescription('Which conversations to search')
        .addChoices(
          { name: 'this channel only', value: 'channel' },
          { name: 'every channel', value: 'all' }
        )
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(config.discord.token);

try {
  if (config.discord.guildId) {
    console.log(`Registering ${commands.length} command(s) to guild ${config.discord.guildId}...`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
      { body: commands }
    );
    console.log('Done — guild commands available immediately.');
  } else {
    console.log(`Registering ${commands.length} command(s) globally...`);
    await rest.put(Routes.applicationCommands(config.discord.clientId), { body: commands });
    console.log('Done — global commands propagate within ~1 hour.');
  }
} catch (err) {
  console.error('Registration failed:', err?.message || err);
  process.exit(1);
}
