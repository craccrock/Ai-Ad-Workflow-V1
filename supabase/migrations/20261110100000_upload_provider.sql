-- Takes the editor uploads themselves are recorded as generations with provider 'upload'.
alter table public.generations drop constraint if exists generations_provider_check;
alter table public.generations add constraint generations_provider_check check (provider in ('kie', 'google', 'fal', 'elevenlabs', 'upload'));
