-- Avatar (talking-head) phase. One still per board; the WHOLE script is cut into clip-sized chunks that the
-- avatar speaks in order. Chunks are their own list (not the storyboard beats): the storyboard cuts for
-- visuals, the avatar cuts for speech length, and B-roll is later laid over the avatar timeline by matching
-- each beat's line in the transcript.
alter table public.boards
  add column if not exists avatar_media_id uuid references public.media(id) on delete set null,
  add column if not exists avatar_model text not null default 'gemini-omni-1.1-flash',
  add column if not exists avatar_resolution text;

create table if not exists public.avatar_chunks (
  id uuid primary key default gen_random_uuid(),
  board_id uuid references public.boards on delete cascade not null,
  position integer not null default 0,
  vo text not null default '',                                            -- the words she speaks, verbatim from the script
  duration integer,                                                       -- clip length in seconds; null = auto from the word count
  video_prompt text,                                                      -- the talking-head prompt
  generation_id uuid references public.generations on delete set null,   -- clip on display
  generation_ids uuid[] not null default '{}',                            -- every clip, oldest first
  created_at timestamptz default now()
);
create index if not exists avatar_chunks_board_idx on public.avatar_chunks (board_id, position);
alter table public.avatar_chunks enable row level security;
