-- ElevenLabs direct as a third provider (Kie's ElevenLabs endpoints were returning 500s,
-- and going direct also reaches the account's own voice library, clones included).
alter table public.generations
  drop constraint if exists generations_provider_check;

alter table public.generations
  add constraint generations_provider_check check (provider in ('kie', 'google', 'fal', 'elevenlabs'));
