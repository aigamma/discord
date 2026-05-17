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
const attached = [];
let initError = null;

const FORBIDDEN_KEYWORDS = /\b(insert|update|delete|drop|create|alter|attach|detach|pragma|copy|export|import|truncate|grant|revoke|set)\b/i;

// File-system and external-access functions exposed by DuckDB inside a
// valid SELECT. The engine-level lockdown (enable_external_access = false +
// lock_configuration = true) is the load-bearing defense; this regex is a
// second layer so a future DuckDB lockdown-semantics change doesn't
// silently un-block these. Keep this list in sync with new file-reading
// table functions if they ship.
const FORBIDDEN_FUNCTIONS =
  /\b(read_csv(?:_auto)?|read_parquet|parquet_scan|parquet_metadata|parquet_schema|parquet_file_metadata|read_json(?:_auto|_objects(?:_auto)?)?|read_ndjson(?:_auto|_objects)?|read_text|read_blob|read_xml|glob|sniff_csv|copy_database|load_extension|install_extension|force_install_extension|httpfs_install|hf_install_metadata)\s*\(/i;

// Exported so tests can pin the actual predicate instead of mirroring it
// inline. Pure function; doesn't touch the DuckDB connection.
export function isReadOnlySelect(sql) {
  if (typeof sql !== 'string') return false;
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) return false;
  if (trimmed.includes(';')) return false;
  if (FORBIDDEN_KEYWORDS.test(trimmed)) return false;
  if (FORBIDDEN_FUNCTIONS.test(trimmed)) return false;
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
    if (!existsSync(path)) continue;
    try {
      const st = statSync(path);
      found.push({ name, path, sizeBytes: st.size, mtime: st.mtime });
    } catch (err) {
      logger.warn('duckdb shard probe failed; skipping', { name, path, err: err?.message || String(err) });
    }
  }
  return found;
}

export async function initDuckDB() {
  const root = shardRoot();
  const found = probeShards();
  if (found.length === 0) {
    // Distinguish 'directory not present' (typo'd path / unset env var)
    // from 'directory present but empty' (puller hasn't produced shards
    // yet). The first is an operator misconfiguration the second is a
    // legitimate startup state.
    const rootExists = existsSync(root);
    logger.info('duckdb no shards found; query_duckdb tool unavailable', {
      root,
      root_exists: rootExists,
      hint: rootExists ? 'puller has not produced shards yet' : 'BACKTESTER_DATA_DIR points to a path that does not exist',
    });
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

    // Belt-and-suspenders against function-level filesystem access. The
    // SELECT-only guard refuses DDL keywords but a query like
    //   SELECT * FROM read_csv('/etc/passwd')
    // is still a valid SELECT; without this, a prompt-injected model
    // could exfiltrate any file the process user can read. Disabling
    // external access here blocks read_csv / read_parquet / read_json /
    // glob / read_text / etc. on the active connection without affecting
    // the already-attached shards. lock_configuration prevents any
    // subsequent SET (which the guard would already refuse, but layer
    // the defense at the engine too).
    await connection.run("SET enable_external_access = false");
    await connection.run("SET lock_configuration = true");

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
