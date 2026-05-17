// Process lifecycle: track in-flight work so SIGINT/SIGTERM can drain
// gracefully instead of cutting a model turn mid-stream. Also installs
// uncaught-exception and unhandled-rejection handlers that log and exit
// rather than crashing silently.

import { logger } from './logger.js';

const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
const SHUTDOWN_HARD_TIMEOUT_MS = 45_000;

let inFlight = 0;
let shuttingDown = false;
const onDrainCallbacks = [];

export function isShuttingDown() {
  return shuttingDown;
}

export function inFlightCount() {
  return inFlight;
}

export function beginWork() {
  inFlight++;
  return () => {
    inFlight--;
    if (inFlight === 0 && shuttingDown) {
      for (const cb of onDrainCallbacks.splice(0)) cb();
    }
  };
}

function waitForDrain(timeoutMs) {
  if (inFlight === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('shutdown drain timed out', { in_flight: inFlight, timeout_ms: timeoutMs });
      resolve(false);
    }, timeoutMs);
    onDrainCallbacks.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function installLifecycle({ onShutdown }) {
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
    process.exit(1);
  });

  let signalCount = 0;
  const handle = async (signal) => {
    signalCount++;
    if (signalCount > 1) {
      logger.warn('second signal received, exiting immediately', { signal });
      process.exit(1);
    }
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown initiated', { signal, in_flight: inFlight });

    const hardTimer = setTimeout(() => {
      logger.error('hard shutdown timeout exceeded, force exit', { in_flight: inFlight });
      process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS).unref();

    try {
      await waitForDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
      await onShutdown();
      clearTimeout(hardTimer);
      logger.info('clean exit');
      process.exit(0);
    } catch (err) {
      logger.error('shutdown error', { err });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => handle('SIGINT'));
  process.on('SIGTERM', () => handle('SIGTERM'));
}
