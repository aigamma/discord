# Testing Reference

Single source of truth for the bot's testing posture and conventions.
The test suite is built on `node:test` — no external runner, no test
framework dependency. Run with `npm test` (~3 seconds on a fresh
checkout).

CI runs the full suite plus `node --check` against every source module
on every push and PR. See `.github/workflows/test.yml`.

---

## Posture

The bot is small and the test suite is intentionally small. Coverage is
not the goal — the goal is to **pin contracts** that would otherwise
silently drift:

- The voice constraints in `src/prompt.js` (no preambles, no flattery,
  no em-dashes, declarative endings) — `test/prompt.test.js`.
- The SQL guard in `src/duckdb.js` (single-statement, SELECT/WITH only,
  function-name deny list) — `test/duckdbGuard.test.js`.
- Numeric edge cases that produce wrong-but-plausible answers if
  mishandled (null → 0 coercion in PostgREST rows, NaN propagation in
  Pearson correlation, R-7 vs nearest-neighbor percentile) — every
  `test/<tool>.test.js`.
- The retry predicate (which errors and which HTTP statuses are
  transient) — `test/anthropicRetry.test.js`, `test/supabase.test.js`.
- The prompt-cache breakpoint marker — `test/prompt.test.js`.
- Per-user privacy (a user's notes don't leak to another user's
  prompt; `/whoami` doesn't show another user's spend) —
  `test/userNotes.test.js`, `test/memory.test.js`.

A "good" test pins a contract that would otherwise rot. A trivial
"function exists and returns a number" test rots faster than the
contract.

---

## Running

```
npm test                      # full suite
node --test test/foo.test.js  # one file
node --test --test-name-pattern 'pgvector' # one description
```

`node --test` runs every file matching `test/**/*.test.js`. Tests run
in parallel by file; tests within a file run sequentially by default.

The runner prints a `spec`-format report. Failures show the failing
assertion and the file/line that emitted it.

---

## Conventions

### Top-of-file env stubs

The bot's `config.js` fails fast on missing required env vars. Tests
that import any bot module need stubbed values to satisfy the
validator:

```js
process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
```

The `||=` ensures that a real value from the developer's shell takes
precedence over the stub (so a single-file run with real creds works).

### Per-process tmp SQLite stores

Tests that touch the database should not share `data/conversation.db`
with the real bot. The pattern:

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'bot-feature-test-'));
process.env.CONVERSATION_DB_PATH = join(tmp, 'test.db');
test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows file locks */ }
});

const { ... } = await import('../src/memory.js');
```

The `CONVERSATION_DB_PATH` override must happen **before** importing
any module that imports `db.js`. The dynamic `await import(...)` after
the env tweak forces evaluation order.

### Dynamic imports inside tests

For modules that depend on `db.js` (which opens the SQLite file at
import time), use dynamic `import()` inside the test file after the
env is set, not static `import` at the top.

### No live API calls

Tests must not call Anthropic, Supabase, Voyage, or the Discord API.
The few tests that exercise transport layers (`supabase.test.js`,
`anthropicRetry.test.js`) mock the predicate with a fake error object
or a stubbed `fetch`. The signal lives in the predicate (`is this
error transient?`), not in the round-trip.

If you need to test against a real service, write it as an
integration script in `scripts/` and gate it behind an env var so it
doesn't run in CI.

### Assertions

Use `node:assert/strict` (imported as `strict`). Avoid loose
equality; the bot has had silent bugs where `null == undefined` and
`Number(null) === 0` masked errors.

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
```

### Test naming

The `test(name, fn)` description is the spec line in CI output. Make
it actionable:

- Bad: `'works'`, `'empty case'`.
- Good: `'memory: persist + read short-term context preserves chronological order'`.

The prefix (`memory:`, `prompt:`, `pricing:`) acts as a namespace —
useful when grepping CI output.

---

## When to write a test

