-- Learning log: every editorial judgment the boards already produce, captured as a labelled example.
-- Reprompts (before → direction → after), re-rolls and deletes (rejections), take switches (soft keeps),
-- thumbs-down with a reason tag, and assembled tracks (keepers). The prompt writers will later pull the
-- best keepers and the most common corrections back into their context.
create table if not exists public.learning_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles,
  board_id uuid references public.boards on delete set null,
  kind text not null check (kind in ('reprompt', 'reroll', 'take_delete', 'take_select', 'thumbs_down', 'keeper')),
  target_type text not null check (target_type in ('beat_image', 'beat_video', 'chunk')),
  target_id uuid,                      -- beat or chunk id (not a FK: targets may be deleted later, the lesson stays)
  generation_id uuid,                  -- the take/clip this judgment is about, when there is one
  model text,                          -- generation model (image or video)
  prompt text,                         -- the prompt that produced the take, or the prompt before a reprompt
  after_prompt text,                   -- reprompt: the rewritten prompt
  direction text,                      -- reprompt: what the editor asked for
  tag text,                            -- thumbs_down: hands | face | wrong_person | text | motion | setting | other
  note text,                           -- free text (thumbs-down note, reprompt diagnosis)
  meta jsonb not null default '{}',    -- anything else: vo line, references, settings, examples count, fresh…
  created_at timestamptz default now()
);
create index if not exists learning_events_board_idx on public.learning_events (board_id, created_at desc);
create index if not exists learning_events_kind_idx on public.learning_events (kind, created_at desc);
alter table public.learning_events enable row level security;
