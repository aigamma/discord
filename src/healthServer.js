// Optional HTTP server exposing /healthz for container orchestration probes
// (kubernetes liveness, fly.io health checks, docker compose healthcheck).
// Disabled by default; enable by setting HEALTH_PORT in the env.
//
// /healthz returns 200 OK and a small JSON payload when the process is up
// and the SQLite store is reachable; 503 when SQLite throws on a probe.
// Intentionally cheap — does not call Anthropic, Supabase, or DuckDB. The
// /health slash command remains the surface for deeper subsystem checks.

import { createServer } from 'node:http';
import { logger } from './logger.js';
import { config } from './config.js';
import { db } from './db.js';
import { inFlightCount, isShuttingDown } from './lifecycle.js';

let server = null;

function probeSqlite() {
  try {
    db.prepare('SELECT 1 AS ok').get();
    return true;
  } catch {
    return false;
  }
}

function payload() {
  const mem = process.memoryUsage();
  return {
    status: probeSqlite() ? 'ok' : 'degraded',
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    in_flight: inFlightCount(),
    shutting_down: isShuttingDown(),
    rss_mb: +(mem.rss / 1024 / 1024).toFixed(1),
    model: config.anthropic.model,
  };
}

export function startHealthServer() {
  const port = parseInt(process.env.HEALTH_PORT || '', 10);
  if (!Number.isFinite(port) || port <= 0) {
    logger.info('health http server disabled', { reason: 'HEALTH_PORT not set' });
    return null;
  }

  server = createServer((req, res) => {
    if (req.url !== '/healthz' && req.url !== '/health') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found\n');
      return;
    }
    const body = payload();
    const code = body.status === 'ok' && !body.shutting_down ? 200 : 503;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  server.listen(port, () => {
    logger.info('health http server listening', { port, path: '/healthz' });
  });

  server.on('error', (err) => {
    logger.error('health http server error', { err });
  });

  return server;
}

export function stopHealthServer() {
  if (!server) return;
  return new Promise((resolve) => {
    server.close(() => {
      server = null;
      resolve();
    });
  });
}
