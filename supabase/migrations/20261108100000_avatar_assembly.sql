-- The assembled talking-head track (all avatar chunks joined in order), stored in the generations bucket.
-- { url, path, duration_s, chunk_ids, trims: [{chunk_id, cut_s}], created_at }
alter table public.boards add column if not exists avatar_assembly jsonb;
