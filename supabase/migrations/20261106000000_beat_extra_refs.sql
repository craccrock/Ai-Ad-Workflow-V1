-- Extra reference images on a beat, after the fixed Subject / Pose / Setting slots.
alter table public.beats add column if not exists extra_media_ids uuid[] not null default '{}';
