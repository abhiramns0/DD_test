'use strict';
// Open Sea rules + world model. PURE: no database, no sockets, no drawing.
// Shared world: one set of NPC boats, wildlife, islets and collectables for every sailor.
// Boats collide with islands and each other. Crocodiles / aggressive NPCs damage players.
// Attacks work while moving. Higher attack damage. Boat wakes rendered client-side.

const CFG = {
  worldR: 3200,
  hardR: 3600,
  homeR: 180,
  returnR: 220,
  leaveR: 260,
  speed: 165,
  npcSpeed: 70,
  wildSpeed: 55,
  tickHz: 15,
  npcBoats: 5,
  wildlife: 8,
  islets: 7,
  treasures: 10,
  playerHp: 100,
  npcBoatHp: 40,
  wildHp: 20,
  attackRange: 85,
  attackDamage: 28,
  attackCooldownMs: 700,
  lootRange: 62,
  collectRange: 62,
  aoiR: 1000,
  pvpRange: 100,
  pvpDamage: 22,
  pvpCooldownMs: 900,
  pvpReward: 1,
  emojiTtlMs: 2500,
  emojiCooldownMs: 1200,
  emojiMaxPerMin: 12,
  partyMax: 4,
  teamInviteRange: 160,
  regenSeconds: 30,
  seaCooldownMs: 30000,
  intentStaleMs: 1500,
  viewR: 1000,
  crocDamage: 8,
  crocDamageRange: 48,
  crocDamageCdMs: 900,
  npcContactDamage: 10,
  npcContactRange: 55,
  npcContactCdMs: 1100,
  boatRadius: 28,
  treasureRespawnMs: 45000,
  maxTreasures: 14,
  wreckTtlMs: 10000,
  raceEventCount: 2,
  raceCheckpoints: 5,
  raceRadius: 220,
  raceCheckpointR: 70,
  raceJoinR: 200
};

const EMOJIS = ['👋', '😂', '🏳️', '⚔️', '🤝', '⛵', '💎', '🆘', '👍', '❤️'];

function rng(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed || 'sea');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
}

function len(x, y) {
  return Math.hypot(x, y);
}

function clampToWorld(x, y) {
  const d = len(x, y);
  if (d <= CFG.hardR) return { x, y };
  const k = CFG.hardR / d;
  return { x: x * k, y: y * k };
}

let SHARED = null;
let sharedSeed = 'shared:v1';
let nextTreasureId = 1000;

function generateWorld(seed) {
  const rnd = rng(seed);
  const islets = [];
  const treasures = [];
  const used = [];
  const farEnough = (x, y, minD) => {
    if (len(x, y) < CFG.homeR + 140) return false;
    for (const u of used) if (Math.hypot(u.x - x, u.y - y) < minD) return false;
    return true;
  };
  for (let i = 0; i < CFG.islets; i++) {
    let x = 0, y = 0, ok = false;
    for (let t = 0; t < 40 && !ok; t++) {
      const a = rnd() * Math.PI * 2;
      const d = CFG.homeR + 220 + rnd() * (CFG.worldR - CFG.homeR - 280);
      x = Math.cos(a) * d;
      y = Math.sin(a) * d;
      ok = farEnough(x, y, 280);
    }
    if (!ok) continue;
    const id = 'islet_' + i;
    const r = 55 + rnd() * 45;
    islets.push({
      id, x, y, r,
      name: ['Coral Cay', 'Driftwood Key', 'Mist Atoll', 'Shell Spit', 'Gull Rock', 'Palm Speck', 'Wreck Shoal'][i % 7]
    });
    used.push({ x, y });
  }
  for (let i = 0; i < CFG.treasures; i++) {
    let x = 0, y = 0, ok = false;
    for (let t = 0; t < 40 && !ok; t++) {
      const a = rnd() * Math.PI * 2;
      const d = CFG.homeR + 160 + rnd() * (CFG.worldR - CFG.homeR - 200);
      x = Math.cos(a) * d;
      y = Math.sin(a) * d;
      ok = farEnough(x, y, 120);
    }
    if (!ok) continue;
    const id = 'tre_' + i;
    if (islets.length && rnd() < 0.45) {
      const it = islets[(rnd() * islets.length) | 0];
      const a = rnd() * Math.PI * 2;
      const d = it.r + 30 + rnd() * 50;
      x = it.x + Math.cos(a) * d;
      y = it.y + Math.sin(a) * d;
    }
    treasures.push({
      id, x, y,
      kind: rnd() < 0.2 ? 'chest' : 'crate',
      value: rnd() < 0.15 ? 3 : 1,
      collected: false,
      collectedAt: 0
    });
    used.push({ x, y });
  }
  return { seed, islets, treasures };
}

