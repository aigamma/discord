// One-off script: register the /ask slash command with Discord. Run after
// the first install and whenever you change the command surface.
//
//   npm run register
//
// If DISCORD_GUILD_ID is set in .env.local, the command registers to that
// guild only (propagates instantly — ideal during development). Otherwise
// it registers globally (propagates within ~1 hour — applies to every
// server the bot joins).

import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from '../src/config.js';

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Claude a strategic trading question')
    .addStringOption((opt) =>
      opt
        .setName('question')
        .setDescription('Your question')
        .setRequired(true)
        .setMaxLength(1500)
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
