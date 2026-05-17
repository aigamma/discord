// Supabase pgvector layer for the bot's long-term chat memory. The local
// SQLite store remains source of truth (audit log + restart resilience);
// this module mirrors a subset of the user/assistant rows into pgvector so
// search runs against an HNSW index instead of a JS full-scan.
//
// On any Supabase write error, the embedder swallows it and retries on the
// next tick — local SQLite still has the embedding cached, so we never lose
// a row, only delay the index update.

import { config } from './config.js';

const TIMEOUT_MS = 8000;

function headers() {
  return {
    apikey: config.supabase.key,
    Authorization: `Bearer ${config.supabase.key}`,
    'Content-Type': 'application/json',
  };
}

// pgvector wire format for a vector(N) column is the array literal as text:
// '[0.123,0.456,...]'. JSON arrays are also accepted in modern pgvector but
// the text literal works against every server version.
function vecLiteral(vec) {
  const arr = vec instanceof Float32Array ? Array.from(vec) : vec;
  return '[' + arr.join(',') + ']';
}

export async function upsertChatMemory(rows) {
  if (!config.supabase.enabled || rows.length === 0) return { ok: 0, failed: 0 };
  const payload = rows.map((r) => ({
    local_id: r.local_id,
    channel_id: r.channel_id,
    guild_id: r.guild_id ?? null,
    user_id: r.user_id,
    username: r.username ?? null,
    role: r.role,
    content: r.content,
    reply_local_id: r.reply_local_id ?? null,
    reply_content: r.reply_content ?? null,
    embedding: vecLiteral(r.embedding),
    embedding_model: r.embedding_model || 'voyage-3',
  }));
  const res = await fetch(`${config.supabase.url}/rest/v1/discord_chat_memory?on_conflict=local_id`, {
    method: 'POST',
    headers: {
      ...headers(),
      Prefer: 'return=minimal,resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`discord_chat_memory upsert ${res.status}: ${body.slice(0, 200)}`);
  }
  return { ok: rows.length, failed: 0 };
}

export async function searchChatMemoryRpc({ queryEmbedding, matchCount = 5, similarityFloor = 0.15, channelId = null }) {
  if (!config.supabase.enabled) {
    throw new Error('Supabase not configured');
  }
  const res = await fetch(`${config.supabase.url}/rest/v1/rpc/search_discord_memory`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      query_embedding: vecLiteral(queryEmbedding),
      match_count: matchCount,
      similarity_floor: similarityFloor,
      p_channel_id: channelId,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`search_discord_memory RPC ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Wipes every row owned by this bot from the discord_chat_memory mirror.
// Used by /admin rebuild-embeddings so the resync doesn't end up with
// orphan rows pointing at local_ids that no longer carry embeddings.
// Returns the count of rows reportedly deleted, or null if Supabase is
// unconfigured.
export async function clearAllChatMemory() {
  if (!config.supabase.enabled) return null;
  // PostgREST DELETE with no filter is refused for safety; gte.0 selects
  // every row because local_id is BIGINT non-null and always positive.
  const res = await fetch(
    `${config.supabase.url}/rest/v1/discord_chat_memory?local_id=gte.0`,
    {
      method: 'DELETE',
      headers: { ...headers(), Prefer: 'return=representation' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`discord_chat_memory DELETE ${res.status}: ${body.slice(0, 200)}`);
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : null;
}

export async function checkPgvectorReachable() {
  if (!config.supabase.enabled) return false;
  try {
    const res = await fetch(`${config.supabase.url}/rest/v1/discord_chat_memory?select=id&limit=1`, {
      headers: headers(),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function isEnabled() {
  return config.supabase.enabled;
}