function spawnNpcs(seed, count) {
  const rnd = rng(seed + ':npc');
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const d = CFG.homeR + 300 + rnd() * (CFG.worldR - CFG.homeR - 350);
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    const facing = rnd() * Math.PI * 2;
    out.push({
      id: 'npc_' + i,
      kind: 'boat',
      x, y,
      vx: Math.cos(facing) * CFG.npcSpeed * 0.4,
      vy: Math.sin(facing) * CFG.npcSpeed * 0.4,
      facing,
      hp: CFG.npcBoatHp,
      maxHp: CFG.npcBoatHp,
      alive: true,
      loot: rnd() < 0.5 ? 1 : 0,
      aggro: rnd() < 0.35,
      contactAt: 0
    });
  }
  return out;
}

function spawnWildlife(seed, count) {
  const rnd = rng(seed + ':wild');
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const d = CFG.homeR + 200 + rnd() * (CFG.worldR - CFG.homeR - 250);
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    const type = rnd() < 0.55 ? 'croc' : 'gull';
    out.push({
      id: 'wild_' + i,
      kind: type,
      x, y,
      vx: (rnd() - 0.5) * CFG.wildSpeed,
      vy: (rnd() - 0.5) * CFG.wildSpeed,
      facing: 0,
      hp: CFG.wildHp,
      maxHp: CFG.wildHp,
      alive: true,
      loot: 0,
      aggro: type === 'croc',
      contactAt: 0
    });
  }
  return out;
}

function spawnRaces(seed) {
  const rnd = rng(seed + ':race');
  const out = [];
  for (let i = 0; i < CFG.raceEventCount; i++) {
    let x = 0, y = 0, ok = false;
    for (let t = 0; t < 50 && !ok; t++) {
      const a = rnd() * Math.PI * 2;
      const d = CFG.homeR + 500 + rnd() * (CFG.worldR - CFG.homeR - 700);
      x = Math.cos(a) * d;
      y = Math.sin(a) * d;
      ok = len(x, y) > CFG.homeR + 400;
    }
    if (!ok) continue;
    const cps = [];
    const n = CFG.raceCheckpoints;
    for (let c = 0; c < n; c++) {
      const a = (c / n) * Math.PI * 2 + rnd() * 0.4;
      const d = 180 + rnd() * 280;
      cps.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, r: CFG.raceCheckpointR });
    }
    // finish is last checkpoint, slightly larger
    cps[cps.length - 1].r = CFG.raceCheckpointR * 1.25;
    cps[cps.length - 1].finish = true;
    out.push({
      id: 'race_' + i,
      x, y,
      r: CFG.raceRadius,
      checkpoints: cps,
      entrants: {}, // uid -> { startAt, nextCp, finishedAt, name }
      board: [] // finished: { uid, name, ms }
    });
  }
  return out;
}

function ensureShared() {
  if (SHARED) return SHARED;
  const world = generateWorld(sharedSeed);
  SHARED = {
    seed: sharedSeed,
    islets: world.islets,
    treasures: world.treasures,
    npcs: spawnNpcs(sharedSeed, CFG.npcBoats),
    wildlife: spawnWildlife(sharedSeed, CFG.wildlife),
    lastTreasureSpawn: Date.now(),
    playerWrecks: [],
    races: spawnRaces(sharedSeed),
    teams: new Map() // teamId -> { id, leader, members:Set, invites:Map }
  };
  return SHARED;
}

function resetSharedForTests() {
  SHARED = null;
}

function createSession(uid, voyage, savedDiscoveries, opts) {
  ensureShared();
  const disc = normalizeDiscoveries(savedDiscoveries);
  disc.treasures = [];
  const spawnA = Math.PI * 0.25;
  const startHp =
    opts && typeof opts.hp === 'number' && isFinite(opts.hp)
      ? Math.max(1, Math.min(CFG.playerHp, opts.hp))
      : CFG.playerHp;
  const px = Math.cos(spawnA) * CFG.leaveR;
  const py = Math.sin(spawnA) * CFG.leaveR;
  return {
    uid,
    voyage,
    seed: SHARED.seed,
    startedAt: Date.now(),
    player: {
      x: px,
      y: py,
      vx: 0,
      vy: 0,
      facing: spawnA,
      hp: startHp,
      maxHp: CFG.playerHp,
      alive: true,
      attackAt: 0,
      pvpAt: 0,
      vessel: 'raft',
      contactAt: 0
    },
    islets: SHARED.islets,
    treasures: SHARED.treasures,
    npcs: SHARED.npcs,
    wildlife: SHARED.wildlife,
    intent: { mx: 0, my: 0 },
    intentAt: 0,
    staleIntent: false,
    dirty: false,
    events: [],
    discoveries: disc,
    status: 'sailing'
  };
}

