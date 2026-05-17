// In-process LRU+TTL cache for tool results. Keys are deterministic by
// (toolName, canonicalized input). Inputs are JSON-stringified with sorted
// object keys so order does not produce cache misses.
//
// Each tool spec can declare cache_ttl_seconds to override the default 60s;
// 0 disables caching for that tool. Live-data tools like get_gex_levels can
// safely cache for ~30s during market hours since the underlying ingest
// only refreshes every 5 minutes. Historical tools (get_vrp_history,
// get_realized_correlations) can cache for several minutes.
//
// Cache size is capped via a simple FIFO eviction; small bot, small window,
// no point in an O(log n) LRU implementation.

const DEFAULT_TTL_MS = 60_000;
const MAX_ENTRIES = 256;

const store = new Map();
let hits = 0;
let misses = 0;
let evictions = 0;

function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function keyFor(toolName, input) {
  return toolName + '|' + canonicalize(input || {});
}

export function get(toolName, input) {
  const k = keyFor(toolName, input);
  const entry = store.get(k);
  if (!entry) { misses++; return null; }
  if (entry.expires_at < Date.now()) {
    store.delete(k);
    misses++;
    return null;
  }
  hits++;
  return entry.value;
}

export function set(toolName, input, value, ttlSeconds) {
  if (ttlSeconds === 0) return; // explicit no-cache
  const ttl = Math.max((ttlSeconds || DEFAULT_TTL_MS / 1000), 1) * 1000;
  if (store.size >= MAX_ENTRIES) {
    // FIFO eviction — drop the oldest insertion order entry.
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
    evictions++;
  }
  store.set(keyFor(toolName, input), {
    value,
    expires_at: Date.now() + ttl,
  });
}

export function stats() {
  return {
    entries: store.size,
    hits,
    misses,
    evictions,
    hit_rate: hits + misses > 0 ? +(hits / (hits + misses)).toFixed(3) : 0,
  };
}

export function clear() {
  store.clear();
  hits = 0;
  misses = 0;
  evictions = 0;
}
