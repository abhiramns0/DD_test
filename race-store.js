'use strict';
// Saves the boat-race leaderboards (best time per player per race track) so they survive server restarts / redeploys.
// Backends: PostgreSQL table lb_race_board when a pool is given (same database as the other leaderboards);
// otherwise a JSON file (RACE_BOARD_FILE, default ./race-board.json) so local runs keep their times too.
// Writes are queued and coalesced; a database error never crashes the game - it is logged and retried on the next save.
const fs = require('fs');
const path = require('path');

function create({ pool = null, log = console, file = process.env.RACE_BOARD_FILE || path.join(__dirname, 'race-board.json') } = {}) {
  const pending = new Map(); // raceId|uid -> { raceId, uid, name, ms }
  let timer = null, flushing = false, fails = 0;
  const mem = new Map();     // used by the file backend: raceId|uid -> row

  async function init() {
    if (pool) {
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS lb_race_board (
          race_id     text NOT NULL,
          player_id   text NOT NULL,
          name        text NOT NULL,
          best_ms     integer NOT NULL CHECK (best_ms > 0),
          achieved_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (race_id, player_id)
        )`);
        const r = await pool.query('SELECT race_id, player_id, name, best_ms FROM lb_race_board ORDER BY best_ms ASC LIMIT 500');
        return r.rows.map((x) => ({ raceId: x.race_id, uid: x.player_id, name: x.name, ms: x.best_ms }));
      } catch (e) {
        log.error('[race-board] load failed:', e.message);
        return [];
      }
    }
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const r of rows) mem.set(r.raceId + '|' + r.uid, r);
      return rows;
    } catch (e) {
      return [];
    }
  }

  function save(row) {
    if (!row || !row.raceId || !row.uid || !(row.ms > 0)) return;
    const key = row.raceId + '|' + row.uid;
    const prev = pending.get(key);
    if (prev && prev.ms <= row.ms) return;
    pending.set(key, { raceId: row.raceId, uid: row.uid, name: String(row.name || 'Sailor').slice(0, 14), ms: Math.round(row.ms) });
    if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 500);
  }

  async function flush() {
    if (flushing || !pending.size) return;
    flushing = true;
    const batch = [...pending.values()];
    pending.clear();
    try {
      if (pool) {
        for (const v of batch) {
          await pool.query(
            `INSERT INTO lb_race_board (race_id, player_id, name, best_ms) VALUES ($1,$2,$3,$4)
             ON CONFLICT (race_id, player_id) DO UPDATE SET
               name = EXCLUDED.name,
               best_ms = LEAST(lb_race_board.best_ms, EXCLUDED.best_ms),
               achieved_at = CASE WHEN EXCLUDED.best_ms < lb_race_board.best_ms THEN now() ELSE lb_race_board.achieved_at END`,
            [v.raceId, v.uid, v.name, v.ms]);
        }
      } else {
        for (const v of batch) {
          const k = v.raceId + '|' + v.uid, old = mem.get(k);
          if (!old || v.ms < old.ms) mem.set(k, v);
        }
        fs.writeFileSync(file, JSON.stringify([...mem.values()]));
      }
      fails = 0;
    } catch (e) {
      log.error('[race-board] save failed (will retry):', e.message);
      for (const v of batch) if (!pending.has(v.raceId + '|' + v.uid)) pending.set(v.raceId + '|' + v.uid, v);
      fails++;
      if (!timer) timer = setTimeout(() => { timer = null; flush(); }, Math.min(30000, 1000 * 2 ** fails));
    }
    flushing = false;
    if (pending.size && !timer) timer = setTimeout(() => { timer = null; flush(); }, 500);
  }

  return { init, save, flush };
}

module.exports = { create };
