-- Avatar (A-roll talking-head) phase: one still per board that every A-roll chunk is animated from,
-- plus the model/quality used for those clips. A-roll beats reuse video_prompt / video_duration /
-- video_generation_id(s) from the video phase.
alter table public.boards
  add column if not exists avatar_media_id uuid references public.media(id) on delete set null,
  add column if not exists avatar_model text not null default 'gemini-omni-1.1-flash',
  add column if not exists avatar_resolution text;
