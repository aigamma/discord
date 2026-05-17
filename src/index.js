// Entry point. Validates env via the config side-effect import, runs the
// DuckDB attach phase, builds the Discord client, installs lifecycle
// handlers, logs in. Top-level await is fine on Node 20+.

import { buildClient } from './bot.js';
import { config } from './config.js';
import { startBackgroundEmbedder, stopBackgroundEmbedder } from './embedder.js';
import { initDuckDB, closeDuckDB } from './duckdb.js';
import { installLifecycle } from './lifecycle.js';
import { startHealthServer, stopHealthServer } from './healthServer.js';
import { isModelPriced } from './pricing.js';
import { logger } from './logger.js';

// Warn if the configured model is unknown to pricing.js. Without an
// entry in PRICING, every turn's cost_usd records as null, the daily
// budget cap never triggers, and /usage shows $0 cost forever — a
// silent failure that hides accumulating spend.
if (!isModelPriced(config.anthropic.model)) {
  logger.warn('configured Anthropic model has no entry in pricing.js; cost tracking disabled until updated', {
    model: config.anthropic.model,
  });
}

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
