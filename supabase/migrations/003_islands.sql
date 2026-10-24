-- Drowning Dash: persistent private islands (one JSON document per player).
-- Run once in Supabase > SQL Editor > New query > paste > Run.  Safe to re-run (idempotent).
-- Requires 001_leaderboard.sql and 002_accounts.sql to have been run first.
--
-- Layout, unlocked zones, structures and progression live in `data` (versioned by schema_v), so new structure types,
-- zones or fields need NO new migration. `rev` is bumped on every save (optimistic locking: two devices can never silently overwrite each other).
-- The row belongs to lb_players(player_id): deleting a player (Delete account) deletes the island with it.
create table if not exists public.lb_islands (
  player_id  text primary key references public.lb_players(player_id) on delete cascade,
  schema_v   integer not null default 1,
  rev        integer not null default 1,
  data       jsonb   not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) < 200000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same lock-down as 001/002: RLS on with no policies + API roles revoked => only the game server (direct Postgres connection) can read or write.
alter table public.lb_islands enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')          then revoke all on public.lb_islands from anon;          end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.lb_islands from authenticated; end if;
end $$;
