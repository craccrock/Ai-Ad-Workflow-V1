-- Starter images: generations made on the Starter tab, so that tab can list just its own takes.
create table if not exists public.starter_takes (
  generation_id uuid primary key references public.generations on delete cascade,
  user_id uuid references public.profiles,
  favorite boolean not null default false,
  direction text,                       -- what the editor asked Claude for, when the prompt came from the brief
  created_at timestamptz default now()
);
create index if not exists starter_takes_created_idx on public.starter_takes (created_at desc);
alter table public.starter_takes enable row level security;
