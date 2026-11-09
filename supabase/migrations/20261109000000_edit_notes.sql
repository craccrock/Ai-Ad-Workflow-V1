-- Editor feedback on assembled cuts, and cached per-clip transcripts for word-accurate trims.

-- 1. learning_events: notes left on an A-roll track or a finished ad.
alter table public.learning_events drop constraint if exists learning_events_kind_check;
alter table public.learning_events add constraint learning_events_kind_check
  check (kind in ('reprompt', 'reroll', 'take_delete', 'take_select', 'thumbs_down', 'keeper', 'edit_note'));
alter table public.learning_events drop constraint if exists learning_events_target_type_check;
alter table public.learning_events add constraint learning_events_target_type_check
  check (target_type in ('beat_image', 'beat_video', 'chunk', 'aroll', 'final'));

-- 2. Word timestamps for one generated clip (ElevenLabs Scribe), cached forever: a clip never changes.
create table if not exists public.clip_transcripts (
  generation_id uuid primary key references public.generations on delete cascade,
  words jsonb not null default '[]',
  text text,
  created_at timestamptz default now()
);
alter table public.clip_transcripts enable row level security;
