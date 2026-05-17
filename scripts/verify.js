// Verify external service connectivity at setup time. Run after editing
// .env.local to catch credential errors before users hit them via /ask.
//
//   npm run verify
//
// Each check runs independently and reports status + a brief detail line.
// Exit code 0 if all configured services pass; 1 if any required check
// fails. Optional services (Voyage, Supabase) are skipped quietly when
// not configured.

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';

const { config } = await import('../src/config.js');

const results = [];
function record(name, ok, detail) {
  const symbol = ok ? '✓' : '✗';
  results.push({ name, ok, detail });
  console.log(`  ${symbol} ${name.padEnd(20)} ${detail}`);
}

console.log('\nVerifying external services...\n');

// Anthropic — tiny ping with max_tokens=8 keeps the spend at ~0.0001 USD
console.log('Anthropic API');
try {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const t0 = Date.now();
  const r = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'ping' }],
  });
  const ms = Date.now() - t0;
  record('Anthropic', true, `${config.anthropic.model} responded in ${ms}ms (${r.usage.input_tokens}→${r.usage.output_tokens} tokens)`);
} catch (err) {
  record('Anthropic', false, err?.message || String(err));
}

// Supabase — single-row read against ingest_runs if available, else a tiny
// no-op SELECT.
if (config.supabase.enabled) {
  console.log('\nSupabase REST');
  try {
    const t0 = Date.now();
    const res = await fetch(`${config.supabase.url}/rest/v1/?select=1`, {
      headers: {
        apikey: config.supabase.key,
        Authorization: `Bearer ${config.supabase.key}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    const ms = Date.now() - t0;
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    record('Supabase REST', true, `reachable in ${ms}ms (HTTP ${res.status})`);
  } catch (err) {
    record('Supabase REST', false, err?.message || String(err));
  }

  console.log('\nSupabase pgvector');
  try {
    const { checkPgvectorReachable } = await import('../src/pgvector.js');
    const reachable = await checkPgvectorReachable();
    record('Supabase pgvector', reachable, reachable ? 'discord_chat_memory table reachable' : 'table not reachable (run migrations/discord_chat_memory_001.sql)');
  } catch (err) {
    record('Supabase pgvector', false, err?.message || String(err));
  }
} else {
  console.log('\nSupabase: skipped (SUPABASE_URL not set)');
}

// Voyage — embed a one-character string. Cheap.
if (config.voyage.enabled) {
  console.log('\nVoyage embeddings');
  try {
    const { embed } = await import('../src/embeddings.js');
    const t0 = Date.now();
    const [vec] = await embed(['ping'], { inputType: 'document' });
    const ms = Date.now() - t0;
    record('Voyage', true, `${config.voyage.model} returned ${vec.length}-dim vector in ${ms}ms`);
  } catch (err) {
    record('Voyage', false, err?.message || String(err));
  }
} else {
  console.log('\nVoyage: skipped (VOYAGE_API_KEY not set)');
}

// DuckDB — check if any shards exist.
console.log('\nDuckDB shards');
try {
  const { initDuckDB, isReady, getAttachedShards, closeDuckDB } = await import('../src/duckdb.js');
  await initDuckDB();
  if (isReady()) {
    const shards = getAttachedShards();
    record('DuckDB', true, `${shards.length} shard(s) attached: ${shards.map((s) => s.name).join(', ')}`);
  } else {
    record('DuckDB', true, 'no shards found (optional; query_duckdb tool will be unavailable)');
  }
  await closeDuckDB();
} catch (err) {
  record('DuckDB', false, err?.message || String(err));
}

const failures = results.filter((r) => !r.ok);
console.log('');
if (failures.length === 0) {
  console.log(`All ${results.length} check(s) passed.`);
  process.exit(0);
} else {
  console.log(`${failures.length} check(s) failed: ${failures.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
