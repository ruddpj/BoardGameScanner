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

create or replace function public.prevent_saved_session_changes()
returns trigger
language plpgsql
as $$
begin
  if new.code is distinct from old.code
    or new.created_at is distinct from old.created_at then
    raise exception 'Session code and creation time cannot be changed';
  end if;

  if old.saved_at is not null then
    raise exception 'A finished session cannot be changed';
  end if;

  if new.saved_at is null then
    raise exception 'A session can only be updated by finishing it';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_saved_session_changes on public.scan_sessions;
create trigger prevent_saved_session_changes
  before update on public.scan_sessions
  for each row execute function public.prevent_saved_session_changes();

alter table public.games enable row level security;
alter table public.scan_sessions enable row level security;
alter table public.scans enable row level security;

do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('games', 'scan_sessions', 'scans')
  loop
    execute format(
      'drop policy %I on public.%I',
      existing_policy.policyname,
      existing_policy.tablename
    );
  end loop;
end
$$;

create policy "Anyone can read games"
  on public.games for select to anon, authenticated
  using (true);
create policy "Authenticated can add games"
  on public.games for insert to authenticated
  with check (auth.uid() is not null);
create policy "Authenticated can edit games"
  on public.games for update to authenticated
  using (auth.uid() is not null)
  with check (auth.uid() is not null);
create policy "Authenticated can remove games"
  on public.games for delete to authenticated
  using (auth.uid() is not null);

create policy "Anyone can read scan sessions"
  on public.scan_sessions for select to anon, authenticated
  using (true);
create policy "Authenticated can create scan sessions"
  on public.scan_sessions for insert to authenticated
  with check (auth.uid() is not null and saved_at is null);
create policy "Authenticated can finish scan sessions"
  on public.scan_sessions for update to authenticated
  using (auth.uid() is not null and saved_at is null)
  with check (auth.uid() is not null and saved_at is not null);

revoke update on public.scan_sessions from anon, authenticated;
grant update (saved_at) on public.scan_sessions to authenticated;

create policy "Anyone can read scans"
  on public.scans for select to anon, authenticated
  using (true);
create policy "Anyone can add scans to active sessions"
  on public.scans for insert to anon, authenticated
  with check (
    exists (
      select 1
      from public.scan_sessions
      where scan_sessions.id = scans.session_id
        and scan_sessions.saved_at is null
    )
  );

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
