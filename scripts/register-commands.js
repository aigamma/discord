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
    .addStringOption((opt) =>
      opt
        .setName('model')
        .setDescription('Override the model for this turn (else uses your /model preference or the server default)')
        .addChoices(
          { name: 'Sonnet 4.6 (fast)', value: 'sonnet' },
          { name: 'Opus 4.7 (deeper reasoning, 5x cost)', value: 'opus' },
          { name: 'Haiku 4.5 (fastest, cheapest)', value: 'haiku' }
        )
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
          { name: 'every channel in this server', value: 'all' }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName('limit')
        .setDescription('How many hits to return (default 5, max 15)')
        .setMinValue(1)
        .setMaxValue(15)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('health')
    .setDescription('Show bot health: DB, embedder queue, pgvector reachability, attached shards')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('summarize')
    .setDescription("Brief of this channel's recent conversation")
    .addIntegerOption((opt) =>
      opt
        .setName('messages')
        .setDescription('How many recent messages to summarize (default 100)')
        .setMinValue(10)
        .setMaxValue(500)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('about')
    .setDescription('What this bot can do')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Compact reference for every bot command (ephemeral)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('whoami')
    .setDescription('Your activity, spend, feedback given, and saved notes (ephemeral)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription("Channel-level usage snapshot: turns, askers, top tools")
    .addIntegerOption((opt) =>
      opt
        .setName('hours')
        .setDescription('Lookback window in hours (default 168 = 7 days)')
        .setMinValue(1)
        .setMaxValue(8760)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Set or clear your default model for /ask and @mention (ephemeral)')
    .addSubcommand((s) =>
      s.setName('show').setDescription('Show your current saved preference')
    )
    .addSubcommand((s) =>
      s.setName('set')
        .setDescription('Save a preferred model for every future /ask and @mention')
        .addStringOption((opt) =>
          opt
            .setName('choice')
            .setDescription('Which model to use as your default')
            .setRequired(true)
            .addChoices(
              { name: 'Sonnet 4.6 (default, fast)', value: 'sonnet' },
              { name: 'Opus 4.7 (deeper reasoning, 5x cost)', value: 'opus' },
              { name: 'Haiku 4.5 (fastest, cheapest)', value: 'haiku' }
            )
        )
    )
    .addSubcommand((s) =>
      s.setName('clear').setDescription('Remove your saved preference; revert to the server default')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('remember')
    .setDescription('Save a persistent note about yourself (the bot will use it on every future turn)')
    .addStringOption((opt) =>
      opt.setName('note').setDescription('What to remember (max 280 chars)').setRequired(true).setMaxLength(280)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('notes')
    .setDescription('Show the notes the bot has saved about you (ephemeral)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('forget-notes')
    .setDescription('Clear all your saved notes')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('forget-note')
    .setDescription('Remove a single saved note by its number (from /notes)')
    .addIntegerOption((opt) =>
      opt.setName('number').setDescription('The note number to remove, as shown in /notes (1, 2, …)').setRequired(true).setMinValue(1).setMaxValue(12)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Download this channel\'s persisted Q&A as JSON')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Operator-only utilities (owner gated)')
    .addSubcommand((s) =>
      s.setName('rebuild-embeddings').setDescription('Clear and re-embed every user message via Voyage')
    )
    .addSubcommand((s) =>
      s.setName('backup').setDescription('Snapshot the SQLite store via VACUUM INTO')
    )
    .addSubcommand((s) =>
      s.setName('reset-rate-limit')
        .setDescription("Clear a user's in-memory rate-limit bucket")
        .addUserOption((opt) =>
          opt.setName('user').setDescription('User to reset').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName('feedback')
        .setDescription('Show recent thumbs-up / thumbs-down feedback')
        .addIntegerOption((opt) =>
          opt.setName('hours').setDescription('Lookback window (default 168 = one week)').setMinValue(1).setMaxValue(8760)
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