function normalizeDiscoveries(raw) {
  const out = { islets: [], treasures: [], voyages: 0, treasureCount: 0 };
  if (!raw || typeof raw !== 'object') return out;
  if (Array.isArray(raw.islets))
    out.islets = raw.islets.filter((id) => typeof id === 'string').slice(0, 200);
  if (Array.isArray(raw.treasures))
    out.treasures = raw.treasures.filter((id) => typeof id === 'string').slice(0, 200);
  if (Number.isInteger(raw.voyages) && raw.voyages >= 0)
    out.voyages = Math.min(raw.voyages, 1e6);
  if (Number.isInteger(raw.treasureCount) && raw.treasureCount >= 0)
    out.treasureCount = Math.min(raw.treasureCount, 1e6);
  return out;
}

function packDiscoveries(session) {
  return {
    islets: session.discoveries.islets.slice(),
    treasures: session.discoveries.treasures.slice(),
    voyages: session.discoveries.voyages,
    treasureCount: session.discoveries.treasureCount
  };
}

function setIntent(session, mx, my, now) {
  if (!session || session.status !== 'sailing') return;
  session.intentAt = now || Date.now();
  const m = Math.hypot(mx, my);
  if (m < 0.05) {
    session.intent.mx = 0;
    session.intent.my = 0;
    return;
  }
  session.intent.mx = mx / m;
  session.intent.my = my / m;
}

function steerNpc(e, tx, ty, speed, dt) {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.hypot(dx, dy) || 1;
  const wx = (dx / d) * speed;
  const wy = (dy / d) * speed;
  // Higher accel so joystick feels immediate and smooth (no laggy catch-up)
  const k = Math.min(1, dt * 5.5);
  e.vx += (wx - e.vx) * k;
  e.vy += (wy - e.vy) * k;
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  if (Math.hypot(e.vx, e.vy) > 4) e.facing = Math.atan2(e.vy, e.vx);
  const c = clampToWorld(e.x, e.y);
  e.x = c.x;
  e.y = c.y;
}

function tickNpc(e, dt) {
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  const d = len(e.x, e.y);
  if (d > CFG.worldR) {
    const nx = e.x / d;
    const ny = e.y / d;
    e.vx -= nx * 40;
    e.vy -= ny * 40;
    e.x = nx * CFG.worldR;
    e.y = ny * CFG.worldR;
  }
  const sp = Math.hypot(e.vx, e.vy);
  if (sp < 8) {
    const a = Math.random() * Math.PI * 2;
    e.vx = Math.cos(a) * CFG.npcSpeed * 0.35;
    e.vy = Math.sin(a) * CFG.npcSpeed * 0.35;
  }
  e.facing = Math.atan2(e.vy, e.vx);
}

function resolveCircle(e, cx, cy, minDist) {
  const dx = e.x - cx;
  const dy = e.y - cy;
  const d = Math.hypot(dx, dy) || 0.001;
  if (d >= minDist) return false;
  const k = minDist / d;
  e.x = cx + dx * k;
  e.y = cy + dy * k;
  const nx = dx / d;
  const ny = dy / d;
  const vn = e.vx * nx + e.vy * ny;
  if (vn < 0) {
    e.vx -= vn * nx;
    e.vy -= vn * ny;
  }
  return true;
}

function resolveBoatBoat(a, b, r) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 0.001;
  if (d >= r * 2) return;
  const overlap = r * 2 - d;
  const nx = dx / d;
  const ny = dy / d;
  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;
  const va = a.vx * nx + a.vy * ny;
  const vb = b.vx * nx + b.vy * ny;
  if (va > 0) {
    a.vx -= va * nx * 0.6;
    a.vy -= va * ny * 0.6;
  }
  if (vb < 0) {
    b.vx -= vb * nx * 0.6;
    b.vy -= vb * ny * 0.6;
  }
}

