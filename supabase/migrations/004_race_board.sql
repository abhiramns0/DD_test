-- Drowning Dash: persistent boat-race leaderboards (Open Sea). Optional: the server also creates this table itself on start-up.
create table if not exists public.lb_race_board (
  race_id     text not null,
  player_id   text not null,
  name        text not null,
  best_ms     integer not null check (best_ms > 0),
  achieved_at timestamptz not null default now(),
  primary key (race_id, player_id)
);
create index if not exists lb_race_board_rank_idx on public.lb_race_board (race_id, best_ms asc);
alter table public.lb_race_board enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')          then revoke all on public.lb_race_board from anon;          end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.lb_race_board from authenticated; end if;
end $$;
