-- Idempotency for the pgvector mirror. The 001 migration created local_id
-- as a non-null BIGINT but never declared a uniqueness constraint, so a
-- partial rebuild-embeddings run could leave duplicate rows after a
-- transient Supabase write failure between the local wipe and the resync.
--
-- This migration adds the constraint plus a comment explaining why it
-- matters. PostgREST upserts against this table should pass
-- on_conflict=local_id so the merge-duplicates Prefer header has a key
-- to resolve against.

ALTER TABLE public.discord_chat_memory
  ADD CONSTRAINT discord_chat_memory_local_id_unique UNIQUE (local_id);

COMMENT ON CONSTRAINT discord_chat_memory_local_id_unique
  ON public.discord_chat_memory IS
  'One pgvector row per local SQLite messages.id. Lets the bot use PostgREST upsert with on_conflict=local_id semantics, so re-syncs replace rather than duplicate.';
