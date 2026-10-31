'use strict';
// Personal event arenas. Joining a sea event (Battle Arena / Lava Run) moves ONE player into a private simulation that lives in
// session.arena - nobody else is in it, so any number of players can play at the same time. Everything is simulated here in the
// same world coordinates the sea uses, so the client draws it with the normal boat renderer (+ a 'scene' layer for the terrain).
const Sea = require('./sea');
const { CFG } = Sea;
const { steerNpc, resolveBoatBoat, r1, r2 } = Sea._x;
const R = CFG.boatRadius;

// ---- lava river geometry: the river runs "up the screen" = along FW in sea coordinates; LT is sideways
const FW = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };
const LT = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
const RIVER_W = 330;
const fwdOf = (x, y) => x * FW.x + y * FW.y;
const latOf = (x, y) => x * LT.x + y * LT.y;
const toWorld = (f, l) => ({ x: FW.x * f + LT.x * l, y: FW.y * f + LT.y * l });
const bankAt = (f) => RIVER_W + 45 * Math.sin(f / 260) + 25 * Math.sin(f / 97); // wavy banks (the client draws the same curve)

const ARENA_R = 520;

function start(session, ev, now) {
  const p = session.player;
  session.arenaBackup = { x: p.x, y: p.y, hp: p.hp };
  session.intent.mx = 0; session.intent.my = 0;
  p.vx = 0; p.vy = 0; p.hp = p.maxHp; p.alive = true; p.attackAt = 0; p.cannonAt = 0;
  const inst = { kind: ev.id, evId: ev.id, t0: now, last: now, score: 0, over: false, why: '', shots: [], fx: [], npcs: [], seq: 0 };
  if (ev.id === 'battle') {
    p.x = 0; p.y = 0; p.facing = 0;
    inst.wave = 0; inst.nextWaveAt = now + 2200; inst.queue = []; inst.betweenHeal = 0;
  } else {
    const w = toWorld(60, 0);
    p.x = w.x; p.y = w.y; p.facing = Math.atan2(FW.y, FW.x);
    inst.lavaF = -420; inst.maxFwd = 60; inst.holes = []; inst.nextHole = now + 3500;
  }
  session.arena = inst;
  session.events.push({ t: 'arena_start', kind: ev.id, at: now });
  return inst;
}

