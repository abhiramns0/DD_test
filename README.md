# Sinking Island — multiplayer (Co-op, Last Escape, Island Tournament)

Server-authoritative, 2–4 players, Socket.IO, one Node service, all state in memory. The client only sends intent
(move, push); the server owns positions, collection, building, push, boarding, launch, winner and results.

## Update your live game (GitHub + Render Free)
1. Replace these in your repo: `game.js`, `server.js`, `package.json`, `README.md`, and put the client at `public/index.html`.
2. `git add . && git commit -m "competitive modes" && git push` — Render redeploys automatically (same Build `npm install`, Start `npm start`).
3. Open the Render URL, create a room, pick a mode in the lobby, share the 4-letter code.

Run locally: `npm install && npm start` → http://localhost:3000 (open 2 tabs). Add `?debug` for the debug panel + dev buttons
(water+10s, res, done, tp, push, win, restart). Dev controls are disabled in production unless `ALLOW_DEBUG=1`; `ALLOW_SOLO=1` allows 1-player tests.
`npm i -D socket.io-client && npm test` runs a headless test of all three modes.

## Modes (host picks in the lobby; Solo is on the main menu)
- **Solo / Co-op Escape** — level-based. Each level = new island, shorter timer, bigger vehicle needs; crocodiles appear from level 2 (Solo) / 3 (Co-op).
  A successful escape takes the whole team to the next level; when a level is lost the run ends and shows the level reached (Solo saves it as Best Level on that device).
- **Last Escape** — one shared island, one station per player/team. Wood and leaves are there from the start; **energy ⚡ is not**: it appears in mirrored waves
  after 40 % of the timer (some waves on the borders between teams), so it is a late-game race. First launch wins, then the island collapses.
- **Island Tournament** — each team has its own island per stage (same fair layout for all): raft → boat → big boat → spaceship on the main island. First final escape wins.
- Free-for-all or 2 teams (A/B); host taps a badge to move a player between teams.

## Push
SPACE (desktop) or the PUSH button (mobile). ~1.2 s cooldown, short range, ~1 character slide, no damage.
Cannot push while collecting, building, boarded, eliminated or before GO; pushing interrupts a collection and can knock a builder out of range (progress is kept).
Pushed players get 0.7 s immunity (no chain-pushing).

## Tuning (top of `game.js`)
- `ISLAND.islandSizeMultiplier` + `PLAYER.moveSpeedMultiplier` — a **pair**: bigger island, proportionally faster player (both 1.5 now). Min/max island size also there.
- `COOP` — level timer, minimum timer, resource scaling, crocodile start level/scaling (Co-op and Solo separately), crocodile cap.
- `CROC` — crocodile speed, hit radius, warning time, respawn delay.
- `LAST_ESCAPE` — energy start (fraction of timer), wave interval, total, spawn radius, contested share.
- `CFG` (push, launch, collapse…) and `MODES` (per-mode base island, timer, needs, stages).
Collection cap = what the vehicle still needs (need − already built), so it updates as you build; the inventory dims a resource once you hold enough.

## Free-tier notes
- Render Free sleeps after ~15 min idle (first load ~30–60 s). Optional: ping `/health` every 5 min with a free UptimeRobot monitor.
- A room lives in memory: a server restart/redeploy ends running games. Disconnected players keep their slot for 20 s and auto-resume (phone sleep / tab switch).
