// Entry point. Validates env via the config side-effect import, builds the
// Discord client, logs in. Top-level await is fine on Node 20+.

import { buildClient } from './bot.js';
import { config } from './config.js';
import { startBackgroundEmbedder, stopBackgroundEmbedder } from './embedder.js';

const client = buildClient();
startBackgroundEmbedder();

function shutdown() {
  console.log('\nShutting down...');
  stopBackgroundEmbedder();
  client.destroy().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await client.login(config.discord.token);
} catch (err) {
  console.error('Discord login failed:', err?.message || err);
  process.exit(1);
}
