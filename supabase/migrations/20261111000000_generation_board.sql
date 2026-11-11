-- Ties every board generation to its board and phase, so a board's spend can be totalled even after
-- a take is deleted, a beat is removed, or the script is re-split.
alter table public.generations
  add column if not exists board_id uuid references public.boards on delete set null,
  add column if not exists board_phase text check (board_phase in ('image', 'broll', 'aroll'));

create index if not exists generations_board_idx on public.generations (board_id) where board_id is not null;

-- Backfill from the takes still listed on beats and chunks.
update public.generations g set board_id = b.board_id, board_phase = 'image'
  from public.beats b where g.board_id is null and g.id = any (b.generation_ids);
update public.generations g set board_id = b.board_id, board_phase = 'broll'
  from public.beats b where g.board_id is null and g.id = any (b.video_generation_ids);
update public.generations g set board_id = c.board_id, board_phase = 'aroll'
  from public.avatar_chunks c where g.board_id is null and g.id = any (c.generation_ids);

-- Deleted and re-rolled takes are gone from those lists, but the learning log still names them.
update public.generations g
  set board_id = e.board_id,
      board_phase = case e.target_type when 'beat_image' then 'image' when 'beat_video' then 'broll' else 'aroll' end
  from public.learning_events e
  where g.board_id is null and e.generation_id = g.id and e.board_id is not null
    and e.target_type in ('beat_image', 'beat_video', 'chunk')
    and exists (select 1 from public.boards b where b.id = e.board_id);
