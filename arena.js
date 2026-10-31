'use strict';
// Personal event arenas. Joining a sea event (Battle Arena / Lava Run) moves ONE player into a private simulation that lives in
// session.arena - nobody else is in it, so any number of players can play at the same time. Everything is simulated here in the
// same world coordinates the sea uses, so the client draws it with the normal boat renderer (+ a 'scene' layer for the terrain).
const Sea = require('./sea');
const { CFG } = Sea;
const { steerNpc, resolveBoatBoat, r1, r2, segDist } = Sea._x;
const R = CFG.boatRadius;

// ---- lava river geometry: the river runs "up the screen" = along FW in sea coordinates; LT is sideways
const FW = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };
const LT = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
const RIVER_W = 230;                                   // narrower river
const fwdOf = (x, y) => x * FW.x + y * FW.y;
const latOf = (x, y) => x * LT.x + y * LT.y;
const toWorld = (f, l) => ({ x: FW.x * f + LT.x * l, y: FW.y * f + LT.y * l });
const bankAt = (f) => RIVER_W + 45 * Math.sin(f / 260) + 25 * Math.sin(f / 97); // wavy banks (the client draws the same curve)

const ARENA_R = 520;

function start(session, ev, now) {
  const p = session.player;
  session.arenaBackup = { x: p.x, y: p.y, hp: p.hp, mines: session.mines | 0 };
  session.intent.mx = 0; session.intent.my = 0;
  p.vx = 0; p.vy = 0; p.hp = p.maxHp; p.alive = true; p.attackAt = 0; p.cannonAt = 0;
  const inst = { kind: ev.id, evId: ev.id, t0: now, last: now, score: 0, over: false, why: '', shots: [], fx: [], npcs: [], mines: [], seq: 0, speed: CFG.speed };
  if (ev.id === 'battle') {
    p.x = 0; p.y = 0; p.facing = 0; session.mines = CFG.mineMax; // a full mine stock, refilled every wave
    inst.wave = 0; inst.nextWaveAt = now + 2200; inst.queue = []; inst.betweenHeal = 0;
  } else {
    const w = toWorld(60, 0);
    p.x = w.x; p.y = w.y; p.facing = Math.atan2(FW.y, FW.x);
    session.mines = 0;
    inst.lavaF = -420; inst.maxFwd = 60; inst.holes = []; inst.nextHole = now + 3500; inst.path = []; inst.pathF = 0; inst.pathL = 0;
  }
  session.arena = inst;
  session.events.push({ t: 'arena_start', kind: ev.id, at: now });
  return inst;
}

// back to the sea, at the edge of the event circle, with the health the boat had before
function leave(session, ev) {
  const p = session.player, b = session.arenaBackup || { x: 0, y: 0, hp: p.maxHp, mines: 0 };
  p.x = b.x; p.y = b.y; p.vx = 0; p.vy = 0; p.hp = Math.max(1, b.hp); p.alive = true;
  session.mines = Math.max(0, b.mines | 0); session.arena = null; session.arenaBackup = null;
  session.intent.mx = 0; session.intent.my = 0;
}
function result(session) {
  const a = session.arena;
  return a ? { kind: a.kind, score: Math.max(0, a.score | 0), wave: a.wave | 0 } : null;
}

function movePlayer(session, dt, now, speed, free) {
  const p = session.player, it = session.intent;
  if (session.staleIntent && (it.mx || it.my) && now - session.intentAt > CFG.intentStaleMs) { it.mx = 0; it.my = 0; }
  if (it.mx || it.my) {
    const k = Math.min(1, dt * 5.5);
    p.vx += (it.mx * speed - p.vx) * k; p.vy += (it.my * speed - p.vy) * k;
    if (Math.hypot(p.vx, p.vy) > 4) p.facing = Math.atan2(p.vy, p.vx);
  } else { p.vx *= Math.max(0, 1 - dt * 1.8); p.vy *= Math.max(0, 1 - dt * 1.8); }
  p.x += p.vx * dt; p.y += p.vy * dt;
}

