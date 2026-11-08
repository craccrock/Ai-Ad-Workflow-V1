-- B-roll overlay: per-beat placement controls and the finished ad track.
alter table public.beats
  add column if not exists overlay_enabled boolean not null default true,   -- lay this beat's clip over the A-roll
  add column if not exists overlay_in numeric not null default 0,           -- seconds into the B-roll clip to start from
  add column if not exists overlay_max numeric;                             -- cap on how long it shows (seconds); null = the whole line

-- { url, path, duration_s, placements: [{beat_id, generation_id, start_s, end_s, in_s, score}], skipped: [{beat_id, reason}], created_at }
alter table public.boards add column if not exists final_assembly jsonb;
