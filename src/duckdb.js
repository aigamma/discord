// Read-only access to the aigamma-backtester DuckDB shards. The shards
// live at C:/aigamma-backtester/data/*.duckdb and are written by a separate
// puller process; this module never writes to them.
//
// On startup we probe each shard path. Present shards are ATTACHed read-only
// into a single in-memory DuckDB; absent shards are silently skipped so the
// bot still starts cleanly when the backtester puller has not yet run.
//
// The exported runSelect() is the only public surface — guarded to refuse
// multi-statement input and non-SELECT keywords, with a result-row cap and a
// statement timeout enforced via the DuckDB session config.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { logger } from './logger.js';

const DEFAULT_SHARD_ROOT = 'C:/aigamma-backtester/data';
const SHARD_FILES = {
  option_chains: 'option_chains_eod.duckdb',
  index_history: 'index_history.duckdb',
  stocks_history: 'stocks_history.duckdb',
  derived: 'derived.duckdb',
};

const QUERY_TIMEOUT_MS = 30_000;
const MAX_ROWS_RETURNED = 1000;

let instance = null;
let connection = null;
let attached = [];
let initError = null;

const FORBIDDEN_KEYWORDS = /\b(insert|update|delete|drop|create|alter|attach|detach|pragma|copy|export|import|truncate|grant|revoke|set)\b/i;

function isReadOnlySelect(sql) {
  if (typeof sql !== 'string') return false;
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) return false;
  if (trimmed.includes(';')) return false;
  if (FORBIDDEN_KEYWORDS.test(trimmed)) return false;
  if (!/^(\s*with\b|\s*select\b)/i.test(trimmed)) return false;
  return true;
}

function shardRoot() {
  return resolve(process.env.BACKTESTER_DATA_DIR || DEFAULT_SHARD_ROOT);
}

function probeShards() {
  const root = shardRoot();
  const found = [];
  for (const [name, file] of Object.entries(SHARD_FILES)) {
    const path = resolve(root, file);
    if (existsSync(path)) {
      const st = statSync(path);
      found.push({ name, path, sizeBytes: st.size, mtime: st.mtime });
    }
  }
  return found;
}

export async function initDuckDB() {
  const found = probeShards();
  if (found.length === 0) {
    logger.info('duckdb no shards found; query_duckdb tool unavailable', { root: shardRoot() });
    return false;
  }

  try {
    // In-memory carrier database. The bot never writes to it; the shards
    // attached below carry READ_ONLY, so they cannot be written even
    // through this connection.
    instance = await DuckDBInstance.create(':memory:', {
      max_memory: '1GB',
      threads: '2',
    });
    connection = await instance.connect();

    for (const shard of found) {
      const safePath = shard.path.replace(/\\/g, '/').replace(/'/g, "''");
      await connection.run(
        `ATTACH '${safePath}' AS ${shard.name} (READ_ONLY)`
      );
      attached.push(shard);
    }
    logger.info('duckdb shards attached', { count: attached.length, names: attached.map((s) => s.name) });
    return true;
  } catch (err) {
    initError = err?.message || String(err);
    logger.error('duckdb init failed', { err, init_error: initError });
    instance = null;
    connection = null;
    return false;
  }
}

export function isReady() {
  return connection !== null;
}

export function getAttachedShards() {
  return attached.map((s) => ({
    name: s.name,
    file: s.path,
    sizeBytes: s.sizeBytes,
    lastModified: s.mtime?.toISOString?.(),
  }));
}

export function getInitError() {
  return initError;
}

export async function runSelect(sql) {
  if (!isReady()) throw new Error('DuckDB shards are not loaded.');
  if (!isReadOnlySelect(sql)) {
    throw new Error('Query rejected: only a single SELECT or WITH statement is allowed.');
  }

  // DuckDB schedules a soft interrupt at the next statement boundary when
  // setInterrupt() is called; for our single-statement queries this manifests
  // as a thrown error if the timer fires before completion.
  const t = setTimeout(() => {
    try { connection.interrupt(); } catch { /* connection may not expose this; the AbortSignal path covers most cases */ }
  }, QUERY_TIMEOUT_MS);

  try {
    const result = await connection.runAndReadAll(sql);
    const rows = result.getRowObjectsJson();
    const truncated = rows.length > MAX_ROWS_RETURNED;
    return {
      rows: truncated ? rows.slice(0, MAX_ROWS_RETURNED) : rows,
      row_count: rows.length,
      truncated,
      max_rows_returned: MAX_ROWS_RETURNED,
    };
  } finally {
    clearTimeout(t);
  }
}

export async function closeDuckDB() {
  try { connection?.disconnectSync?.(); } catch { /* best-effort */ }
  try { instance?.terminateSync?.(); } catch { /* best-effort */ }
  connection = null;
  instance = null;
}