// ================= BATTLE ARENA =================
function waveSpec(n) {
  return {
    count: Math.min(12, 2 + Math.floor((n - 1) * 0.8)),         // 2,2,3,4,5,6... boats: grows slowly
    hp: Math.min(120, 36 + (n - 1) * 6),
    speed: Math.min(1.1, 0.6 + 0.035 * n),                       // NPC boats are slower than the player
    shotCd: Math.max(2200, 3600 - 90 * n),                       // fewer shots
    shotDmg: Math.min(9, 3 + Math.floor(n / 2)),                 // light cannon damage
    shotSpeed: 0.55,                                             // slow balls (easy to dodge)
    shotRange: 270                                               // short range
  };
}
function spawnWave(session, inst, now) {
  inst.wave++;
  const sp = waveSpec(inst.wave);
  inst.spec = sp;
  session.mines = CFG.mineMax;                                   // mine stock refilled every wave
  session.events.push({ t: 'mine_refill', wave: inst.wave, at: now });
  for (let i = 0; i < sp.count; i++) inst.queue.push({ at: now + i * 450 });
}
function spawnNpc(inst, now) {
  const a = Math.random() * Math.PI * 2, sp = inst.spec;
  inst.npcs.push({
    id: 'a' + (++inst.seq), kind: 'boat', x: Math.cos(a) * (ARENA_R - 30), y: Math.sin(a) * (ARENA_R - 30),
    vx: 0, vy: 0, facing: a + Math.PI, hp: sp.hp, maxHp: sp.hp, alive: true, shotAt: now + 800 + Math.random() * 900, contactAt: 0,
    side: Math.random() < 0.5 ? 1 : -1
  });
}
function tickBattle(session, inst, dt, now) {
  const p = session.player;
  if (!inst.spec && now >= inst.nextWaveAt && inst.queue.length === 0 && inst.wave === 0) spawnWave(session, inst, now);
  movePlayer(session, dt, now, CFG.speed, false);
  const d = Math.hypot(p.x, p.y); if (d > ARENA_R - R) { p.x *= (ARENA_R - R) / d; p.y *= (ARENA_R - R) / d; }
  // spawn queued
  while (inst.queue.length && inst.queue[0].at <= now) { inst.queue.shift(); spawnNpc(inst, now); }
  const live = inst.npcs.filter((n) => n.alive);
  if (inst.spec && inst.queue.length === 0 && live.length === 0 && !inst.clearAt) { inst.clearAt = now; session.events.push({ t: 'wave_clear', wave: inst.wave, at: now }); p.hp = Math.min(p.maxHp, p.hp + 40); }
  if (inst.clearAt && now - inst.clearAt > 3200) { inst.clearAt = 0; spawnWave(session, inst, now); }
  const sp = inst.spec || waveSpec(1);
  for (const n of live) {
    const dx = p.x - n.x, dy = p.y - n.y, dist = Math.hypot(dx, dy) || 1;
    let tx = p.x, ty = p.y;
    if (dist < 150) { const k = n.side * 0.9; tx = n.x + (-dy / dist) * 300 * k - (dx / dist) * 80; ty = n.y + (dx / dist) * 300 * k - (dy / dist) * 80; } // circle the player at gun range
    steerNpc(n, tx, ty, CFG.npcSpeed * 1.6 * sp.speed, dt);
    const nd = Math.hypot(n.x, n.y); if (nd > ARENA_R - R) { n.x *= (ARENA_R - R) / nd; n.y *= (ARENA_R - R) / nd; }
    if (dist < sp.shotRange && now - n.shotAt > sp.shotCd) {
      n.shotAt = now + Math.random() * 400;
      const lead = dist / (CFG.cannonSpeed * sp.shotSpeed) * 0.5, a = Math.atan2(p.y + p.vy * lead - n.y, p.x + p.vx * lead - n.x) + (Math.random() - 0.5) * 0.3;
      const sv = CFG.cannonSpeed * sp.shotSpeed;
      inst.shots.push({ id: 'n' + (++inst.seq), px: n.x, py: n.y, x: n.x + Math.cos(a) * (R + 10), y: n.y + Math.sin(a) * (R + 10), vx: Math.cos(a) * sv, vy: Math.sin(a) * sv, left: sp.shotRange + 40, npc: true, dmg: sp.shotDmg });
    }
    if (dist < CFG.npcContactRange && now - n.contactAt > CFG.npcContactCdMs) { n.contactAt = now; p.hp -= Math.ceil(CFG.npcContactDamage * 0.5); session.events.push({ t: 'npc_hit', hp: p.hp, at: now }); }
  }
  for (let i = 0; i < live.length; i++) { resolveBoatBoat(p, live[i], R); for (let j = i + 1; j < live.length; j++) resolveBoatBoat(live[i], live[j], R * 0.85); }
  // shots
  const keep = [];
  for (const s of inst.shots) {
    const ox = s.px === undefined ? s.x : s.px, oy = s.py === undefined ? s.y : s.py;
    s.x += s.vx * dt; s.y += s.vy * dt; s.left -= Math.hypot(s.vx, s.vy) * dt;
    if (s.left <= 0 || Math.hypot(s.x, s.y) > ARENA_R + 20) { inst.fx.push({ x: s.x, y: s.y, k: 'splash', at: now }); continue; }
    let used = false;
    if (!s.npc) {
      for (const n of live) if (n.alive && segDist(ox, oy, s.x, s.y, n.x, n.y) <= CFG.cannonHitR) { used = true; damageNpc(session, inst, n, s.dmg, now); break; }
    } else if (segDist(ox, oy, s.x, s.y, p.x, p.y) <= R + 8) {
      used = true; p.hp -= s.dmg; inst.fx.push({ x: p.x, y: p.y, k: 'hit', at: now });
      session.events.push({ t: 'npc_hit', by: 'a pirate', hp: p.hp, at: now });
    }
    if (!used) { s.px = s.x; s.py = s.y; keep.push(s); }
  }
  inst.shots = keep;
  tickArenaMines(session, inst, live, now);
  if (p.hp <= 0) { p.hp = 0; inst.over = true; inst.why = 'sunk'; }
}
// mines in the Battle Arena: dropped behind the boat, they go red the instant an enemy touches them and blast CFG.mineFuseMs later
function tickArenaMines(session, inst, live, now) {
  if (!inst.mines.length) return;
  const keep = [];
  const falloff = (d) => (d <= CFG.mineTriggerR ? 1 : Math.max(0.35, 1 - 0.45 * (d - CFG.mineTriggerR) / Math.max(1, CFG.mineBlastR - CFG.mineTriggerR)));
  for (const m of inst.mines) {
    if (now - m.at > CFG.mineTtlMs) continue;
    if (!m.trigAt && now - m.at >= CFG.mineArmMs) {
      for (const n of live) if (n.alive && Math.hypot(n.x - m.x, n.y - m.y) <= CFG.mineTriggerR) { m.trigAt = now; break; }
    }
    if (!m.trigAt || now - m.trigAt < CFG.mineFuseMs) { keep.push(m); continue; }
    inst.fx.push({ id: Sea._x.fxSeq(), x: m.x, y: m.y, k: 'boom', at: now });
    for (const n of inst.npcs) {
      if (!n.alive) continue;
      const d = Math.hypot(n.x - m.x, n.y - m.y);
      if (d <= CFG.mineBlastR) damageNpc(session, inst, n, CFG.mineDamage * falloff(d), now);
    }
  }
  inst.mines = keep;
}
function damageNpc(session, inst, n, dmg, now) {
  n.hp -= dmg; inst.fx.push({ x: n.x, y: n.y, k: 'hit', at: now });
  if (n.hp <= 0) { n.alive = false; inst.score++; session.events.push({ t: 'kill', id: n.id, kind: 'boat', loot: 0, at: now }); inst.fx.push({ id: Sea._x.fxSeq(), x: n.x, y: n.y, k: 'boom', at: now }); }
  else session.events.push({ t: 'hit', id: n.id, hp: n.hp, at: now });
}

