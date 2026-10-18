-- Drowning Dash: persistent public leaderboard.
-- Run once in Supabase  >  SQL Editor  >  New query  >  paste  >  Run.   Safe to re-run (idempotent).

-- One row per player (display name only; no personal data).
create table if not exists public.lb_players (
  player_id  text primary key check (player_id ~ '^[a-f0-9]{16,32}$'),   -- random id the browser generates (si_uid)
  name       text not null check (char_length(name) between 1 and 14),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per player + game mode + play type = that player's BEST score (highest co-op level reached).
--   play_type 'solo'        -> "Solo" tab            play_type 'multiplayer' -> "Multiplayer" tab
--   game_mode 'coop' is what the game records today; 'tournament' / 'end_game' are allowed so more boards can be added later.
create table if not exists public.lb_scores (
  player_id   text not null references public.lb_players(player_id) on delete cascade,
  game_mode   text not null default 'coop' check (game_mode in ('coop','tournament','end_game')),
  play_type   text not null check (play_type in ('solo','multiplayer')),
  score       integer not null check (score between 1 and 999),
  achieved_at timestamptz not null default now(),   -- when the CURRENT best was reached (earlier wins ties)
  updated_at  timestamptz not null default now(),
  primary key (player_id, game_mode, play_type)
);

-- Ranking rule (same as before): higher score first, then whoever reached it earlier, then player_id for a stable order.
create index if not exists lb_scores_rank_idx
  on public.lb_scores (game_mode, play_type, score desc, achieved_at asc, player_id asc);

-- Security: only the game server (direct Postgres connection from Render) may touch these tables.
-- RLS is enabled with NO policies and the API roles are revoked, so Supabase's public REST/anon key can neither read nor write them.
alter table public.lb_players enable row level security;
alter table public.lb_scores  enable row level security;
do $$
begin  -- (the roles exist on Supabase; the check just keeps the script runnable on plain Postgres too)
  if exists (select 1 from pg_roles where rolname = 'anon')          then revoke all on public.lb_players, public.lb_scores from anon;          end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.lb_players, public.lb_scores from authenticated; end if;
end $$;
