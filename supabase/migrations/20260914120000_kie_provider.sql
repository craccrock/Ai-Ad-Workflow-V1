-- ═══════════════════════════════════════════════════════════════════════════
-- Kie.ai as primary provider, with fallback tracking.
-- Safe to run whether or not the init migration has already been applied.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.generations drop constraint if exists generations_provider_check;
alter table public.generations
  add constraint generations_provider_check check (provider in ('kie', 'google', 'fal'));

-- Set when the primary provider failed/stalled and the job re-ran on the backup provider.
alter table public.generations add column if not exists fallback_reason text;
alter table public.generations add column if not exists fallback_at timestamptz;

create index if not exists generations_provider_request_idx on public.generations (provider, provider_request_id);
