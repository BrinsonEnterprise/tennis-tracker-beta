-- Tennis Stat Tracker — closed beta schema
-- Run once in Supabase: Dashboard → SQL Editor → paste → Run.
-- Safe to re-run (idempotent).
--
-- Model: the app stays local-first (the phone is the working copy). Each signed-in
-- tester's whole database is snapshotted to beta_backups (append-only history),
-- so a lost/cleared phone can be restored and we can analyse beta data in SQL.

begin;

-- ---------------------------------------------------------------------------
-- Profiles: one row per tester, records role + beta terms acceptance.
-- ---------------------------------------------------------------------------
create table if not exists public.beta_profiles (
  user_id                uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  role                   text not null check (role in ('coach', 'athlete', 'parent')),
  display_name           text check (char_length(display_name) <= 120),
  beta_terms_version     text not null check (char_length(beta_terms_version) <= 40),
  beta_terms_accepted_at timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Backups: full-database snapshots, append-only, pruned automatically.
-- ---------------------------------------------------------------------------
create table if not exists public.beta_backups (
  id               bigint generated always as identity primary key,
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_backup_id uuid not null,
  created_at       timestamptz not null default now(),
  app_version      integer not null check (app_version between 0 and 1000000),
  device_label     text check (char_length(device_label) <= 200),
  reason           text not null check (reason in ('auto', 'manual', 'app-hidden', 'before-restore')),
  player_count     integer not null default 0,
  match_count      integer not null default 0,
  size_bytes       integer not null default 0,
  payload          jsonb not null,
  constraint beta_backups_client_id_unique unique (user_id, client_backup_id)
);

create index if not exists beta_backups_user_created_idx
  on public.beta_backups (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Feedback and client error reports.
-- ---------------------------------------------------------------------------
create table if not exists public.beta_feedback (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  message     text not null check (char_length(message) between 1 and 4000),
  app_version integer,
  device_label text check (char_length(device_label) <= 200)
);

create table if not exists public.beta_client_errors (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  message     text not null check (char_length(message) <= 2000),
  stack       text check (char_length(stack) <= 8000),
  source      text check (char_length(source) <= 500),
  app_version integer,
  device_label text check (char_length(device_label) <= 200)
);

create index if not exists beta_client_errors_user_created_idx
  on public.beta_client_errors (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Server is authoritative for owner, sizes and counts; also validates shape and rate.
create or replace function public.beta_backups_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recent_count integer;
  max_bytes constant integer := 15728640;        -- 15 MB per backup
  max_user_bytes constant bigint := 52428800;    -- 50 MB per tester across retained backups (free-plan sizing)
begin
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if jsonb_typeof(new.payload) is distinct from 'object'
     or jsonb_typeof(new.payload -> 'players') is distinct from 'array'
     or jsonb_typeof(new.payload -> 'matches') is distinct from 'array' then
    raise exception 'Backup payload is not a Tennis Tracker database' using errcode = '22023';
  end if;

  new.size_bytes   := octet_length(new.payload::text);
  new.player_count := jsonb_array_length(new.payload -> 'players');
  new.match_count  := jsonb_array_length(new.payload -> 'matches');
  new.created_at   := now();

  if new.size_bytes > max_bytes then
    raise exception 'Backup too large (% bytes)', new.size_bytes using errcode = '54000';
  end if;

  select count(*) into recent_count
  from public.beta_backups
  where user_id = new.user_id and created_at > now() - interval '5 minutes';
  if recent_count >= 10 then
    raise exception 'Backup rate limit exceeded, try again shortly' using errcode = 'P0429';
  end if;

  -- Open signups: cap total stored bytes per tester. Make room by dropping the oldest
  -- backups, but always keep the 3 most recent; refuse only if it still doesn't fit.
  loop
    exit when (select coalesce(sum(size_bytes), 0) from public.beta_backups where user_id = new.user_id)
              + new.size_bytes <= max_user_bytes;
    delete from public.beta_backups
    where id = (
      select id from public.beta_backups
      where user_id = new.user_id
        and id not in (
          select id from public.beta_backups where user_id = new.user_id
          order by created_at desc, id desc limit 3
        )
      order by created_at asc, id asc
      limit 1
    );
    if not found then
      raise exception 'Cloud backup storage limit reached for this account' using errcode = '53400';
    end if;
  end loop;

  return new;
end;
$$;

-- Retention: keep the 10 most recent backups plus the last backup of each day
-- for 14 days. Everything else for that user is deleted.
create or replace function public.beta_backups_after_insert_prune()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.beta_backups b
  where b.user_id = new.user_id
    and b.id not in (
      select id from public.beta_backups
      where user_id = new.user_id
      order by created_at desc, id desc
      limit 10
    )
    and b.id not in (
      select distinct on (date_trunc('day', created_at)) id
      from public.beta_backups
      where user_id = new.user_id
        and created_at > now() - interval '14 days'
      order by date_trunc('day', created_at), created_at desc, id desc
    );
  return null;
end;
$$;

create or replace function public.beta_set_owner_and_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recent_count integer;
begin
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  new.created_at := now();

  execute format(
    'select count(*) from public.%I where user_id = $1 and created_at > now() - interval ''10 minutes''',
    tg_table_name
  ) into recent_count using new.user_id;

  if recent_count >= 30 then
    raise exception 'Rate limit exceeded' using errcode = 'P0429';
  end if;
  return new;
end;
$$;

create or replace function public.beta_profiles_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.beta_terms_accepted_at := now();
  else
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists beta_backups_before_insert on public.beta_backups;
create trigger beta_backups_before_insert
  before insert on public.beta_backups
  for each row execute function public.beta_backups_before_insert();

drop trigger if exists beta_backups_after_insert_prune on public.beta_backups;
create trigger beta_backups_after_insert_prune
  after insert on public.beta_backups
  for each row execute function public.beta_backups_after_insert_prune();

drop trigger if exists beta_feedback_before_insert on public.beta_feedback;
create trigger beta_feedback_before_insert
  before insert on public.beta_feedback
  for each row execute function public.beta_set_owner_and_rate_limit();

drop trigger if exists beta_client_errors_before_insert on public.beta_client_errors;
create trigger beta_client_errors_before_insert
  before insert on public.beta_client_errors
  for each row execute function public.beta_set_owner_and_rate_limit();

drop trigger if exists beta_profiles_before_write on public.beta_profiles;
create trigger beta_profiles_before_write
  before insert or update on public.beta_profiles
  for each row execute function public.beta_profiles_before_write();

-- Trigger functions must not be callable through the API.
revoke all on function public.beta_backups_before_insert()      from public, anon, authenticated;
revoke all on function public.beta_backups_after_insert_prune() from public, anon, authenticated;
revoke all on function public.beta_set_owner_and_rate_limit()   from public, anon, authenticated;
revoke all on function public.beta_profiles_before_write()      from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security + least-privilege grants
-- ---------------------------------------------------------------------------
alter table public.beta_profiles      enable row level security;
alter table public.beta_backups       enable row level security;
alter table public.beta_feedback      enable row level security;
alter table public.beta_client_errors enable row level security;

revoke all on public.beta_profiles, public.beta_backups, public.beta_feedback, public.beta_client_errors from anon;
revoke all on public.beta_profiles, public.beta_backups, public.beta_feedback, public.beta_client_errors from authenticated;

grant select, insert, update on public.beta_profiles      to authenticated;
grant select, insert, delete on public.beta_backups       to authenticated;
grant select, insert         on public.beta_feedback      to authenticated;
grant insert                 on public.beta_client_errors to authenticated;

drop policy if exists beta_profiles_select_own on public.beta_profiles;
create policy beta_profiles_select_own on public.beta_profiles
  for select to authenticated using (user_id = auth.uid());
drop policy if exists beta_profiles_insert_own on public.beta_profiles;
create policy beta_profiles_insert_own on public.beta_profiles
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists beta_profiles_update_own on public.beta_profiles;
create policy beta_profiles_update_own on public.beta_profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists beta_backups_select_own on public.beta_backups;
create policy beta_backups_select_own on public.beta_backups
  for select to authenticated using (user_id = auth.uid());
drop policy if exists beta_backups_insert_own on public.beta_backups;
create policy beta_backups_insert_own on public.beta_backups
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists beta_backups_delete_own on public.beta_backups;
create policy beta_backups_delete_own on public.beta_backups
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists beta_feedback_select_own on public.beta_feedback;
create policy beta_feedback_select_own on public.beta_feedback
  for select to authenticated using (user_id = auth.uid());
drop policy if exists beta_feedback_insert_own on public.beta_feedback;
create policy beta_feedback_insert_own on public.beta_feedback
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists beta_client_errors_insert_own on public.beta_client_errors;
create policy beta_client_errors_insert_own on public.beta_client_errors
  for insert to authenticated with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Self-service deletion: removes all of the caller's cloud data and their login.
-- Data on the tester's phone is untouched.
-- ---------------------------------------------------------------------------
create or replace function public.beta_delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  delete from public.beta_backups       where user_id = uid;
  delete from public.beta_feedback      where user_id = uid;
  delete from public.beta_client_errors where user_id = uid;
  delete from public.beta_profiles      where user_id = uid;
  delete from auth.users                where id = uid;
end;
$$;

revoke all on function public.beta_delete_my_account() from public, anon;
grant execute on function public.beta_delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- Admin analysis views (dashboard / SQL editor only — not exposed to the API).
-- ---------------------------------------------------------------------------
create or replace view public.beta_admin_latest_backups
with (security_invoker = true) as
select distinct on (b.user_id)
  b.user_id, u.email, p.role, b.created_at as backed_up_at, b.app_version,
  b.device_label, b.player_count, b.match_count, b.size_bytes, b.payload
from public.beta_backups b
join auth.users u on u.id = b.user_id
left join public.beta_profiles p on p.user_id = b.user_id
order by b.user_id, b.created_at desc, b.id desc;

create or replace view public.beta_admin_matches
with (security_invoker = true) as
select
  l.user_id,
  l.email                                        as tester_email,
  m ->> 'id'                                     as match_id,
  m ->> 'status'                                 as status,
  m -> 'meta' ->> 'date'                         as match_date,
  m -> 'meta' ->> 'event'                        as event,
  m -> 'meta' ->> 'surface'                      as surface,
  m -> 'meta' ->> 'matchType'                    as match_type,
  m -> 'meta' ->> 'trackingDepth'                as tracking_depth,
  m -> 'meta' -> 'playerNames' ->> 0             as side_a,
  m -> 'meta' -> 'playerNames' ->> 1             as side_b,
  jsonb_array_length(coalesce(m -> 'pointLog', '[]'::jsonb)) as points_tracked,
  (m ->> 'createdAt')::timestamptz               as created_at
from public.beta_admin_latest_backups l
cross join lateral jsonb_array_elements(l.payload -> 'matches') as m;

create or replace view public.beta_admin_activity
with (security_invoker = true) as
select
  u.email, p.role, p.beta_terms_accepted_at,
  (select max(created_at) from public.beta_backups b where b.user_id = u.id)        as last_backup_at,
  (select count(*) from public.beta_feedback f where f.user_id = u.id)              as feedback_count,
  (select count(*) from public.beta_client_errors e
     where e.user_id = u.id and e.created_at > now() - interval '7 days')           as errors_7d
from auth.users u
left join public.beta_profiles p on p.user_id = u.id;

revoke all on public.beta_admin_latest_backups, public.beta_admin_matches, public.beta_admin_activity
  from public, anon, authenticated;

commit;