// ================= LAVA RUN =================
// A guaranteed lane: a random-walk centre line that is generated ahead of the boat. Holes are never placed on it, so there is
// always a (narrow, randomly placed) way forward.
const LANE_STEP = 110, LANE_SLOPE = 0.55;
function laneAt(inst, f) {
  const P = inst.path;
  if (!P.length) return 0;
  if (f <= P[0].f) return P[0].l;
  const k = Math.min(P.length - 2, Math.max(0, Math.floor((f - P[0].f) / LANE_STEP)));
  const a = P[k], b = P[k + 1]; if (!b) return a.l;
  const t = Math.max(0, Math.min(1, (f - a.f) / (b.f - a.f)));
  return a.l + (b.l - a.l) * t;
}
function ensurePath(inst, upTo) {
  const P = inst.path;
  if (!P.length) P.push({ f: 0, l: 0 });
  while (P[P.length - 1].f < upTo) {
    const last = P[P.length - 1], nf = last.f + LANE_STEP;
    const lim = Math.max(40, bankAt(nf) - R * 1.1 - 40);
    let nl = last.l + (Math.random() * 2 - 1) * LANE_STEP * LANE_SLOPE * 1.4; // wander left / right at random
    if (Math.random() < 0.25) nl = (Math.random() * 2 - 1) * lim * 0.85;          // sometimes jump to a new side (bounded by the slope below)
    nl = Math.max(last.l - LANE_STEP * LANE_SLOPE, Math.min(last.l + LANE_STEP * LANE_SLOPE, nl));
    nl = Math.max(-lim, Math.min(lim, nl));
    P.push({ f: nf, l: nl });
  }
}
function clearOfLane(inst, hf, hl, r) {
  const need = r + R * 1.15 + 8;
  for (let k = -2; k <= 2; k++) if (Math.abs(hl - laneAt(inst, hf + k * r * 0.5)) < need) return false;
  return true;
}
function tickLava(session, inst, dt, now) {
  const p = session.player;
  const dist = Math.max(0, inst.maxFwd);
  const speed = Math.min(330, 150 + dist * 0.04);        // the boat keeps getting faster with distance...
  const lavaSpeed = Math.min(240, 80 + dist * 0.03);     // ...and so does the (always slightly slower) lava
  inst.speed = speed;
  movePlayer(session, dt, now, speed, true);
  let f = fwdOf(p.x, p.y), l = latOf(p.x, p.y);
  const lim = bankAt(f) - R * 1.1;
  if (Math.abs(l) > lim) { // banks are solid: slide along them
    const nl = Math.sign(l) * lim, w = toWorld(f, nl); p.x = w.x; p.y = w.y;
    const vl = p.vx * LT.x + p.vy * LT.y; if (vl * Math.sign(l) > 0) { p.vx -= LT.x * vl; p.vy -= LT.y * vl; }
    l = nl;
  }
  if (f > inst.maxFwd) inst.maxFwd = f;
  inst.score = Math.max(0, Math.floor(inst.maxFwd / 10));
  inst.lavaF += lavaSpeed * dt;
  if (f - R * 0.5 < inst.lavaF) { inst.over = true; inst.why = 'lava'; session.events.push({ t: 'lava_sink', at: now }); return; }
  ensurePath(inst, f + 1500);
  // holes: a warning (bubbles) first, then the hole opens
  const interval = Math.max(0.45, 1.9 - dist / 1600) * 1000, per = 1 + Math.floor(dist / 3000);
  if (now >= inst.nextHole && dist > 250) {
    inst.nextHole = now + interval;
    for (let i = 0; i < per && inst.holes.length < 50; i++) {
      const r = 30 + Math.random() * 12;
      for (let tries = 0; tries < 6; tries++) {
        const hf = f + 260 + Math.random() * 560, b = bankAt(hf) - 40 - r * 0.5, hl = (Math.random() * 2 - 1) * b;
        if (!clearOfLane(inst, hf, hl, r)) continue;
        const w = toWorld(hf, hl);
        inst.holes.push({ id: 'h' + (++inst.seq), fwd: hf, x: w.x, y: w.y, r, at: now, warn: 1700, open: 7000 });
        break;
      }
    }
  }
  // drop path points far behind the boat
  while (inst.path.length > 4 && inst.path[1].f < f - 600) inst.path.shift();
  const keep = [];
  for (const h of inst.holes) {
    const age = now - h.at;
    if (age > h.warn + h.open || h.fwd < f - 800) continue;
    if (age > h.warn && Math.hypot(h.x - p.x, h.y - p.y) < h.r * 0.85) { // hit range is a little smaller than the drawn hole
      inst.over = true; inst.why = 'hole'; session.events.push({ t: 'lava_sink', at: now }); inst.fx.push({ id: Sea._x.fxSeq(), x: p.x, y: p.y, k: 'boom', at: now });
    }
    keep.push(h);
  }
  inst.holes = keep;
}

