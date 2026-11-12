-- Library intelligence: a vision-written card per image, an editor rating, and a link back to the take a winner came from.
alter table public.media
  add column if not exists card jsonb,                         -- what Claude saw: summary, subject, framing, style, quality, use_as, good_for, issues
  add column if not exists rating smallint not null default 0, -- 1 = starred (offer first), -1 = never offer to the AI, 0 = unrated
  add column if not exists source_generation_id uuid;          -- winners: the generation this library copy was made from

create index if not exists media_source_generation_idx on public.media (source_generation_id) where source_generation_id is not null;
create index if not exists media_library_idx on public.media (folder, rating) where folder is not null;
