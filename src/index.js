// Entry point. Validates env via the config side-effect import, runs the
// DuckDB attach phase, builds the Discord client, installs lifecycle
// handlers, logs in. Top-level await is fine on Node 20+.

import { buildClient } from './bot.js';
import { config } from './config.js';
import { startBackgroundEmbedder, stopBackgroundEmbedder } from './embedder.js';
import { initDuckDB, closeDuckDB } from './duckdb.js';
import { installLifecycle } from './lifecycle.js';
import { startHealthServer, stopHealthServer } from './healthServer.js';
import { logger } from './logger.js';

await initDuckDB();
const client = buildClient();
startBackgroundEmbedder();
startHealthServer();

installLifecycle({
  onShutdown: async () => {
    await stopBackgroundEmbedder().catch(() => {});
    await stopHealthServer().catch(() => {});
    await closeDuckDB().catch(() => {});
    await client.destroy().catch(() => {});
  },
});

try {
  await client.login(config.discord.token);
} catch (err) {
  logger.error('discord login failed', { err });
  process.exit(1);
}