function tick(session, dt, now) {
  const inst = session.arena; if (!inst) return null;
  dt = Math.max(0.01, Math.min(0.1, dt));
  inst.fx = inst.fx.filter((f) => now - f.at < 900);
  if (!inst.over) { if (inst.kind === 'battle') tickBattle(session, inst, dt, now); else tickLava(session, inst, dt, now); }
  return { over: inst.over, why: inst.why };
}

// ---- actions inside an arena
function melee(session, now) {
  const inst = session.arena, p = session.player;
  if (!inst || inst.kind !== 'battle') return { ok: false, err: 'not_here' };
  if (now < (p.attackAt || 0)) return { ok: false, err: 'cooldown' };
  p.attackAt = now + CFG.attackCooldownMs;
  let best = null, bd = CFG.attackRange;
  for (const n of inst.npcs) if (n.alive) { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < bd) { bd = d; best = n; } }
  if (!best) { session.events.push({ t: 'miss', at: now }); return { ok: true, hit: false }; }
  damageNpc(session, inst, best, CFG.attackDamage, now);
  return { ok: true, hit: true };
}
function cannon(session, now) {
  const inst = session.arena, p = session.player;
  if (!inst || inst.kind !== 'battle') return { ok: false, err: 'not_here' };
  if (now < (p.cannonAt || 0)) return { ok: false, err: 'cooldown' };
  p.cannonAt = now + CFG.cannonCooldownMs;
  const f = p.facing || 0, c = Math.cos(f), s = Math.sin(f);
  inst.shots.push({ id: 'c' + (++inst.seq), px: p.x, py: p.y, x: p.x + c * (R * 0.6), y: p.y + s * (R * 0.6), vx: c * CFG.cannonSpeed, vy: s * CFG.cannonSpeed, left: CFG.cannonRange, npc: false, mine: true, dmg: CFG.cannonDamage });
  session.events.push({ t: 'fire', at: now });
  return { ok: true, fired: true };
}