function tickShared(dt, now, playerPositions) {
  ensureShared();
  const W = SHARED;
  cleanWrecks(now);
  for (const n of W.npcs) {
    if (!n.alive) continue;
    let target = null;
    let best = 420;
    if (n.aggro && playerPositions) {
      for (const pp of playerPositions) {
        const d = Math.hypot(n.x - pp.x, n.y - pp.y);
        if (d < best) {
          best = d;
          target = pp;
        }
      }
    }
    if (target) steerNpc(n, target.x, target.y, CFG.npcSpeed * 0.85, dt);
    else tickNpc(n, dt);
    for (const it of W.islets) resolveCircle(n, it.x, it.y, it.r + CFG.boatRadius * 0.7);
    resolveCircle(n, 0, 0, CFG.homeR + CFG.boatRadius * 0.5);
  }
  for (const w of W.wildlife) {
    if (!w.alive) continue;
    let target = null;
    let best = 280;
    if (w.kind === 'croc' && playerPositions) {
      for (const pp of playerPositions) {
        const d = Math.hypot(w.x - pp.x, w.y - pp.y);
        if (d < best) {
          best = d;
          target = pp;
        }
      }
    }
    if (target) steerNpc(w, target.x, target.y, CFG.wildSpeed, dt);
    else tickNpc(w, dt);
    for (const it of W.islets) resolveCircle(w, it.x, it.y, it.r + 20);
  }
  for (let i = 0; i < W.npcs.length; i++) {
    if (!W.npcs[i].alive) continue;
    for (let j = i + 1; j < W.npcs.length; j++) {
      if (!W.npcs[j].alive) continue;
      resolveBoatBoat(W.npcs[i], W.npcs[j], CFG.boatRadius * 0.85);
    }
  }
  if (now - W.lastTreasureSpawn > CFG.treasureRespawnMs) {
    W.lastTreasureSpawn = now;
    const live = W.treasures.filter((t) => !t.collected).length;
    if (live < CFG.maxTreasures) {
      const rnd = Math.random;
      let x = 0, y = 0, ok = false;
      for (let t = 0; t < 30 && !ok; t++) {
        const a = rnd() * Math.PI * 2;
        const d = CFG.homeR + 180 + rnd() * (CFG.worldR - CFG.homeR - 220);
        x = Math.cos(a) * d;
        y = Math.sin(a) * d;
        ok = len(x, y) > CFG.homeR + 150;
        for (const it of W.islets) {
          if (Math.hypot(it.x - x, it.y - y) < it.r + 40) ok = false;
        }
      }
      if (ok) {
        const id = 'tre_r' + nextTreasureId++;
        W.treasures.push({
          id, x, y,
          kind: rnd() < 0.25 ? 'chest' : 'crate',
          value: rnd() < 0.2 ? 3 : 1,
          collected: false,
          collectedAt: 0
        });
      }
    }
  }
  W.playerWrecks = W.playerWrecks.filter((w) => now - w.at < 12000);
}

function tick(session, dt, now) {
  if (!session || session.status !== 'sailing') return session;
  dt = Math.max(0.01, Math.min(0.1, dt));
  const p = session.player;
  if (!p.alive) return session;
  now = now || Date.now();
  if (
    session.staleIntent &&
    (session.intent.mx || session.intent.my) &&
    now - session.intentAt > CFG.intentStaleMs
  ) {
    session.intent.mx = 0;
    session.intent.my = 0;
  }
  if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + (dt * p.maxHp) / CFG.regenSeconds);

  if (session.intent.mx || session.intent.my) {
    steerNpc(p, p.x + session.intent.mx * 200, p.y + session.intent.my * 200, CFG.speed, dt);
  } else {
    p.vx *= Math.max(0, 1 - dt * 1.8);
    p.vy *= Math.max(0, 1 - dt * 1.8);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const c = clampToWorld(p.x, p.y);
    p.x = c.x;
    p.y = c.y;
  }

  for (const it of session.islets) {
    resolveCircle(p, it.x, it.y, it.r + CFG.boatRadius);
  }
  resolveCircle(p, 0, 0, CFG.homeR + CFG.boatRadius * 0.6);

  for (const n of session.npcs) {
    if (!n.alive) continue;
    resolveBoatBoat(p, n, CFG.boatRadius);
  }

  for (const w of session.wildlife) {
    if (!w.alive || w.kind !== 'croc') continue;
    const d = Math.hypot(w.x - p.x, w.y - p.y);
    if (d < CFG.crocDamageRange && now - (p.contactAt || 0) > CFG.crocDamageCdMs) {
      p.contactAt = now;
      p.hp -= CFG.crocDamage;
      session.events.push({ t: 'croc_hit', hp: p.hp, at: now });
      if (p.hp <= 0) {
        p.hp = 0;
        p.alive = false;
        session.events.push({ t: 'croc_sink', at: now });
        return session;
      }
    }
  }
  for (const n of session.npcs) {
    if (!n.alive || !n.aggro) continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < CFG.npcContactRange && now - (n.contactAt || 0) > CFG.npcContactCdMs) {
      n.contactAt = now;
      p.hp -= CFG.npcContactDamage;
      session.events.push({ t: 'npc_hit', hp: p.hp, at: now });
      if (p.hp <= 0) {
        p.hp = 0;
        p.alive = false;
        session.events.push({ t: 'npc_sink', at: now });
        return session;
      }
    }
  }

  for (const it of session.islets) {
    if (it.explored) continue;
    if (Math.hypot(it.x - p.x, it.y - p.y) < it.r + 30) {
      it.explored = true;
      session.dirty = true;
      if (!session.discoveries.islets.includes(it.id)) session.discoveries.islets.push(it.id);
      session.events.push({ t: 'explore', id: it.id, name: it.name, at: now });
    }
  }
  autoCollect(session, now);
  session.nearHome = Math.hypot(p.x, p.y) <= CFG.returnR;
  // race checkpoint progress
  const raceRes = raceTickPlayer(session.uid, p, now);
  if (raceRes) {
    if (raceRes.finished) session.events.push({ t: 'race_finish', ms: raceRes.ms, place: raceRes.place, at: now });
    else if (raceRes.checkpoint) session.events.push({ t: 'race_cp', cp: raceRes.checkpoint, at: now });
  }
  return session;
}

