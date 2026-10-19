-- Drowning Dash: accounts support (Google / Apple / email sign-in via Supabase Auth).
-- Run once in Supabase  >  SQL Editor  >  New query  >  paste  >  Run.   Safe to re-run (idempotent).
-- Requires 001_leaderboard.sql to have been run first.
--
-- Identity model: a signed-in player's leaderboard id is their Supabase user id with the dashes removed
-- (32 hex chars), so it already fits the existing lb_players.player_id rule. Guests keep their random browser id.
-- When a guest signs in, the server MOVES the guest's rows to the account (see leaderboard.js > merge()).

-- Per-player progress that is not a leaderboard score: highest solo level completed (drives skin / scenery unlocks)
-- and purchased items. Written only by the game server (direct Postgres connection), never by the browser.
create table if not exists public.lb_profiles (
  player_id     text primary key references public.lb_players(player_id) on delete cascade,
  done_level    integer not null default 0 check (done_level between 0 and 999),
  owned_skins   text[]  not null default '{}',
  owned_scenery text[]  not null default '{}',
  updated_at    timestamptz not null default now()
);

-- Remembers which guest id was moved into which account, so one guest id can never be claimed by two accounts.
-- (No foreign key on purpose: the guest's lb_players row is deleted when it is moved.)
create table if not exists public.lb_links (
  guest_id   text primary key check (guest_id ~ '^[a-f0-9]{16,32}$'),
  account_id text not null check (account_id ~ '^[a-f0-9]{16,32}$'),
  linked_at  timestamptz not null default now()
);
create index if not exists lb_links_account_idx on public.lb_links (account_id);

-- Same lock-down as 001: RLS on with no policies + API roles revoked => only the game server can read or write.
alter table public.lb_profiles enable row level security;
alter table public.lb_links    enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')          then revoke all on public.lb_profiles, public.lb_links from anon;          end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.lb_profiles, public.lb_links from authenticated; end if;
end $$;
