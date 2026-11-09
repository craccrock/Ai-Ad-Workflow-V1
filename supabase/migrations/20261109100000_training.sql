-- Training: reference edits (ads the editor cut by hand, analysed into a pacing profile) and captioned renders.

create table if not exists public.reference_edits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles,
  media_id uuid references public.media on delete set null,
  title text not null,
  url text not null,
  duration_s numeric,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  error text,
  words jsonb,                 -- transcript word timestamps
  shots jsonb,                 -- [{i, start, end, kind, what}]
  profile jsonb,               -- computed pacing numbers + line map
  summary text,                -- Claude's description of the editing style
  created_at timestamptz default now()
);
alter table public.reference_edits enable row level security;

-- A captioned render of the finished ad (Remotion, rendered on the worker).
alter table public.boards add column if not exists captions jsonb;