// back to the sea, at the edge of the event circle, with the health the boat had before
function leave(session, ev) {
  const p = session.player, b = session.arenaBackup || { x: 0, y: 0, hp: p.maxHp };
  p.x = b.x; p.y = b.y; p.vx = 0; p.vy = 0; p.hp = Math.max(1, b.hp); p.alive = true;
  session.arena = null; session.arenaBackup = null;
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
    count: Math.min(16, 3 + (n - 1) * 2),
    hp: Math.min(160, 40 + (n - 1) * 10),
    speed: Math.min(1.45, 0.8 + 0.05 * n),
    shotCd: Math.max(900, 2400 - 130 * n),
    shotDmg: Math.min(16, 7 + n)
  };
}
function spawnWave(inst, now) {
  inst.wave++;
  const sp = waveSpec(inst.wave);
  inst.spec = sp;
  for (let i = 0; i < sp.count; i++) inst.queue.push({ at: now + i * 380 });
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
  if (!inst.spec && now >= inst.nextWaveAt && inst.queue.length === 0 && inst.wave === 0) spawnWave(inst, now);
  movePlayer(session, dt, now, CFG.speed, false);
  const d = Math.hypot(p.x, p.y); if (d > ARENA_R - R) { p.x *= (ARENA_R - R) / d; p.y *= (ARENA_R - R) / d; }
  // spawn queued
  while (inst.queue.length && inst.queue[0].at <= now) { inst.queue.shift(); spawnNpc(inst, now); }
  const live = inst.npcs.filter((n) => n.alive);
  if (inst.spec && inst.queue.length === 0 && live.length === 0 && !inst.clearAt) { inst.clearAt = now; session.events.push({ t: 'wave_clear', wave: inst.wave, at: now }); p.hp = Math.min(p.maxHp, p.hp + 30); }
  if (inst.clearAt && now - inst.clearAt > 3200) { inst.clearAt = 0; spawnWave(inst, now); }
  const sp = inst.spec || waveSpec(1);
  for (const n of live) {
    const dx = p.x - n.x, dy = p.y - n.y, dist = Math.hypot(dx, dy) || 1;
    let tx = p.x, ty = p.y;
    if (dist < 190) { const k = n.side * 0.9; tx = n.x + (-dy / dist) * 300 * k - (dx / dist) * 80; ty = n.y + (dx / dist) * 300 * k - (dy / dist) * 80; } // circle the player at gun range
    steerNpc(n, tx, ty, CFG.npcSpeed * sp.speed, dt);
    const nd = Math.hypot(n.x, n.y); if (nd > ARENA_R - R) { n.x *= (ARENA_R - R) / nd; n.y *= (ARENA_R - R) / nd; }
    if (dist < 380 && now - n.shotAt > sp.shotCd) {
      n.shotAt = now + Math.random() * 400;
      const lead = dist / CFG.cannonSpeed, a = Math.atan2(p.y + p.vy * lead - n.y, p.x + p.vx * lead - n.x) + (Math.random() - 0.5) * 0.12;
      inst.shots.push({ id: 'n' + (++inst.seq), x: n.x + Math.cos(a) * (R + 10), y: n.y + Math.sin(a) * (R + 10), vx: Math.cos(a) * CFG.cannonSpeed * 0.85, vy: Math.sin(a) * CFG.cannonSpeed * 0.85, left: 460, npc: true, dmg: sp.shotDmg });
    }
    if (dist < CFG.npcContactRange && now - n.contactAt > CFG.npcContactCdMs) { n.contactAt = now; p.hp -= CFG.npcContactDamage; session.events.push({ t: 'npc_hit', hp: p.hp, at: now }); }
  }
  for (let i = 0; i < live.length; i++) { resolveBoatBoat(p, live[i], R); for (let j = i + 1; j < live.length; j++) resolveBoatBoat(live[i], live[j], R * 0.85); }
  // shots
  const keep = [];
  for (const s of inst.shots) {
    s.x += s.vx * dt; s.y += s.vy * dt; s.left -= Math.hypot(s.vx, s.vy) * dt;
    if (s.left <= 0 || Math.hypot(s.x, s.y) > ARENA_R + 20) { inst.fx.push({ x: s.x, y: s.y, k: 'splash', at: now }); continue; }
    let used = false;
    if (!s.npc) {
      for (const n of live) if (n.alive && Math.hypot(n.x - s.x, n.y - s.y) <= CFG.cannonHitR) { used = true; damageNpc(session, inst, n, s.dmg, now); break; }
    } else if (Math.hypot(p.x - s.x, p.y - s.y) <= R + 12) {
      used = true; p.hp -= s.dmg; inst.fx.push({ x: p.x, y: p.y, k: 'hit', at: now });
      session.events.push({ t: 'npc_hit', by: 'a pirate', hp: p.hp, at: now });
    }
    if (!used) keep.push(s);
  }
  inst.shots = keep;
  if (p.hp <= 0) { p.hp = 0; inst.over = true; inst.why = 'sunk'; }
}
function damageNpc(session, inst, n, dmg, now) {
  n.hp -= dmg; inst.fx.push({ x: n.x, y: n.y, k: 'hit', at: now });
  if (n.hp <= 0) { n.alive = false; inst.score++; session.events.push({ t: 'kill', id: n.id, kind: 'boat', loot: 0, at: now }); inst.fx.push({ x: n.x, y: n.y, k: 'boom', at: now }); }
  else session.events.push({ t: 'hit', id: n.id, hp: n.hp, at: now });
}