| Change | Test required? | Notes |
|---|---|---|
| New tool in `src/tools/` | Yes | One per happy path + one per documented null/error edge. See `test/vixFamily.test.js` for the shape. |
| New slash command | If it has non-trivial logic | A command that only renders a static embed (`/help`) doesn't need a test. A command that queries SQLite (`/whoami`, `/stats`) needs a memory-layer test like `test/memory.test.js`. |
| New env var in `config.js` | Yes | Cover the `safeInt` / `safeFloat` validation path: out-of-range value falls back to the default and logs a warn. |
| New SQLite migration | Yes | Persist a fixture row that exercises the new column / index / constraint and read it back. |
| New pgvector migration | Manual verification | The bot doesn't unit-test against a live Supabase. Document the verification step in the PR. |
| New retry predicate branch | Yes | Pin the actual predicate via the exported `isTransient*` helpers — see `test/supabase.test.js`. |
| Voice / prompt change | Yes | `test/prompt.test.js` must still pass; if you intentionally relax a constraint, update the assertion in lockstep. |
| Performance optimization | Optional | Only if the optimization has a behavioral effect (e.g. result ordering, null handling). Pure speedups don't need tests. |
| Bug fix | Yes | Add a regression test that fails before the fix and passes after. |

---

## What the suite already covers

| File | Pins |
|---|---|
| `anthropicRetry.test.js` | The retry predicate (HTTP 408/429/5xx + socket errors), backoff timing, request-timeout signal threading. |
| `backup.test.js` | `VACUUM INTO` produces a self-contained file; rotation keeps the N most recent. |
| `budget.test.js` | Daily cap math against the audit log; `DAILY_USER_COST_CAP_USD=0` disables the check. |
| `duckdbGuard.test.js` | `isReadOnlySelect` — the keyword blocklist, the function-name deny list, the SELECT/WITH-only check, multi-statement rejection. |
| `embeddings.test.js` | `Float32 ↔ Buffer` roundtrip; cosine on hand-crafted vectors. |
| `gexHistory.test.js`, `gexLevels.test.js`, `ivPercentile.test.js`, `realizedCorrelations.test.js`, `stockHistory.test.js`, `termStructure.test.js`, `vixFamily.test.js`, `vrpHistory.test.js` | Per-tool happy paths plus the documented null / NaN / out-of-range edges. |
| `lifecycle.test.js` | `beginWork()` idempotency, drain semantics, signal handling. |
| `logger.test.js` | Error-instance flattening at every level, level threshold, format auto-detection. |
| `memory.test.js` | Short-term context ordering, multi-user prefix, feedback idempotency, `usageSummary` aggregation + percentile, `userActivitySummary` / `channelStats` privacy isolation. |
| `pricing.test.js` | Per-model token math, server-tool `web_search` per-request pricing, `isModelPriced` predicate. |
| `progressReporter.test.js` | Debounce timing, the `inFlight` serialization that prevents concurrent edits. |
| `prompt.test.js` | Every voice constraint in `BEHAVIORAL_CONSTRAINTS`; the cache breakpoint marker; the holiday-calendar branches. |
| `rateLimiter.test.js` | Sliding-window math, per-user isolation. |
| `searchChatHistory.test.js` | Backend selection, similarity-floor filtering, channel/guild filter pushdown. |
| `supabase.test.js` | `isTransientError` / `isTransientStatus` predicates, single-retry behavior on 503 + ECONNRESET. |
| `textChunks.test.js` | `chunk()` break priority (blank line → newline → space → hard cut), `formatUsd()` null/NaN/Infinity safety. |
| `toolCache.test.js` | Key canonicalization, TTL expiry, FIFO eviction at 256 entries, hit/miss accounting. |
| `userNotes.test.js` | Cap enforcement (12 notes × 280 chars), user isolation (a user can't delete another's note). |

---

## Static check

`.github/workflows/test.yml` runs `node --check` against every
`src/**/*.js` file before the test suite. The static check catches:

- Syntax errors (the test suite can't load a broken file).
- Invalid ESM imports (`import { foo } from './bar.js'` where `bar.js`
  doesn't export `foo`).

If `node --check` fails locally, it fails in CI too. Run it directly to
debug:

```
node --check src/agent.js
```

---

## What to do when a test fails in CI but passes locally

The most common cause is path or platform difference. Check:

- Hard-coded paths that assume `C:/` (the Windows-default
  `BACKTESTER_DATA_DIR`) vs `/var/...`.
- Timing-sensitive tests that rely on `setTimeout(fn, 1)` resolving
  in a specific order. CI runners are slower; bump the wait or use
  a deterministic mechanism.
- Tests that depend on test ordering (other tests' side effects
  leaking through the SQLite store). Each test should use a fresh
  `channelId` or `userId` so they don't collide.

If CI keeps flaking on the same test: the test is non-deterministic
and needs to be hardened. Don't `--reruns` it.
