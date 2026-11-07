-- Video phase: per-beat clip settings + results, board-level defaults.
alter table public.beats
  add column if not exists video_model text,
  add column if not exists video_duration integer,
  add column if not exists video_resolution text,
  add column if not exists video_generation_id uuid references public.generations(id) on delete set null,
  add column if not exists video_generation_ids uuid[] not null default '{}';

alter table public.boards
  add column if not exists video_model text not null default 'kling-3-pro',
  add column if not exists video_duration integer not null default 5,
  add column if not exists video_resolution text;
