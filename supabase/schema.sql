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
  created_at timestamptz not null default now(),
  saved_at timestamptz
);

alter table public.scan_sessions
  add column if not exists saved_at timestamptz;

create table if not exists public.scans (
  session_id uuid not null references public.scan_sessions(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  scanned_by text not null default 'Player',
  scanned_at timestamptz not null default now(),
  primary key (session_id, game_id)
);

create or replace function public.prevent_scans_in_saved_sessions()
returns trigger
language plpgsql
as $$
declare
  session_saved_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    select saved_at into session_saved_at
    from public.scan_sessions
    where id = old.session_id;

    if session_saved_at is not null then
      raise exception 'Scans cannot be changed after a session is saved';
    end if;
  end if;

  select saved_at into session_saved_at
  from public.scan_sessions
  where id = new.session_id;

  if session_saved_at is not null then
    raise exception 'Scans cannot be changed after a session is saved';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_scans_in_saved_sessions on public.scans;
create trigger prevent_scans_in_saved_sessions
  before insert or update on public.scans
  for each row execute function public.prevent_scans_in_saved_sessions();

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
