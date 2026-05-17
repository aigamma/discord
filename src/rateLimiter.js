// In-process per-user sliding-window rate limit. Single-process bot so an
// in-memory Map is sufficient; if the bot ever scales horizontally, swap
// the backing store for SQLite or Redis without changing the call sites.
//
// Defaults: 10 requests per 60s per user globally across channels. Tuned
// for a small private community where humans rarely exceed 1-2 questions
// per minute — well under the threshold — and where the floor protects
// against a runaway script or accidental loop.

const REQUESTS_PER_WINDOW = parseInt(process.env.RATE_LIMIT_REQUESTS_PER_MINUTE || '10', 10);
const WINDOW_MS = 60_000;

const buckets = new Map(); // userId -> [timestamp, timestamp, ...]

export function check(userId) {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  let bucket = buckets.get(userId);
  if (!bucket) {
    bucket = [];
    buckets.set(userId, bucket);
  }
  while (bucket.length && bucket[0] < cutoff) bucket.shift();
  if (bucket.length >= REQUESTS_PER_WINDOW) {
    const retryMs = WINDOW_MS - (now - bucket[0]);
    return { allowed: false, retryInSeconds: Math.ceil(retryMs / 1000), count: bucket.length, limit: REQUESTS_PER_WINDOW };
  }
  bucket.push(now);
  return { allowed: true, count: bucket.length, limit: REQUESTS_PER_WINDOW };
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, bucket] of buckets) {
    while (bucket.length && bucket[0] < cutoff) bucket.shift();
    if (bucket.length === 0) buckets.delete(k);
  }
}, WINDOW_MS).unref();

export function reset(userId) {
  if (buckets.has(userId)) {
    buckets.delete(userId);
    return true;
  }
  return false;
}