function autoCollect(session, now) {
  for (let i = 0; i < 6; i++) {
    const r = collectTreasure(session, now);
    if (!(r.ok || r.err === 'already')) break;
  }
  for (let i = 0; i < 4; i++) {
    const r = loot(session, now);
    if (!r.ok) break;
  }
}

function attack(session, now) {
  if (!session || session.status !== 'sailing') return { ok: false, err: 'not_sailing' };
  const p = session.player;
  if (!p.alive) return { ok: false, err: 'dead' };
  if (now < p.attackAt) return { ok: false, err: 'cooldown' };
  p.attackAt = now + CFG.attackCooldownMs;
  const look = 0.12;
  const ax = p.x + (p.vx || 0) * look;
  const ay = p.y + (p.vy || 0) * look;
  let hit = null;
  let best = CFG.attackRange;
  for (const e of [...session.npcs, ...session.wildlife].filter((e) => e.alive)) {
    const d = Math.hypot(e.x - ax, e.y - ay);
    if (d < best) {
      best = d;
      hit = e;
    }
  }
  if (!hit) {
    session.events.push({ t: 'miss', at: now });
    return { ok: true, hit: false };
  }
  hit.hp -= CFG.attackDamage;
  if (hit.hp <= 0) {
    hit.alive = false;
    hit.hp = 0;
    hit.diedAt = now;
    session.events.push({ t: 'kill', id: hit.id, kind: hit.kind, loot: hit.loot | 0, at: now });
    return { ok: true, hit: true, killed: true, id: hit.id, loot: hit.loot | 0 };
  }
  session.events.push({ t: 'hit', id: hit.id, hp: hit.hp, at: now });
  return { ok: true, hit: true, killed: false, id: hit.id, hp: hit.hp };
}

function loot(session, now) {
  if (!session || session.status !== 'sailing') return { ok: false, err: 'not_sailing' };
  const p = session.player;
  let best = null;
  let bd = CFG.lootRange;
  for (const n of session.npcs.filter((n) => !n.alive && (n.loot | 0) > 0)) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  ensureShared();
  for (const w of SHARED.playerWrecks) {
    if ((w.loot | 0) <= 0) continue;
    const d = Math.hypot(w.x - p.x, w.y - p.y);
    if (d < bd) {
      bd = d;
      best = w;
    }
  }
  if (!best) return { ok: false, err: 'nothing' };
  const gained = best.loot;
  best.loot = 0;
  session.discoveries.treasureCount += gained | 0;
  session.dirty = true;
  session.events.push({ t: 'loot', id: best.id, gained, at: now });
  return { ok: true, gained, id: best.id };
}