// ================= LAVA RUN =================
function tickLava(session, inst, dt, now) {
  const p = session.player;
  const dist = Math.max(0, inst.maxFwd);
  const speed = Math.min(270, 130 + dist * 0.028);       // the boat gets faster...
  const lavaSpeed = Math.min(150, 38 + dist * 0.018);    // ...and so does the lava
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
  // holes: a warning (bubbles) first, then the hole opens
  const interval = Math.max(0.35, 2.2 - dist / 1400) * 1000, per = 1 + Math.floor(dist / 2500);
  if (now >= inst.nextHole && dist > 250) {
    inst.nextHole = now + interval;
    for (let i = 0; i < per && inst.holes.length < 60; i++) {
      const hf = f + 260 + Math.random() * 560, b = bankAt(hf) - 70, hl = (Math.random() * 2 - 1) * b, w = toWorld(hf, hl);
      inst.holes.push({ id: 'h' + (++inst.seq), fwd: hf, x: w.x, y: w.y, r: 48 + Math.random() * 20, at: now, warn: 1700, open: 7000 });
    }
  }
  const keep = [];
  for (const h of inst.holes) {
    const age = now - h.at;
    if (age > h.warn + h.open || h.fwd < f - 800) continue;
    if (age > h.warn && Math.hypot(h.x - p.x, h.y - p.y) < h.r + R * 0.55) { inst.over = true; inst.why = 'hole'; session.events.push({ t: 'lava_sink', at: now }); inst.fx.push({ x: p.x, y: p.y, k: 'boom', at: now }); }
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
  inst.shots.push({ id: 'c' + (++inst.seq), x: p.x + c * (R + 10), y: p.y + s * (R + 10), vx: c * CFG.cannonSpeed, vy: s * CFG.cannonSpeed, left: CFG.cannonRange, npc: false, mine: true, dmg: CFG.cannonDamage });
  session.events.push({ t: 'fire', at: now });
  return { ok: true, fired: true };
}

// ---- snapshot for the client (same shape as a sea snapshot, plus scene extras)
function view(session, now, o) {
  const inst = session.arena, p = session.player;
  const v = Sea.viewWithOthers(session, [], now, o);
  v.scene = inst.kind;
  v.islets = []; v.treasures = []; v.wrecks = []; v.wildlife = []; v.minePacks = []; v.mines = []; v.chests = []; v.races = []; v.events = [];
  v.raceProgress = null; v.nearHome = false; v.team = null; v.teamInvite = null; v.others = [];
  v.shots = inst.shots.map((s) => ({ id: s.id, x: r1(s.x), y: r1(s.y), vx: r1(s.vx), vy: r1(s.vy), npc: !!s.npc, mine: !!s.mine }));
  v.fx = inst.fx.map((f) => ({ x: r1(f.x), y: r1(f.y), k: f.k, age: now - f.at }));
  if (inst.kind === 'battle') {
    v.npcs = inst.npcs.filter((n) => n.alive).map((n) => ({ id: n.id, x: r1(n.x), y: r1(n.y), vx: r1(n.vx || 0), vy: r1(n.vy || 0), facing: r2(n.facing || 0), kind: 'boat', hp: n.hp, maxHp: n.maxHp }));
    v.arena = { kind: 'battle', score: inst.score, wave: inst.wave, left: inst.npcs.filter((n) => n.alive).length + inst.queue.length, r: ARENA_R, resting: !!inst.clearAt };
  } else {
    v.npcs = [];
    v.holes = inst.holes.map((h) => ({ id: h.id, x: r1(h.x), y: r1(h.y), r: r1(h.r), state: now - h.at < h.warn ? 'warn' : 'open', age: now - h.at }));
    v.arena = { kind: 'lava', score: inst.score, lavaF: r1(inst.lavaF), w: RIVER_W, speedPct: Math.round(100 * Math.min(1, Math.max(0, inst.maxFwd) / 8000)) };
  }
  return v;
}

module.exports = { start, leave, result, tick, view, melee, cannon, FW, LT, RIVER_W, ARENA_R, bankAt };
