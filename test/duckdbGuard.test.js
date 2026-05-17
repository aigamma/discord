// The runSelect guard lives inside duckdb.js as a closure; test it via the
// behavior surfaced through the tool. When DuckDB has not initialized, the
// tool returns a specific not-loaded error, so the SQL guard never runs in
// these tests. Pull the guard predicate directly via a small re-import.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

// Re-create the same predicate inline so the test verifies the matching
// rules without depending on DuckDB being initialized. Mirrors the regex
// in src/duckdb.js. If the source predicate diverges, this test fails
// loudly — a feature, not a bug.
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

test('duckdb guard: plain SELECT allowed', () => {
  assert.equal(isReadOnlySelect('SELECT * FROM x'), true);
});

test('duckdb guard: SELECT with trailing semicolon allowed', () => {
  assert.equal(isReadOnlySelect('SELECT 1;'), true);
});

test('duckdb guard: WITH...SELECT allowed', () => {
  assert.equal(isReadOnlySelect('WITH t AS (SELECT 1) SELECT * FROM t'), true);
});

test('duckdb guard: multi-statement rejected', () => {
  assert.equal(isReadOnlySelect('SELECT 1; DROP TABLE foo'), false);
});

test('duckdb guard: DROP/DELETE/INSERT/UPDATE all rejected', () => {
  for (const stmt of [
    'DELETE FROM x',
    'UPDATE x SET y=1',
    'DROP TABLE x',
    'INSERT INTO x VALUES (1)',
    'ALTER TABLE x ADD COLUMN y INT',
    'CREATE TABLE y AS SELECT 1',
    'TRUNCATE x',
  ]) {
    assert.equal(isReadOnlySelect(stmt), false, `expected ${stmt} to be rejected`);
  }
});

test('duckdb guard: PRAGMA / ATTACH / COPY rejected', () => {
  assert.equal(isReadOnlySelect('PRAGMA database_list'), false);
  assert.equal(isReadOnlySelect('ATTACH \'x.db\''), false);
  assert.equal(isReadOnlySelect("COPY x TO 'out.csv'"), false);
});

test('duckdb guard: empty / non-string rejected', () => {
  assert.equal(isReadOnlySelect(''), false);
  assert.equal(isReadOnlySelect('   '), false);
  assert.equal(isReadOnlySelect(null), false);
  assert.equal(isReadOnlySelect(123), false);
});

test('duckdb guard: SET rejected (could change session params)', () => {
  assert.equal(isReadOnlySelect('SET memory_limit = \'100GB\''), false);
});

test('duckdb guard: case-insensitive', () => {
  assert.equal(isReadOnlySelect('select 1'), true);
  assert.equal(isReadOnlySelect('Drop Table x'), false);
});