function collectTreasure(session, now) {
  if (!session || session.status !== 'sailing') return { ok: false, err: 'not_sailing' };
  const p = session.player;
  let best = null;
  let bd = CFG.collectRange;
  for (const t of session.treasures) {
    if (t.collected) continue;
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  if (!best) return { ok: false, err: 'nothing' };
  if (session.discoveries.treasures.includes(best.id)) {
    best.collected = true;
    return { ok: false, err: 'already' };
  }
  best.collected = true;
  best.collectedAt = now;
  session.discoveries.treasures.push(best.id);
  session.discoveries.treasureCount += (best.value | 0) || 1;
  session.dirty = true;
  session.events.push({
    t: 'treasure',
    id: best.id,
    kind: best.kind,
    value: best.value,
    at: now
  });
  return { ok: true, id: best.id, kind: best.kind, value: best.value };
}

function returnHome(session) {
  if (!session || session.status !== 'sailing') return { ok: false, err: 'not_sailing' };
  session.status = 'docked';
  session.discoveries.voyages = (session.discoveries.voyages | 0) + 1;
  return { ok: true, nearHome: !!session.nearHome, discoveries: packDiscoveries(session) };
}

function addPlayerWreck(uid, x, y, loot) {
  ensureShared();
  SHARED.playerWrecks.push({
    id: 'wreck_' + uid + '_' + Date.now(),
    x,
    y,
    loot: loot | 0,
    at: Date.now()
  });
  // keep list bounded
  if (SHARED.playerWrecks.length > 40) SHARED.playerWrecks.splice(0, SHARED.playerWrecks.length - 40);
}

function cleanWrecks(now) {
  ensureShared();
  const ttl = CFG.wreckTtlMs;
  SHARED.playerWrecks = SHARED.playerWrecks.filter((w) => now - (w.at || 0) < ttl);
}

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

function view(session, opts) {
  if (!session) return null;
  const full = !opts || opts.full !== false;
  const drain = session.events.splice(0, session.events.length);
  const p = session.player;
  const R = CFG.viewR;
  const near = (e) => Math.abs(e.x - p.x) <= R && Math.abs(e.y - p.y) <= R;
  ensureShared();
  const v = {
    proto: (opts && opts.proto) || 1,
    status: session.status,
    nearHome: !!session.nearHome,
    player: {
      x: r1(p.x),
      y: r1(p.y),
      vx: r1(p.vx || 0),
      vy: r1(p.vy || 0),
      facing: r2(p.facing || 0),
      hp: r1(p.hp),
      maxHp: p.maxHp,
      vessel: p.vessel,
      alive: p.alive
    },
    treasures: session.treasures
      .filter((t) => !t.collected && near(t))
      .map((t) => ({ id: t.id, x: r1(t.x), y: r1(t.y), kind: t.kind })),
    npcs: session.npcs
      .filter((n) => n.alive && near(n))
      .map((n) => ({
        id: n.id,
        x: r1(n.x),
        y: r1(n.y),
        vx: r1(n.vx || 0),
        vy: r1(n.vy || 0),
        facing: r2(n.facing || 0),
        kind: n.kind,
        hp: n.hp,
        maxHp: n.maxHp
      })),
    wildlife: session.wildlife
      .filter((w) => w.alive && near(w))
      .map((w) => ({
        id: w.id,
        x: r1(w.x),
        y: r1(w.y),
        vx: r1(w.vx || 0),
        vy: r1(w.vy || 0),
        facing: r2(w.facing || 0),
        kind: w.kind
      })),
    wrecks: session.npcs
      .filter((n) => !n.alive && near(n))
      .map((n) => ({ id: n.id, x: r1(n.x), y: r1(n.y), loot: n.loot | 0, at: n.diedAt || 0 }))
      .concat(
        SHARED.playerWrecks
          .filter((w) => near(w) && (Date.now() - (w.at || 0)) < CFG.wreckTtlMs)
          .map((w) => ({ id: w.id, x: r1(w.x), y: r1(w.y), loot: w.loot | 0, at: w.at || 0 }))
      ),
    events: drain,
    discoveries: {
      islets: session.discoveries.islets.length,
      treasures: session.discoveries.treasureCount,
      voyages: session.discoveries.voyages
    }
  };
  if (full) {
    v.cfg = {
      worldR: CFG.worldR,
      homeR: CFG.homeR,
      returnR: CFG.returnR,
      attackRange: CFG.attackRange,
      attackCooldownMs: CFG.attackCooldownMs,
      pvpCooldownMs: CFG.pvpCooldownMs,
      pvpRange: CFG.pvpRange,
      regenSeconds: CFG.regenSeconds,
      seaCooldownMs: CFG.seaCooldownMs
    };
    v.islets = session.islets.map((i) => ({
      id: i.id,
      x: i.x,
      y: i.y,
      r: i.r,
      name: i.name,
      explored: !!i.explored
    }));
  }
  return v;
}

function othersView(selfUid, selfX, selfY, voyagerList, now) {
  const out = [];
  for (const v of voyagerList) {
    if (!v || v.uid === selfUid || !v.player || !v.player.alive) continue;
    const d = Math.hypot(v.player.x - selfX, v.player.y - selfY);
    if (d > CFG.aoiR) continue;
    const bubble =
      v.emoji && v.emojiUntil && now < v.emojiUntil
        ? { id: v.emoji, until: v.emojiUntil }
        : null;
    out.push({
      uid: v.uid,
      name: String(v.name || 'Sailor').slice(0, 14),
      x: r1(v.player.x),
      y: r1(v.player.y),
      vx: r1(v.player.vx || 0),
      vy: r1(v.player.vy || 0),
      facing: r2(v.player.facing || 0),
      hp: r1(v.player.hp),
      maxHp: v.player.maxHp || CFG.playerHp,
      clanId: v.clanId || null,
      team: sameTeam(selfUid, v.uid),
      emoji: bubble,
      dist: Math.round(d)
    });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, 24);
}

function sameTeam(uidA, uidB) {
  if (!uidA || !uidB || uidA === uidB) return false;
  ensureShared();
  for (const team of SHARED.teams.values()) {
    if (team.members.has(uidA) && team.members.has(uidB)) return true;
  }
  return false;
}

function getTeamFor(uid) {
  ensureShared();
  for (const team of SHARED.teams.values()) {
    if (team.members.has(uid)) return team;
  }
  return null;
}

function teamInvite(fromUid, toUid, fromName, toName, fromPos, toPos) {
  ensureShared();
  if (!fromUid || !toUid || fromUid === toUid) return { ok: false, err: 'bad' };
  const d = Math.hypot((fromPos.x || 0) - (toPos.x || 0), (fromPos.y || 0) - (toPos.y || 0));
  if (d > CFG.teamInviteRange) return { ok: false, err: 'far' };
  let team = getTeamFor(fromUid);
  if (team) {
    if (team.leader !== fromUid) return { ok: false, err: 'not_leader' };
    if (team.members.size >= CFG.partyMax) return { ok: false, err: 'full' };
    if (team.members.has(toUid)) return { ok: false, err: 'already' };
  } else {
    // create provisional team led by inviter
    const id = 't_' + fromUid + '_' + Date.now();
    team = { id, leader: fromUid, members: new Set([fromUid]), invites: new Map(), names: new Map([[fromUid, fromName || 'Sailor']]) };
    SHARED.teams.set(id, team);
  }
  if (getTeamFor(toUid)) return { ok: false, err: 'target_teamed' };
  team.invites.set(toUid, { from: fromUid, name: fromName || 'Sailor', at: Date.now() });
  team.names.set(fromUid, fromName || 'Sailor');
  return { ok: true, teamId: team.id, toUid };
}

function teamAccept(uid, teamId, name) {
  ensureShared();
  const team = SHARED.teams.get(teamId);
  if (!team) return { ok: false, err: 'no_team' };
  if (!team.invites.has(uid)) return { ok: false, err: 'no_invite' };
  if (team.members.size >= CFG.partyMax) return { ok: false, err: 'full' };
  if (getTeamFor(uid)) return { ok: false, err: 'already' };
  team.invites.delete(uid);
  team.members.add(uid);
  team.names.set(uid, name || 'Sailor');
  return { ok: true, teamId, leader: team.leader, members: [...team.members] };
}

function teamLeave(uid) {
  ensureShared();
  const team = getTeamFor(uid);
  if (!team) return { ok: false, err: 'no_team' };
  team.members.delete(uid);
  team.names.delete(uid);
  team.invites.delete(uid);
  if (team.members.size === 0) {
    SHARED.teams.delete(team.id);
    return { ok: true, dissolved: true };
  }
  if (team.leader === uid) {
    // promote next member (first remaining)
    team.leader = [...team.members][0];
  }
  return { ok: true, leader: team.leader, members: [...team.members] };
}

function teamInfo(uid) {
  const team = getTeamFor(uid);
  if (!team) return null;
  return {
    id: team.id,
    leader: team.leader,
    members: [...team.members].map((m) => ({ uid: m, name: team.names.get(m) || 'Sailor', leader: m === team.leader }))
  };
}

function raceJoin(uid, name, player, raceId) {
  ensureShared();
  const race = (SHARED.races || []).find((r) => r.id === raceId);
  if (!race) return { ok: false, err: 'no_race' };
  if (race.entrants[uid] && !race.entrants[uid].finishedAt) return { ok: false, err: 'already' };
  const d = Math.hypot(player.x - race.x, player.y - race.y);
  if (d > CFG.raceJoinR) return { ok: false, err: 'far' };
  race.entrants[uid] = { startAt: Date.now(), nextCp: 0, finishedAt: 0, name: name || 'Sailor' };
  return { ok: true, raceId, checkpoints: race.checkpoints.length };
}

function raceTickPlayer(uid, player, now) {
  ensureShared();
  for (const race of SHARED.races || []) {
    const ent = race.entrants[uid];
    if (!ent || ent.finishedAt) continue;
    const cp = race.checkpoints[ent.nextCp];
    if (!cp) continue;
    if (Math.hypot(player.x - cp.x, player.y - cp.y) <= cp.r) {
      ent.nextCp++;
      if (ent.nextCp >= race.checkpoints.length) {
        ent.finishedAt = now;
        const ms = now - ent.startAt;
        race.board.push({ uid, name: ent.name, ms });
        race.board.sort((a, b) => a.ms - b.ms);
        if (race.board.length > 20) race.board.length = 20;
        return { finished: true, ms, place: race.board.findIndex((b) => b.uid === uid) + 1 };
      }
      return { checkpoint: ent.nextCp };
    }
  }
  return null;
}

function racesNear(x, y) {
  ensureShared();
  return (SHARED.races || [])
    .filter((r) => Math.hypot(r.x - x, r.y - y) < CFG.aoiR + r.r)
    .map((r) => ({
      id: r.id,
      x: r1(r.x),
      y: r1(r.y),
      r: r.r,
      checkpoints: r.checkpoints.map((c) => ({ x: r1(c.x), y: r1(c.y), r: c.r, finish: !!c.finish })),
      board: r.board.slice(0, 10),
      entrants: Object.keys(r.entrants).length
    }));
}

function pvpAttack(attackerSession, targetPlayer, now, attackerUid, targetUid) {
  if (!attackerSession || attackerSession.status !== 'sailing')
    return { ok: false, err: 'not_sailing' };
  const p = attackerSession.player;
  if (!p || !p.alive) return { ok: false, err: 'dead' };
  if (!targetPlayer || !targetPlayer.alive) return { ok: false, err: 'no_target' };
  if (attackerUid && targetUid && sameTeam(attackerUid, targetUid))
    return { ok: false, err: 'teammate' };
  if (now < (p.pvpAt || 0)) return { ok: false, err: 'cooldown' };
  const look = 0.12;
  const ax = p.x + (p.vx || 0) * look;
  const ay = p.y + (p.vy || 0) * look;
  const tx = targetPlayer.x + (targetPlayer.vx || 0) * look;
  const ty = targetPlayer.y + (targetPlayer.vy || 0) * look;
  const d = Math.hypot(tx - ax, ty - ay);
  if (d > CFG.pvpRange) return { ok: false, err: 'range' };
  p.pvpAt = now + CFG.pvpCooldownMs;
  targetPlayer.hp -= CFG.pvpDamage;
  if (targetPlayer.hp <= 0) {
    targetPlayer.hp = 0;
    targetPlayer.alive = false;
    attackerSession.events.push({ t: 'pvp_sink', at: now });
    return { ok: true, hit: true, sunk: true, damage: CFG.pvpDamage };
  }
  attackerSession.events.push({ t: 'pvp_hit', at: now, hp: targetPlayer.hp });
  return { ok: true, hit: true, sunk: false, damage: CFG.pvpDamage, hp: targetPlayer.hp };
}

function validateEmoji(id, now, meta) {
  if (!EMOJIS.includes(id)) return { ok: false, err: 'bad_emoji' };
  meta = meta || { lastAt: 0, countWindowStart: 0, countInWindow: 0 };
  if (now - meta.lastAt < CFG.emojiCooldownMs) return { ok: false, err: 'cooldown' };
  if (now - meta.countWindowStart > 60000) {
    meta.countWindowStart = now;
    meta.countInWindow = 0;
  }
  if (meta.countInWindow >= CFG.emojiMaxPerMin) return { ok: false, err: 'rate' };
  meta.lastAt = now;
  meta.countInWindow++;
  return { ok: true, meta, ttl: CFG.emojiTtlMs };
}

function viewWithOthers(session, others, now, opts) {
  const v = view(session, opts);
  if (!v) return null;
  v.others = others || [];
  const p = session.player;
  v.races = racesNear(p.x, p.y);
  v.team = teamInfo(session.uid);
  // pending invite for this player
  ensureShared();
  v.teamInvite = null;
  for (const team of SHARED.teams.values()) {
    if (team.invites.has(session.uid)) {
      const inv = team.invites.get(session.uid);
      v.teamInvite = { teamId: team.id, from: inv.from, name: inv.name };
      break;
    }
  }
  // race progress for self
  v.raceProgress = null;
  for (const race of SHARED.races || []) {
    const ent = race.entrants[session.uid];
    if (ent && !ent.finishedAt) {
      v.raceProgress = { raceId: race.id, nextCp: ent.nextCp, total: race.checkpoints.length, startAt: ent.startAt };
      break;
    }
  }
  if (!opts || opts.full !== false)
    v.mp = {
      aoiR: CFG.aoiR,
      pvpRange: CFG.pvpRange,
      emojis: EMOJIS.slice(),
      emojiTtlMs: CFG.emojiTtlMs,
      emojiCooldownMs: CFG.emojiCooldownMs,
      partyMax: CFG.partyMax,
      teamInviteRange: CFG.teamInviteRange,
      wreckTtlMs: CFG.wreckTtlMs,
      raceJoinR: CFG.raceJoinR
    };
  return v;
}

module.exports = {
  CFG,
  EMOJIS,
  createSession,
  setIntent,
  tick,
  tickShared,
  attack,
  loot,
  collectTreasure,
  returnHome,
  view,
  viewWithOthers,
  othersView,
  pvpAttack,
  validateEmoji,
  addPlayerWreck,
  cleanWrecks,
  packDiscoveries,
  normalizeDiscoveries,
  generateWorld,
  clampToWorld,
  ensureShared,
  resetSharedForTests,
  sameTeam,
  getTeamFor,
  teamInvite,
  teamAccept,
  teamLeave,
  teamInfo,
  raceJoin,
  raceTickPlayer,
  racesNear
};