function mine(session, now) {
  const inst = session.arena, p = session.player;
  if (!inst || inst.kind !== 'battle') return { ok: false, err: 'not_here' };
  if ((session.mines | 0) <= 0) return { ok: false, err: 'no_mines' };
  if (now < (p.mineAt || 0)) return { ok: false, err: 'cooldown' };
  p.mineAt = now + CFG.mineDropCdMs;
  const f = p.facing || 0;
  inst.mines.push({ id: 'm' + (++inst.seq), at: now, trigAt: 0, x: p.x - Math.cos(f) * CFG.mineDropBack, y: p.y - Math.sin(f) * CFG.mineDropBack });
  session.mines -= 1;
  session.events.push({ t: 'mine_drop', at: now });
  return { ok: true, mines: session.mines };
}

// ---- snapshot for the client (same shape as a sea snapshot, plus scene extras)
function view(session, now, o) {
  const inst = session.arena, p = session.player;
  const v = Sea.viewWithOthers(session, [], now, o);
  v.scene = inst.kind;
  v.islets = []; v.treasures = []; v.wrecks = []; v.wildlife = []; v.minePacks = []; v.chests = []; v.races = []; v.arenas = [];
  v.raceProgress = null; v.nearHome = false; v.team = null; v.teamInvite = null; v.others = [];
  v.mines = inst.mines.map((m) => ({ id: m.id, x: r1(m.x), y: r1(m.y), mine: true, age: now - m.at, trig: m.trigAt ? now - m.trigAt : -1 }));
  v.inv = Object.assign(v.inv || {}, { gems: 0, gold: 0 });
  v.cfg = Object.assign(v.cfg || {}, { speed: inst.speed || CFG.speed });
  v.shots = inst.shots.map((s) => ({ id: s.id, x: r1(s.x), y: r1(s.y), vx: r1(s.vx), vy: r1(s.vy), npc: !!s.npc, mine: !!s.mine }));
  v.fx = inst.fx.map((f) => ({ id: f.id || 0, x: r1(f.x), y: r1(f.y), k: f.k, age: now - f.at }));
  if (inst.kind === 'battle') {
    v.npcs = inst.npcs.filter((n) => n.alive).map((n) => ({ id: n.id, x: r1(n.x), y: r1(n.y), vx: r1(n.vx || 0), vy: r1(n.vy || 0), facing: r2(n.facing || 0), kind: 'boat', hp: n.hp, maxHp: n.maxHp }));
    v.arena = { kind: 'battle', score: inst.score, wave: inst.wave, left: inst.npcs.filter((n) => n.alive).length + inst.queue.length, r: ARENA_R, resting: !!inst.clearAt };
  } else {
    v.npcs = [];
    v.holes = inst.holes.map((h) => ({ id: h.id, x: r1(h.x), y: r1(h.y), r: r1(h.r), state: now - h.at < h.warn ? 'warn' : 'open', age: now - h.at }));
    v.arena = { kind: 'lava', score: inst.score, lavaF: r1(inst.lavaF), w: RIVER_W, speedPct: Math.round(100 * Math.min(1, Math.max(0, inst.maxFwd) / 8000)), speed: r1(inst.speed || 0) };
  }
  return v;
}

module.exports = { start, leave, result, tick, view, melee, cannon, mine, FW, LT, RIVER_W, ARENA_R, bankAt };
