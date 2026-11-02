create extension if not exists pgcrypto;

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  copies integer not null default 1 check (copies >= 1),
  created_at timestamptz not null default now()
);

alter table public.games
  add column if not exists copies integer not null default 1 check (copies >= 1);

create table if not exists public.scan_sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z]{4}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.scans (
  session_id uuid not null references public.scan_sessions(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  scanned_by text not null default 'Player',
  scanned_at timestamptz not null default now(),
  primary key (session_id, game_id)
);

alter table public.games enable row level security;
alter table public.scan_sessions enable row level security;
alter table public.scans enable row level security;

drop policy if exists "Public can manage games" on public.games;
create policy "Public can manage games"
  on public.games for all to anon, authenticated
  using (true) with check (true);

drop policy if exists "Public can manage scan sessions" on public.scan_sessions;
create policy "Public can manage scan sessions"
  on public.scan_sessions for all to anon, authenticated
  using (true) with check (true);

drop policy if exists "Public can manage scans" on public.scans;
create policy "Public can manage scans"
  on public.scans for all to anon, authenticated
  using (true) with check (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
  ) then
    execute 'alter publication supabase_realtime add table public.games';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scan_sessions'
  ) then
    execute 'alter publication supabase_realtime add table public.scan_sessions';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scans'
  ) then
    execute 'alter publication supabase_realtime add table public.scans';
  end if;
end
$$;
