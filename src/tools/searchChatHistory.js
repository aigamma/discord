// Semantic search across persisted chat history. Two backends, transparent
// failover: pgvector HNSW via Supabase RPC (production path, scales),
// SQLite full-scan cosine (fallback when Supabase is unreachable).
//
// The tool itself looks identical to the model in either mode. Operators
// running a local-only deployment without Supabase still get search via the
// SQLite path; the production deployment gets HNSW.

import { embed, blobToVec, cosineSimilarity, isEnabled as voyageEnabled } from '../embeddings.js';
import { iterEmbeddedUserMessages, getAssistantResponseFor } from '../memory.js';
import { searchChatMemoryRpc, isEnabled as pgvectorEnabled } from '../pgvector.js';
import { config } from '../config.js';

export const spec = {
  name: 'search_chat_history',
  description:
    "Search the persisted history of this Discord's prior conversations by meaning, not keywords. Returns the top-K most semantically similar past user questions along with the assistant's reply to each, including the timestamp and the channel they came from. Use this when a current question references something the channel discussed earlier (this morning, last week, last month), when you sense the user is following up on a previous thread, or when the same topic was likely covered before and a fresh answer would be redundant. Do not use this for live market data; the data tools cover that.",
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A short search query in natural language. Phrase it the way a user would have asked the question originally.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of past conversations to return. Defaults to 5. Hard cap of 15.',
        default: 5,
      },
      channel_id: {
        type: 'string',
        description: 'Optional Discord channel ID. If set, only past conversations from this channel are considered.',
      },
    },
    required: ['query'],
  },
};

async function searchPgvector(queryVec, k, minSim, channelId) {
  const rows = await searchChatMemoryRpc({
    queryEmbedding: queryVec,
    matchCount: k,
    similarityFloor: minSim,
    channelId,
  });
  return rows.map((r) => ({
    similarity: +Number(r.similarity).toFixed(3),
    asked_by: r.username || r.user_id,
    asked_at: r.created_at,
    channel_id: r.channel_id,
    question: r.content,
    reply: r.reply_content || null,
  }));
}

function searchSqliteFallback(queryVec, k, minSim, channelId) {
  const heap = [];
  let scanned = 0;
  for (const row of iterEmbeddedUserMessages()) {
    if (channelId && row.channel_id !== channelId) continue;
    scanned++;
    const vec = blobToVec(row.embedding);
    const sim = cosineSimilarity(queryVec, vec);
    if (sim < minSim) continue;
    heap.push({ sim, row });
  }
  heap.sort((a, b) => b.sim - a.sim);
  const top = heap.slice(0, k);
  return {
    hits: top.map(({ sim, row }) => {
      const reply = getAssistantResponseFor(row.id);
      return {
        similarity: +sim.toFixed(3),
        asked_by: row.username || row.user_id,
        asked_at: new Date(row.created_at).toISOString(),
        channel_id: row.channel_id,
        question: row.content,
        reply: reply?.content || null,
      };
    }),
    scanned,
  };
}

export async function execute({ query, limit = 5, channel_id = null } = {}) {
  if (!voyageEnabled()) {
    return { error: 'Semantic search is not configured (Voyage embeddings disabled).' };
  }
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { error: 'Empty query.' };
  }
  const k = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 15);
  const minSim = config.memory.searchMinSimilarity;

  const [queryVec] = await embed([query.trim()], { inputType: 'query' });

  // Prefer pgvector HNSW; fall back to SQLite full-scan on RPC failure or
  // when Supabase is not configured.
  if (pgvectorEnabled()) {
    try {
      const hits = await searchPgvector(queryVec, k, minSim, channel_id);
      return {
        query,
        backend: 'pgvector_hnsw',
        hits,
        similarity_floor: minSim,
      };
    } catch (err) {
      const { logger } = await import('../logger.js');
      logger.warn('search pgvector failed, falling back to sqlite', { err });
    }
  }

  const local = searchSqliteFallback(queryVec, k, minSim, channel_id);
  return {
    query,
    backend: 'sqlite_cosine',
    hits: local.hits,
    corpus_scanned: local.scanned,
    similarity_floor: minSim,
  };
}
