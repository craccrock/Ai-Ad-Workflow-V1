-- ═══════════════════════════════════════════════════════════════════════════
-- Madaket Gen Studio — initial schema
-- Run with `supabase db push` or paste into the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Profiles (extends auth.users) ─────────────────────────────────────────
create table public.profiles (
  id uuid references auth.users primary key,          -- deactivate (ban) users instead of deleting
  email text not null,
  display_name text not null,
  role text not null default 'editor' check (role in ('admin', 'editor')),
  avatar_url text,
  is_bot boolean not null default false,      -- service identities like "Claude"
  created_at timestamptz default now()
);

-- ─── API keys for external access (Claude / MCP / scripts) ────────────────
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles on delete cascade not null,
  key_hash text not null unique,              -- HMAC-SHA256(key, API_SECRET_SALT)
  key_prefix text not null,                   -- first chars, for display only
  label text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz default now()
);

-- ─── Generations ───────────────────────────────────────────────────────────
create table public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles not null,   -- no cascade: spend history must survive
  batch_id uuid,                              -- groups variants submitted together
  provider text not null check (provider in ('google', 'fal')),
  provider_request_id text,                   -- fal request_id or Google operation name
  provider_endpoint text,                     -- exact endpoint/model string used
  model text not null,                        -- id from models.config.ts
  model_display_name text not null,
  media_type text not null check (media_type in ('video', 'image', 'audio')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  params jsonb not null,
  prompt text,
  result_url text,
  result_storage_path text,
  result_metadata jsonb,
  estimated_cost_usd numeric(10,4),
  cost_usd numeric(10,4),
  duration_seconds numeric(6,2),
  resolution text,
  aspect_ratio text,
  error_message text,
  is_shared boolean not null default true,    -- visible to all editors when true
  source text not null default 'web' check (source in ('web', 'api')),
  api_key_id uuid references public.api_keys on delete set null,
  finalizing_at timestamptz,                  -- claim lock so concurrent polls don't double-finalize
  last_polled_at timestamptz,                 -- throttles provider status checks
  created_at timestamptz default now(),
  completed_at timestamptz
);

create index generations_created_at_idx on public.generations (created_at desc);
create index generations_user_idx on public.generations (user_id, created_at desc);
create index generations_model_idx on public.generations (model);
create index generations_inflight_idx on public.generations (status) where status in ('queued', 'processing');

-- ─── Media library ─────────────────────────────────────────────────────────
create table public.media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles not null,
  type text not null check (type in ('image', 'video', 'audio')),
  filename text not null,
  storage_path text not null,
  url text not null,
  file_size_bytes bigint,
  metadata jsonb,                             -- { width, height, duration_seconds, mime_type }
  generation_id uuid references public.generations on delete set null,
  created_at timestamptz default now()
);

create index media_created_at_idx on public.media (created_at desc);

-- ─── Helpers ───────────────────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- New auth user → profile row. Role is ALWAYS 'editor' here; admins are promoted
-- server-side with the service role (see scripts/create-admin.mjs and the invite action).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── Row Level Security ────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.api_keys enable row level security;
alter table public.generations enable row level security;
alter table public.media enable row level security;

-- Profiles: everyone signed in can see the team (names/avatars in the gallery).
create policy "profiles readable by team" on public.profiles
  for select to authenticated using (true);
-- Users can edit their own display name/avatar only — role is not writable by clients.
create policy "profiles self update" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- API keys: admin only (the API route itself uses the service role to verify).
create policy "api keys admin" on public.api_keys
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Generations: own + shared, admins see all. Writes go through the server (service role),
-- but owners may toggle sharing and delete their own rows.
create policy "generations read" on public.generations
  for select to authenticated
  using (user_id = auth.uid() or is_shared or public.is_admin());
create policy "generations owner update" on public.generations
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
create policy "generations owner delete" on public.generations
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
revoke update on public.generations from authenticated;
grant update (is_shared) on public.generations to authenticated;

-- Media: shared team library; uploader or admin can delete.
create policy "media read" on public.media
  for select to authenticated using (true);
create policy "media insert own" on public.media
  for insert to authenticated with check (user_id = auth.uid());
create policy "media owner delete" on public.media
  for delete to authenticated using (user_id = auth.uid() or public.is_admin());

-- ─── Storage buckets ───────────────────────────────────────────────────────
-- Public-read: providers (fal, Google) must be able to fetch reference assets by URL.
-- Object paths are random UUIDs, so URLs are unguessable. Writes are restricted.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('media', 'media', true, 524288000),        -- 500 MB
  ('generations', 'generations', true, 1073741824) -- 1 GB
on conflict (id) do nothing;

-- Browsers upload directly to the `media` bucket under their own user-id folder
-- (bypasses Vercel's 4.5 MB request body limit).
create policy "media bucket upload own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "media bucket delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
-- `generations` bucket is written only by the server with the service role.

-- ─── Spend reporting (admin dashboard) ────────────────────────────────────
-- Aggregates in Postgres so the dashboard isn't limited by PostgREST row caps.
create or replace function public.spend_stats(p_days int default 30, p_tz text default 'America/New_York')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  local_now timestamptz := now();
begin
  with g as (
    select
      gen.*,
      coalesce(gen.cost_usd, gen.estimated_cost_usd, 0) as spend,
      (gen.created_at at time zone p_tz)::date as local_day
    from public.generations gen
    where gen.status <> 'failed'
  )
  select jsonb_build_object(
    'today',      (select coalesce(sum(spend), 0) from g where local_day = (local_now at time zone p_tz)::date),
    'week',       (select coalesce(sum(spend), 0) from g where local_day >= date_trunc('week', local_now at time zone p_tz)::date),
    'month',      (select coalesce(sum(spend), 0) from g where local_day >= date_trunc('month', local_now at time zone p_tz)::date),
    'all_time',   (select coalesce(sum(spend), 0) from g),
    'count_all',  (select count(*) from g),
    'by_model',   (select coalesce(jsonb_agg(x order by x.spend desc), '[]'::jsonb) from (
                     select model, max(model_display_name) as name, sum(spend) as spend, count(*) as count
                     from g group by model) x),
    'by_user',    (select coalesce(jsonb_agg(x order by x.spend desc), '[]'::jsonb) from (
                     select g.user_id, max(p.display_name) as name, sum(spend) as spend, count(*) as count
                     from g left join public.profiles p on p.id = g.user_id group by g.user_id) x),
    'daily',      (select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb) from (
                     select d::date as day,
                            coalesce((select sum(spend) from g where local_day = d::date), 0) as spend,
                            (select count(*) from g where local_day = d::date) as count
                     from generate_series((local_now at time zone p_tz)::date - (p_days - 1), (local_now at time zone p_tz)::date, interval '1 day') d) x)
  ) into result;

  return result;
end;
$$;

-- Server-only: the app verifies the caller is an admin, then calls this with the service role.
revoke execute on function public.spend_stats(int, text) from public, anon, authenticated;
grant execute on function public.spend_stats(int, text) to service_role;
