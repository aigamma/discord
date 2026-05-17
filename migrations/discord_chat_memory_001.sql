-- Vector index for the Options Alchemy Discord bot's long-term chat memory.
-- Mirrors a subset of the local SQLite messages table (the user-role rows
-- whose text the bot wants searchable by similarity). The local SQLite store
-- remains source of truth for the audit log; this table is the search index.
--
-- Apply with one of:
--
--   psql $DATABASE_URL -f migrations/discord_chat_memory_001.sql
--
-- or via the Supabase MCP apply_migration tool, or the SQL Editor in the
-- Supabase dashboard. Requires the `vector` extension; verify with
-- `SELECT * FROM pg_extension WHERE extname = 'vector';`

CREATE TABLE IF NOT EXISTS public.discord_chat_memory (
    id BIGSERIAL PRIMARY KEY,
    local_id BIGINT NOT NULL,
    channel_id TEXT NOT NULL,
    guild_id TEXT,
    user_id TEXT NOT NULL,
    username TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    reply_local_id BIGINT,
    reply_content TEXT,
    embedding vector(1024) NOT NULL,
    embedding_model TEXT NOT NULL DEFAULT 'voyage-3',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discord_chat_memory_channel
    ON public.discord_chat_memory (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_discord_chat_memory_local_id
    ON public.discord_chat_memory (local_id);

CREATE INDEX IF NOT EXISTS idx_discord_chat_memory_embedding
    ON public.discord_chat_memory
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

ALTER TABLE public.discord_chat_memory ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.discord_chat_memory IS
  'Semantic search index for the Options Alchemy Discord bot. Mirrors a subset of the bot''s local SQLite store: user/assistant messages with voyage-3 embeddings. Backed by an HNSW index over cosine distance. Searched via search_discord_memory() RPC. Local SQLite remains the audit-log source of truth; this table is the search index only.';

CREATE OR REPLACE FUNCTION public.search_discord_memory(
    query_embedding vector(1024),
    match_count INTEGER DEFAULT 5,
    similarity_floor DOUBLE PRECISION DEFAULT 0.15,
    p_channel_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    id BIGINT,
    local_id BIGINT,
    channel_id TEXT,
    user_id TEXT,
    username TEXT,
    role TEXT,
    content TEXT,
    reply_content TEXT,
    similarity DOUBLE PRECISION,
    created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        m.id,
        m.local_id,
        m.channel_id,
        m.user_id,
        m.username,
        m.role,
        m.content,
        m.reply_content,
        1 - (m.embedding <=> query_embedding) AS similarity,
        m.created_at
    FROM public.discord_chat_memory m
    WHERE (p_channel_id IS NULL OR m.channel_id = p_channel_id)
      AND 1 - (m.embedding <=> query_embedding) >= similarity_floor
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_count;
$$;

COMMENT ON FUNCTION public.search_discord_memory IS
  'Top-K cosine-similarity search over discord_chat_memory. Used by the Options Alchemy bot to retrieve semantically similar past Q&A turns.';
