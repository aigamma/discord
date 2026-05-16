// Semantic search across persisted chat history. The model calls this when
// a current question references something said earlier — across days,
// across channels, or beyond the short-term context window. Returns the
// top-K most similar past user messages along with the assistant's reply
// to each.
//
// Implementation: full-scan cosine similarity over every embedded user
// message in SQLite. For a private community this stays well under a
// million rows for years; if it ever grows beyond that, swap in HNSW or
// migrate the embeddings to a vector database. The interface stays the
// same.

import { embed, blobToVec, cosineSimilarity, isEnabled } from '../embeddings.js';
import { iterEmbeddedUserMessages, getAssistantResponseFor } from '../memory.js';
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
        description: 'Optional Discord channel ID. If set, only past conversations from this channel are considered. Useful when the user clearly means "earlier in this room" rather than the whole server.',
      },
    },
    required: ['query'],
  },
};

// voyage-3 similarities compress into a tight band; the floor stays low so
// topical neighbors are surfaced and the model decides whether a hit at
// e.g. 0.22 is informative or noise based on the question+answer content
// it sees. Tune via SEARCH_MIN_SIMILARITY in .env.local if needed.
export async function execute({ query, limit = 5, channel_id = null } = {}) {
  if (!isEnabled()) {
    return { error: 'Semantic search is not configured (Voyage embeddings disabled).' };
  }
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { error: 'Empty query.' };
  }
  const k = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 15);
  const minSim = config.memory.searchMinSimilarity;

  const [queryVec] = await embed([query.trim()], { inputType: 'query' });

  const heap = [];
  let scanned = 0;
  for (const row of iterEmbeddedUserMessages()) {
    if (channel_id && row.channel_id !== channel_id) continue;
    scanned++;
    const vec = blobToVec(row.embedding);
    const sim = cosineSimilarity(queryVec, vec);
    if (sim < minSim) continue;
    heap.push({ sim, row });
  }
  heap.sort((a, b) => b.sim - a.sim);
  const top = heap.slice(0, k);

  const hits = top.map(({ sim, row }) => {
    const reply = getAssistantResponseFor(row.id);
    return {
      similarity: +sim.toFixed(3),
      asked_by: row.username || row.user_id,
      asked_at: new Date(row.created_at).toISOString(),
      channel_id: row.channel_id,
      question: row.content,
      reply: reply?.content || null,
    };
  });

  return {
    query,
    hits,
    corpus_scanned: scanned,
    above_floor: heap.length,
    similarity_floor: minSim,
  };
}
