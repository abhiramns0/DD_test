# Drowning Dash – private islands (foundation)

## Files
| File | Location | Status |
|---|---|---|
| `island.js` | repo root | **new** – rules, catalogs, validation (pure, no DB/sockets/drawing) |
| `island-store.js` | repo root | **new** – saving / loading (PostgreSQL, memory fallback) |
| `server.js`, `leaderboard.js` | repo root | replace (small additions only) |
| `003_islands.sql` | `supabase/migrations/` | **new** – run once in the Supabase SQL editor |
| `index.html`, `sw.js` | `public/` | replace |
| `island-view.js` | `public/` | **new** – renderer only |
| `test-island.js`, `test-island-server.js` | repo root | optional tests (`node test-island.js`, `node test-island-server.js`) |

`game.js`, `auth.js`, `package.json`: unchanged, no new npm packages.

## Deploy
1. Supabase → SQL Editor → run `003_islands.sql` (after 001 and 002).
2. Push the files, let Render redeploy.
3. Open `/health/island` → `{"store":"postgres","persistent":true,"ok":true,...}`. If it says `memory`, `DATABASE_URL` is missing; if `ok:false`, the SQL was not run.
4. Main menu → **🏝️ MY ISLAND**.

## Storage
One row per player in `lb_islands(player_id, schema_v, rev, data jsonb, ...)`, owned by `lb_players` (deleted with the player).
`data` = `{v, unlocked:[zoneIds], structures:[{id,type,x,y}], nextId, progress:{level}, resources:{}}`.
Zone geometry and structure definitions live in `island.js` catalogs, so new structures/zones need no migration; only a new `v` needs a migration function in `normalize()`.
`rev` is a compare-and-swap counter: two devices can never silently overwrite each other.

## Extending
- New structure: add an entry to `STRUCTURES` in `island.js` (+ an icon in `island-view.js`).
- New zone: add to `ZONES`; unlocking = a new action that appends the id to `unlocked`.
- New rules (build, upgrade, collect): add a function to `ACTIONS` in `island.js`; the store and socket layer need no change.
