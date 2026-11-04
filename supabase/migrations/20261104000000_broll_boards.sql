-- ═══════════════════════════════════════════════════════════════════════════
-- B-roll Starter Image Board: boards, beats, subject locks, app settings,
-- and library tagging on media (folder / tags / source_path for imported B-roll).
-- All access goes through API routes with the service role + actor checks,
-- like generations; RLS is on with no client policies.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Media library tagging ─────────────────────────────────────────────────
alter table public.media add column if not exists folder text;            -- "Cryo therapy treatment"
alter table public.media add column if not exists tags text[] not null default '{}';
alter table public.media add column if not exists source_path text;       -- original file on disk (importer idempotency)
create index if not exists media_folder_idx on public.media (folder);
create unique index if not exists media_source_path_idx on public.media (source_path) where source_path is not null;

-- ─── App settings (editable brain prompt etc.) ─────────────────────────────
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.profiles,
  updated_at timestamptz default now()
);
alter table public.app_settings enable row level security;

-- ─── Subject locks ─────────────────────────────────────────────────────────
create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles not null,
  name text not null,
  media_id uuid references public.media on delete set null,   -- base image
  base_prompt text not null default '',
  is_default boolean not null default false,
  created_at timestamptz default now()
);
alter table public.subjects enable row level security;

-- ─── Boards ────────────────────────────────────────────────────────────────
create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles not null,
  title text not null default 'Untitled board',
  script text not null default '',
  subject_id uuid references public.subjects on delete set null,
  model text not null default 'nano-banana-pro',
  aspect_ratio text not null default '9:16',
  resolution text not null default '2K',
  brain_output jsonb,                 -- subject_lock + style_locks from the last split
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists boards_user_idx on public.boards (user_id, updated_at desc);
alter table public.boards enable row level security;

-- ─── Beats ─────────────────────────────────────────────────────────────────
create table if not exists public.beats (
  id uuid primary key default gen_random_uuid(),
  board_id uuid references public.boards on delete cascade not null,
  position integer not null default 0,
  role text not null default 'broll' check (role in ('aroll', 'broll')),
  vo text not null default '',
  shot_type text,
  style text,                          -- ugc_real | anatomy | product
  image_prompt text not null default '',
  video_prompt text,
  negative_prompt text,
  reference_plan jsonb,                -- raw plan from the brain (mode, library_asset, edit_note, …)
  use_subject_lock boolean not null default true,
  pose_media_id uuid references public.media on delete set null,
  setting_media_id uuid references public.media on delete set null,
  generation_id uuid references public.generations on delete set null,   -- latest result
  generation_ids uuid[] not null default '{}',                           -- every result, oldest first
  created_at timestamptz default now()
);
create index if not exists beats_board_idx on public.beats (board_id, position);
alter table public.beats enable row level security;
