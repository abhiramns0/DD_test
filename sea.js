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
  npcBoats: 14,            // density of NPC boats (was 5)
  npcAggroShare: 0.75,     // 75% of NPC boats are hostile; the rest only wander and run away when attacked
  mineMax: 3,
  mineDamage: 85,          // a player boat has 100 hp: a mine almost destroys it
  mineTtlMs: 30000,
  mineArmMs: 900,
  mineFuseMs: 500,         // a touched mine goes red at once and blasts this long after
  mineTriggerR: 64,        // a boat this close sets a mine off
  mineBlastR: 125,         // everything inside this radius is hit (less at the edge)
  mineDropBack: 72,        // dropped this far behind the boat
  mineDropCdMs: 1200,
  minePacks: 20,            // mine pick-ups floating in the open sea
  minePackRespawnMs: 12000,
  npcRespawnMs: 14000,     // a destroyed NPC boat is replaced after this long (the sea is never left empty)
  cannonCooldownMs: 800,
  wildlife: 8,
  islets: 7,
  treasures: 10,
  playerHp: 100,
  npcBoatHp: 40,
  wildHp: 20,
  attackRange: 85,
  attackDamage: 10,        // proximity attack: weak (the cannon is the big gun)
  attackCooldownMs: 800,
  cannonSpeed: 560,        // cannonball speed (world units / s)
  cannonRange: 430,        // how far a ball flies before it splashes down
  cannonHitR: 34,          // a ball hits any boat / animal this close to its path
  cannonDamage: 40,        // vs NPC boats and wildlife (NPC boat hp is 40)
  cannonPlayerDamage: 32,  // vs other sailors
  npcShotDamage: 8,
  npcShotCdMs: 2300,
  npcShootRange: 340,
  lootRange: 62,
  collectRange: 62,
  aoiR: 1000,
  pvpRange: 100,
  pvpDamage: 9,
  pvpCooldownMs: 900,
  pvpReward: 1,
  emojiTtlMs: 2500,
  emojiCooldownMs: 1200,
  emojiMaxPerMin: 12,
  partyMax: 4,
  teamInviteRange: 160,
  regenSeconds: 30,
  seaCooldownMs: 30000,
  intentStaleMs: 900,
  viewR: 1000,
  crocDamage: 8,
  crocDamageRange: 48,
  crocDamageCdMs: 900,
  npcContactDamage: 10,
  npcContactRange: 74,     // must be larger than 2 x boatRadius (56): boats push each other apart at that distance, so the old 55 never triggered
  npcContactCdMs: 1100,
  boatRadius: 28,
  treasureRespawnMs: 45000,
  maxTreasures: 14,
  wreckTtlMs: 10000,
  raceEventCount: 2,
  raceCheckpoints: 5,
  raceRadius: 220,
  raceCheckpointR: 70,
  raceJoinR: 200,
  raceCountdownMs: 3000,
  invBase: 20,          // gems / gold a boat can carry at level 1 (each); +invPerLevel per extra experience level
  invPerLevel: 5,
  chestRange: 85,       // how close to an islet's shore a boat must be to open its chest
  chestSpeed: 45,       // ...and it must be (nearly) stopped
  chestRestMs: 90000,   // an opened chest rests this long
  chestMin: 1,
  chestMax: 10,
  dropTtlMs: 30000      // resources dropped by 'Leave Sea' stay floating this long
};
const treasuryCap = (level) => 200 + 50 * Math.max(0, (level | 0) - 1); // keep in sync with island.js goldCap()
const invCap = (level) => CFG.invBase + CFG.invPerLevel * Math.max(0, (level | 0) - 1);

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
      chestAt: 0,
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
      aggro: rnd() < CFG.npcAggroShare, // hostile boats chase, ram and shoot; the others wander and flee when attacked
      fleeUntil: 0, fleeX: 0, fleeY: 0,
      shotAt: 0,
      contactAt: 0
    });
  }
  return out;
}

function spawnMinePacks(seed) {
  const rnd = rng(seed + ':mines'), out = [];
  for (let i = 0; i < CFG.minePacks; i++) {
    const a = rnd() * Math.PI * 2, d = CFG.homeR + 200 + rnd() * (CFG.worldR - CFG.homeR - 260);
    out.push({ id: 'mp_' + i, x: Math.cos(a) * d, y: Math.sin(a) * d, taken: false, takenAt: 0 });
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
    const names = ['Coral Circuit', 'Storm Loop', 'Treasure Run', 'Gale Trail'];
    out.push({
      id: 'race_' + i,
      name: names[i % names.length],
      x, y,
      r: CFG.raceRadius,
      checkpoints: cps,
      entrants: {}, // uid -> { startAt, nextCp, finishedAt, name }
      board: [] // best times only: { uid, name, ms }
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
    events: [
      { id: 'battle', name: 'Battle Arena', emoji: '⚔️', x: 948, y: -649, r: 210, board: [] },
      { id: 'lava', name: 'Lava Run', emoji: '💀', x: -1001, y: 748, r: 210, board: [] }
    ],
    playerWrecks: [],
    shots: [],
    fx: [],
    mines: [],
    minePacks: spawnMinePacks(sharedSeed),
    lastMinePack: Date.now(),
    races: spawnRaces(sharedSeed),
    teams: new Map(), // teamId -> { id, leader, members:Set, names:Map }
    teamInvites: new Map() // toUid -> { from, name, teamId|null, at }  (a team only exists once an invite was ACCEPTED)
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
    level: Math.max(1, (opts && opts.level) | 0 || 1),
    inv: { gems: 0, gold: 0 },
    mines: 0,
    fullAt: { gems: 0, gold: 0 },
    status: 'sailing'
  };
}

function normalizeDiscoveries(raw) {
  const out = { islets: [], treasures: [], voyages: 0, treasureCount: 0, gold: 0 };
  if (!raw || typeof raw !== 'object') return out;
  if (Array.isArray(raw.islets))
    out.islets = raw.islets.filter((id) => typeof id === 'string').slice(0, 200);
  if (Array.isArray(raw.treasures))
    out.treasures = raw.treasures.filter((id) => typeof id === 'string').slice(0, 200);
  if (Number.isInteger(raw.voyages) && raw.voyages >= 0)
    out.voyages = Math.min(raw.voyages, 1e6);
  if (Number.isInteger(raw.treasureCount) && raw.treasureCount >= 0)
    out.treasureCount = Math.min(raw.treasureCount, 1e6);
  if (Number.isInteger(raw.gold) && raw.gold >= 0) out.gold = Math.min(raw.gold, 1e6);
  return out;
}

function packDiscoveries(session) {
  return {
    islets: session.discoveries.islets.slice(),
    treasures: session.discoveries.treasures.slice(),
    voyages: session.discoveries.voyages,
    treasureCount: session.discoveries.treasureCount,
    gold: session.discoveries.gold | 0
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

let shotSeq = 0;
let fxSeq = 0;
// distance from point (qx,qy) to the segment (ax,ay)-(bx,by): shots are swept so fast balls / point-blank shots never tunnel through a boat
function segDist(ax, ay, bx, by, qx, qy) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 1e-6 ? ((qx - ax) * dx + (qy - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - qx, ay + dy * t - qy);
}
function scare(e, fx, fy, now) { // an attacked peaceful boat flees from the attacker for a while
  if (e && e.kind === 'boat' && !e.aggro) { e.fleeUntil = now + 9000; e.fleeX = fx; e.fleeY = fy; }
}
function tickShared(dt, now, playerPositions) {
  ensureShared();
  const W = SHARED;
  cleanWrecks(now);
  for (const t of W.minePacks) { // every taken mine pick-up comes back somewhere else after a while
    if (t.taken && now - t.takenAt > CFG.minePackRespawnMs) {
      const a = Math.random() * Math.PI * 2, d = CFG.homeR + 200 + Math.random() * (CFG.worldR - CFG.homeR - 260);
      t.x = Math.cos(a) * d; t.y = Math.sin(a) * d; t.taken = false;
    }
  }
  for (const n of W.npcs) { // destroyed NPC boats are replaced, out of sight of every sailor, so the sea always has traffic
    if (n.alive || now - (n.diedAt || 0) < CFG.npcRespawnMs) continue;
    let x = 0, y = 0;
    for (let tries = 0; tries < 20; tries++) {
      const a = Math.random() * Math.PI * 2, d = CFG.homeR + 300 + Math.random() * (CFG.worldR - CFG.homeR - 350);
      x = Math.cos(a) * d; y = Math.sin(a) * d;
      if (!playerPositions.some((pp) => Math.hypot(pp.x - x, pp.y - y) < 750)) break;
    }
    const f = Math.random() * Math.PI * 2;
    Object.assign(n, {
      x, y, vx: Math.cos(f) * CFG.npcSpeed * 0.4, vy: Math.sin(f) * CFG.npcSpeed * 0.4, facing: f,
      hp: CFG.npcBoatHp, maxHp: CFG.npcBoatHp, alive: true, loot: Math.random() < 0.5 ? 1 : 0,
      aggro: Math.random() < CFG.npcAggroShare, fleeUntil: 0, shotAt: 0, contactAt: 0, diedAt: 0
    });
  }
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
    if (!n.aggro && now < (n.fleeUntil || 0)) { // peaceful boats run from whoever attacked them
      steerNpc(n, n.x + (n.x - n.fleeX) * 3, n.y + (n.y - n.fleeY) * 3, CFG.npcSpeed * 1.05, dt);
    } else if (target) {
      steerNpc(n, target.x, target.y, CFG.npcSpeed * 0.85, dt);
      if (best < CFG.npcShootRange && now - (n.shotAt || 0) > CFG.npcShotCdMs) { // pirates fire their cannon at sailors in range
        n.shotAt = now + Math.random() * 500;
        const lead = best / CFG.cannonSpeed;
        const ang = Math.atan2(target.y + (target.vy || 0) * lead - n.y, target.x + (target.vx || 0) * lead - n.x) + (Math.random() - 0.5) * 0.14;
        W.shots.push({
          id: 'n' + (++shotSeq), px: n.x, py: n.y, x: n.x + Math.cos(ang) * (CFG.boatRadius + 10), y: n.y + Math.sin(ang) * (CFG.boatRadius + 10),
          vx: Math.cos(ang) * CFG.cannonSpeed * 0.85, vy: Math.sin(ang) * CFG.cannonSpeed * 0.85,
          left: CFG.npcShootRange + 60, owner: n.id, ownerName: 'a pirate', npc: true, dmg: CFG.npcShotDamage
        });
        if (W.shots.length > 80) W.shots.splice(0, W.shots.length - 80);
      }
    } else tickNpc(n, dt);
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
  if (session.nearHome && (session.inv.gems || session.inv.gold)) {
    const dep = deposit(session); // arriving at the home island banks everything you carry
    if (dep.gems || dep.gold) session.events.push({ t: 'deposit', gems: dep.gems, gold: dep.gold, at: now });
    if (dep.held) noteFull(session, 'treasury', now);
  }
  // race checkpoint progress
  const raceRes = raceTickPlayer(session.uid, p, now);
  if (raceRes) {
    if (raceRes.finished) session.events.push({ t: 'race_finish', ms: raceRes.ms, place: raceRes.place, at: now });
    else if (raceRes.checkpoint) session.events.push({ t: 'race_cp', cp: raceRes.checkpoint, at: now });
  }
  return session;
}

// ---- inventory: boats carry a limited amount of gems and gold until they are deposited at home ----
function invSpace(session, what) {
  return Math.max(0, invCap(session.level) - (session.inv[what] | 0));
}
function noteFull(session, what, now) {
  if (now - (session.fullAt[what] || 0) > 3000) {
    session.fullAt[what] = now;
    session.events.push({ t: 'full', what, at: now });
  }
}
// moves everything carried into the saved totals (home island deposit / docking)
function deposit(session) {
  const g = session.inv.gems | 0;
  const room = Math.max(0, treasuryCap(session.level) - (session.discoveries.gold | 0));
  const c = Math.min(session.inv.gold | 0, room);      // the island treasury has a level-based limit
  const held = (session.inv.gold | 0) - c;             // gold that did not fit stays in the boat
  if (!g && !c) return { gems: 0, gold: 0, held };
  session.discoveries.treasureCount += g;
  session.discoveries.gold = (session.discoveries.gold | 0) + c;
  session.inv.gems = 0;
  session.inv.gold = held;
  session.dirty = true;
  return { gems: g, gold: c, held };
}

function autoCollect(session, now) {
  collectMinePack(session, now);
  for (let i = 0; i < 6; i++) {
    const r = collectTreasure(session, now);
    if (!(r.ok || r.err === 'already')) break;
  }
  for (let i = 0; i < 4; i++) {
    const r = loot(session, now);
    if (!r.ok) break;
  }
}

// ---- mines: a limited stock carried by each boat, picked up from the open sea, dropped behind the boat, gone after 30 s
function dropMine(session, uid, name, now) {
  if (!session || session.status !== 'sailing') return { ok: false, err: 'not_sailing' };
  const p = session.player;
  if (!p.alive) return { ok: false, err: 'dead' };
  if ((session.mines | 0) <= 0) return { ok: false, err: 'no_mines' };
  if (now < (p.mineAt || 0)) return { ok: false, err: 'cooldown' };
  p.mineAt = now + CFG.mineDropCdMs;
  ensureShared();
  const f = p.facing || 0;
  SHARED.mines.push({
    id: 'm' + (++shotSeq), owner: uid, ownerName: String(name || 'Sailor').slice(0, 14), at: now,
    x: p.x - Math.cos(f) * CFG.mineDropBack, y: p.y - Math.sin(f) * CFG.mineDropBack
  });
  if (SHARED.mines.length > 60) SHARED.mines.shift();
  session.mines -= 1;
  session.events.push({ t: 'mine_drop', at: now });
  return { ok: true, mines: session.mines };
}

function collectMinePack(session, now) {
  const p = session.player;
  ensureShared();
  for (const m of SHARED.minePacks) {
    if (m.taken || Math.hypot(m.x - p.x, m.y - p.y) > CFG.collectRange) continue;
    if ((session.mines | 0) >= CFG.mineMax) { noteFull(session, 'mines', now); return; }
    m.taken = true; m.takenAt = now;
    session.mines = (session.mines | 0) + 1;
    session.events.push({ t: 'mine_pick', at: now });
    return;
  }
}

function tickMines(now, sess) {
  const W = SHARED;
  W.mines = W.mines.filter((m) => now - m.at < CFG.mineTtlMs);
  const keep = [];
  const falloff = (d) => (d <= CFG.mineTriggerR ? 1 : Math.max(0.35, 1 - 0.45 * (d - CFG.mineTriggerR) / Math.max(1, CFG.mineBlastR - CFG.mineTriggerR)));
  for (const m of W.mines) {
    let trig = !!m.trigAt && now - m.trigAt >= CFG.mineFuseMs;
    if (!m.trigAt && now - m.at >= CFG.mineArmMs) {
      for (const [, slot] of sess) {
        const ps = slot && slot.session;
        if (ps && ps.status === 'sailing' && !ps.arena && ps.player.alive && Math.hypot(ps.player.x - m.x, ps.player.y - m.y) <= CFG.mineTriggerR) { m.trigAt = now; break; }
      }
      if (!m.trigAt) for (const e of W.npcs) if (e.alive && Math.hypot(e.x - m.x, e.y - m.y) <= CFG.mineTriggerR) { m.trigAt = now; break; }
    }
    if (!trig) { keep.push(m); continue; }
    W.fx.push({ id: ++fxSeq, x: m.x, y: m.y, k: 'boom', at: now });
    for (const [uid, slot] of sess) { // blast: everything inside the radius is hurt, a little less towards the edge
      const ps = slot && slot.session;
      if (!ps || ps.status !== 'sailing' || ps.arena || !ps.player.alive) continue;
      const pl = ps.player, d = Math.hypot(pl.x - m.x, pl.y - m.y);
      if (d > CFG.mineBlastR) continue;
      pl.hp -= CFG.mineDamage * falloff(d);
      ps.events.push({ t: 'mine_hit', by: m.ownerName, hp: pl.hp, at: now });
      if (pl.hp <= 0) { pl.hp = 0; pl.alive = false; pl.sunkBy = uid === m.owner ? null : m.ownerName; }
    }
    for (const e of [...W.npcs, ...W.wildlife]) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - m.x, e.y - m.y);
      if (d > CFG.mineBlastR) continue;
      e.hp -= CFG.mineDamage * falloff(d);
      if (e.hp <= 0) {
        e.alive = false; e.hp = 0; e.diedAt = now;
        const o = sess.get(m.owner);
        if (o && o.session) o.session.events.push({ t: 'kill', id: e.id, kind: e.kind, loot: e.loot | 0, at: now });
      }
    }
  }
  W.mines = keep;
}

// ---- cannon: Attack fires a ball straight ahead of the bow. Balls are simulated here for everyone (players and NPC pirates).
function fireCannon(session, uid, name, now) {
  if (!session || session.status !== 'sailing') return { ok: false, err: 'not_sailing' };
  const p = session.player;
  if (!p.alive) return { ok: false, err: 'dead' };
  if (now < (p.cannonAt || 0)) return { ok: false, err: 'cooldown' };
  p.cannonAt = now + CFG.cannonCooldownMs;
  ensureShared();
  const f = p.facing || 0, c = Math.cos(f), s = Math.sin(f);
  SHARED.shots.push({
    id: 'c' + (++shotSeq), px: p.x, py: p.y, x: p.x + c * (CFG.boatRadius * 0.6), y: p.y + s * (CFG.boatRadius * 0.6),
    vx: c * CFG.cannonSpeed, vy: s * CFG.cannonSpeed, left: CFG.cannonRange,
    owner: uid, ownerName: String(name || 'Sailor').slice(0, 14), npc: false, dmg: CFG.cannonDamage
  });
  if (SHARED.shots.length > 80) SHARED.shots.splice(0, SHARED.shots.length - 80);
  session.events.push({ t: 'fire', at: now });
  return { ok: true, fired: true };
}

// sess: Map uid -> { session }. Returns nothing: sunk players get player.alive=false + player.sunkBy and the server ends their voyage.
function tickShots(dt, now, sess) {
  ensureShared();
  const W = SHARED;
  W.fx = W.fx.filter((f) => now - f.at < 900);
  const keep = [];
  for (const s of W.shots) {
    const ox = s.px === undefined ? s.x : s.px, oy = s.py === undefined ? s.y : s.py; // segment start (shooter centre on the first tick)
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.left -= Math.hypot(s.vx, s.vy) * dt;
    if (s.left <= 0) {
      W.fx.push({ x: s.x, y: s.y, k: 'splash', at: now });
      continue;
    }
    if (Math.hypot(s.x, s.y) < CFG.homeR * 0.85 || W.islets.some((it) => Math.hypot(s.x - it.x, s.y - it.y) < it.r * 0.85)) {
      W.fx.push({ x: s.x, y: s.y, k: 'splash', at: now });
      continue;
    }
    const owner = !s.npc && sess.get(s.owner) ? sess.get(s.owner).session : null;
    let used = false;
    const mi = W.mines.findIndex((m) => Math.hypot(m.x - s.x, m.y - s.y) < 28); // a ball that touches a mine detonates it
    if (mi >= 0) {
      const m = W.mines[mi];
      W.mines.splice(mi, 1);
      W.fx.push({ id: ++fxSeq, x: m.x, y: m.y, k: 'boom', at: now });
      continue;
    }
    if (!s.npc) {
      for (const e of [...W.npcs, ...W.wildlife]) {
        if (!e.alive || segDist(ox, oy, s.x, s.y, e.x, e.y) > CFG.cannonHitR) continue;
        e.hp -= s.dmg;
        W.fx.push({ x: e.x, y: e.y, k: 'hit', at: now });
        if (owner) scare(e, owner.player.x, owner.player.y, now); else scare(e, s.x - s.vx, s.y - s.vy, now);
        if (e.hp <= 0) {
          e.alive = false; e.hp = 0; e.diedAt = now;
          if (owner) owner.events.push({ t: 'kill', id: e.id, kind: e.kind, loot: e.loot | 0, at: now });
        } else if (owner) owner.events.push({ t: 'hit', id: e.id, hp: e.hp, at: now });
        used = true;
        break;
      }
    }
    if (!used) {
      for (const [uid, slot] of sess) {
        const ps = slot && slot.session;
        if (!ps || ps.status !== 'sailing' || ps.arena || !ps.player.alive || uid === s.owner) continue;
        if (!s.npc && sameTeam(s.owner, uid)) continue;
        const pl = ps.player;
        if (segDist(ox, oy, s.x, s.y, pl.x, pl.y) > CFG.boatRadius + 12) continue;
        const dmg = s.npc ? s.dmg : CFG.cannonPlayerDamage;
        pl.hp -= dmg;
        W.fx.push({ x: pl.x, y: pl.y, k: 'hit', at: now });
        ps.events.push({ t: s.npc ? 'npc_hit' : 'cannon_hurt', by: s.ownerName, hp: pl.hp, at: now });
        if (pl.hp <= 0) {
          pl.hp = 0; pl.alive = false; pl.sunkBy = s.npc ? null : s.ownerName;
          if (owner) owner.events.push({ t: 'pvp_sink', at: now });
        } else if (owner) owner.events.push({ t: 'pvp_hit', hp: pl.hp, at: now });
        used = true;
        break;
      }
    }
    if (!used) { s.px = s.x; s.py = s.y; keep.push(s); }
  }
  W.shots = keep;
  tickMines(now, sess);
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
  scare(hit, p.x, p.y, now);
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
  const has = (e) => ((e.gems | 0) + (e.gold | 0) > 0);
  for (const n of session.npcs.filter((n) => !n.alive && (n.loot | 0) > 0)) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bd) {
      bd = d;
      best = { ref: n, npc: true, gems: n.loot | 0, gold: 0 };
    }
  }
  ensureShared();
  for (const w of SHARED.playerWrecks) {
    if (!has(w) || now - (w.at || 0) >= (w.ttl || CFG.wreckTtlMs)) continue;
    const d = Math.hypot(w.x - p.x, w.y - p.y);
    if (d < bd) {
      bd = d;
      best = { ref: w, npc: false, gems: w.gems | 0, gold: w.gold | 0 };
    }
  }
  if (!best) return { ok: false, err: 'nothing' };
  const takeG = Math.min(best.gems, invSpace(session, 'gems'));
  const takeC = Math.min(best.gold, invSpace(session, 'gold'));
  if (takeG <= 0 && takeC <= 0) {
    if (best.gems > 0) noteFull(session, 'gems', now);
    if (best.gold > 0) noteFull(session, 'gold', now);
    return { ok: false, err: 'full' };
  }
  if (best.npc) best.ref.loot = (best.ref.loot | 0) - takeG;
  else {
    best.ref.gems = (best.ref.gems | 0) - takeG;
    best.ref.gold = (best.ref.gold | 0) - takeC;
  }
  session.inv.gems += takeG;
  session.inv.gold += takeC;
  session.events.push({ t: 'loot', id: best.ref.id, gems: takeG, gold: takeC, gained: takeG + takeC, at: now });
  return { ok: true, gems: takeG, gold: takeC, gained: takeG + takeC, id: best.ref.id };
}

// Island chest: stop next to an islet, open it for 1-10 gold, then it rests for a while.
function chestInRange(session, it) {
  const p = session.player;
  return (
    Math.hypot(it.x - p.x, it.y - p.y) <= it.r + CFG.chestRange &&
    Math.hypot(p.vx || 0, p.vy || 0) <= CFG.chestSpeed
  );
}
function openChest(session, id, now) {
  if (!session || session.status !== 'sailing') return { ok: false, err: 'not_sailing' };
  if (!session.player.alive) return { ok: false, err: 'dead' };
  const it = session.islets.find((i) => i.id === id);
  if (!it) return { ok: false, err: 'no_chest' };
  if (!chestInRange(session, it)) return { ok: false, err: 'far' };
  if (now < (it.chestAt || 0)) return { ok: false, err: 'resting', waitMs: it.chestAt - now };
  const space = invSpace(session, 'gold');
  if (space <= 0) {
    noteFull(session, 'gold', now);
    return { ok: false, err: 'full' };
  }
  const roll = CFG.chestMin + Math.floor(Math.random() * (CFG.chestMax - CFG.chestMin + 1));
  const gold = Math.min(space, roll);
  it.chestAt = now + CFG.chestRestMs;
  session.inv.gold += gold;
  session.events.push({ t: 'chest', id, gold, at: now });
  return { ok: true, gold, id };
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
  const space = invSpace(session, 'gems');
  if (space <= 0) {
    noteFull(session, 'gems', now); // bag full: the gem stays in the water until you deposit at home
    return { ok: false, err: 'full' };
  }
  const val = Math.min(space, (best.value | 0) || 1);
  best.collected = true;
  best.collectedAt = now;
  session.discoveries.treasures.push(best.id);
  session.inv.gems += val;
  session.events.push({
    t: 'treasure',
    id: best.id,
    kind: best.kind,
    value: val,
    at: now
  });
  return { ok: true, id: best.id, kind: best.kind, value: val };
}

// mode: 'dock' (bank everything) | 'leave' (half of the cargo is lost to the sea, the rest is banked) | 'sunk' (all cargo is lost)
function returnHome(session, opts) {
  if (!session || session.status !== 'sailing') return { ok: false, err: 'not_sailing' };
  const mode = (opts && opts.mode) || 'dock';
  let dropped = null;
  let held = 0;
  if (mode === 'dock') held = deposit(session).held;
  else if (mode === 'leave') {
    const dg = Math.ceil((session.inv.gems | 0) / 2);
    const dc = Math.ceil((session.inv.gold | 0) / 2);
    session.inv.gems -= dg;
    session.inv.gold -= dc;
    held = deposit(session).held;
    dropped = { gems: dg, gold: dc };
  } else if (mode === 'sunk') {
    dropped = { gems: session.inv.gems | 0, gold: session.inv.gold | 0 };
    session.inv.gems = 0;
    session.inv.gold = 0;
  }
  session.status = 'docked';
  session.discoveries.voyages = (session.discoveries.voyages | 0) + 1;
  return { ok: true, nearHome: !!session.nearHome, discoveries: packDiscoveries(session), dropped, held };
}

// res: { gems, gold } carried by the boat (or a plain gem count); ttlMs: how long it floats (default wreckTtlMs)
function addPlayerWreck(uid, x, y, res, ttlMs) {
  ensureShared();
  const r = typeof res === 'number' ? { gems: res, gold: 0 } : res || {};
  SHARED.playerWrecks.push({
    id: 'wreck_' + uid + '_' + Date.now(),
    x,
    y,
    gems: r.gems | 0,
    gold: r.gold | 0,
    ttl: ttlMs || CFG.wreckTtlMs,
    at: Date.now()
  });
  // keep list bounded
  if (SHARED.playerWrecks.length > 40) SHARED.playerWrecks.splice(0, SHARED.playerWrecks.length - 40);
}

function cleanWrecks(now) {
  ensureShared();
  SHARED.playerWrecks = SHARED.playerWrecks.filter((w) => now - (w.at || 0) < (w.ttl || CFG.wreckTtlMs));
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
      .map((n) => ({
        id: n.id, x: r1(n.x), y: r1(n.y), loot: n.loot | 0, gems: n.loot | 0, gold: 0,
        left: Math.max(0, CFG.wreckTtlMs - (Date.now() - (n.diedAt || 0)))
      }))
      .concat(
        SHARED.playerWrecks
          .filter((w) => near(w) && Date.now() - (w.at || 0) < (w.ttl || CFG.wreckTtlMs))
          .map((w) => ({
            id: w.id, x: r1(w.x), y: r1(w.y), gems: w.gems | 0, gold: w.gold | 0, loot: (w.gems | 0) + (w.gold | 0),
            left: Math.max(0, (w.ttl || CFG.wreckTtlMs) - (Date.now() - (w.at || 0)))
          }))
      ),
    shots: SHARED.shots.filter((s) => near(s)).map((s) => ({ id: s.id, x: r1(s.x), y: r1(s.y), vx: r1(s.vx), vy: r1(s.vy), npc: !!s.npc, mine: s.owner === session.uid })),
    fx: SHARED.fx.filter((f) => near(f)).map((f) => ({ id: f.id || 0, x: r1(f.x), y: r1(f.y), k: f.k, age: Date.now() - f.at })),
    mines: SHARED.mines.filter((m) => near(m)).map((m) => ({ id: m.id, x: r1(m.x), y: r1(m.y), mine: m.owner === session.uid, age: Date.now() - m.at, trig: m.trigAt ? Date.now() - m.trigAt : -1 })),
    minePacks: SHARED.minePacks.filter((m) => !m.taken && near(m)).map((m) => ({ id: m.id, x: r1(m.x), y: r1(m.y) })),
    inv: { mines: session.mines | 0, maxMines: CFG.mineMax, gems: session.inv.gems | 0, gold: session.inv.gold | 0, cap: invCap(session.level), level: session.level },
    chests: session.islets
      .filter((it) => Math.abs(it.x - p.x) <= R + it.r && Math.abs(it.y - p.y) <= R + it.r)
      .map((it) => ({
        id: it.id,
        ready: Date.now() >= (it.chestAt || 0),
        inRange: chestInRange(session, it)
      })),
    events: drain,
    discoveries: {
      islets: session.discoveries.islets.length,
      treasures: session.discoveries.treasureCount,
      gold: session.discoveries.gold | 0,
      voyages: session.discoveries.voyages
    }
  };
  if (full) {
    v.cfg = {
      worldR: CFG.worldR,
      homeR: CFG.homeR,
      returnR: CFG.returnR,
      speed: CFG.speed,
      attackRange: CFG.attackRange,
      attackCooldownMs: CFG.attackCooldownMs,
      cannonCooldownMs: CFG.cannonCooldownMs,
      cannonSpeed: CFG.cannonSpeed,
      cannonRange: CFG.cannonRange,
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
      teamed: !!getTeamFor(v.uid),
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

const INVITE_TTL_MS = 60000;
function pendingInvite(uid) {
  ensureShared();
  const inv = SHARED.teamInvites.get(uid);
  if (!inv) return null;
  if (Date.now() - inv.at > INVITE_TTL_MS) {
    SHARED.teamInvites.delete(uid);
    return null;
  }
  return inv;
}

// Any team member (not only the leader) can invite. Inviting never creates a team: that only happens on accept.
function teamInvite(fromUid, toUid, fromName, toName, fromPos, toPos) {
  ensureShared();
  if (!fromUid || !toUid || fromUid === toUid) return { ok: false, err: 'bad' };
  const d = Math.hypot((fromPos.x || 0) - (toPos.x || 0), (fromPos.y || 0) - (toPos.y || 0));
  if (d > CFG.teamInviteRange) return { ok: false, err: 'far' };
  const team = getTeamFor(fromUid);
  if (team) {
    if (team.members.has(toUid)) return { ok: false, err: 'already' };
    if (team.members.size >= CFG.partyMax) return { ok: false, err: 'full' };
  }
  if (getTeamFor(toUid)) return { ok: false, err: 'target_teamed' };
  SHARED.teamInvites.set(toUid, { from: fromUid, name: fromName || 'Sailor', teamId: team ? team.id : null, at: Date.now() });
  return { ok: true, teamId: team ? team.id : 'p_' + fromUid, toUid };
}

function teamAccept(uid, teamId, name) {
  ensureShared();
  const inv = pendingInvite(uid);
  if (!inv) return { ok: false, err: 'no_invite' };
  if (getTeamFor(uid)) {
    SHARED.teamInvites.delete(uid);
    return { ok: false, err: 'already' };
  }
  // the inviter's CURRENT team (they may have joined / left one since inviting)
  let team = getTeamFor(inv.from);
  if (!team) {
    // (an inviter who left the sea had their invites removed in teamLeave)
    const id = 't_' + inv.from + '_' + Date.now();
    team = { id, leader: inv.from, members: new Set([inv.from]), names: new Map([[inv.from, inv.name || 'Sailor']]) };
  }
  if (team.members.size >= CFG.partyMax) {
    SHARED.teamInvites.delete(uid);
    return { ok: false, err: 'full' };
  }
  SHARED.teams.set(team.id, team);
  SHARED.teamInvites.delete(uid);
  team.members.add(uid);
  team.names.set(uid, name || 'Sailor');
  return { ok: true, teamId: team.id, leader: team.leader, members: [...team.members] };
}

function teamDecline(uid) {
  ensureShared();
  SHARED.teamInvites.delete(uid);
  return { ok: true };
}

// removes uid from its team; a team of one is dissolved (so nobody is stuck in an empty team)
function removeFromTeam(team, uid) {
  team.members.delete(uid);
  team.names.delete(uid);
  if (team.members.size <= 1) {
    const rest = [...team.members];
    SHARED.teams.delete(team.id);
    return { ok: true, dissolved: true, members: rest, leader: null };
  }
  if (team.leader === uid) team.leader = [...team.members][0]; // promote the next member
  return { ok: true, leader: team.leader, members: [...team.members] };
}

function teamLeave(uid) {
  ensureShared();
  SHARED.teamInvites.delete(uid);
  for (const [to, inv] of SHARED.teamInvites) if (inv.from === uid) SHARED.teamInvites.delete(to);
  const team = getTeamFor(uid);
  if (!team) return { ok: false, err: 'no_team' };
  return removeFromTeam(team, uid);
}

// only the team leader can remove somebody
function teamKick(leaderUid, targetUid) {
  ensureShared();
  const team = getTeamFor(leaderUid);
  if (!team) return { ok: false, err: 'no_team' };
  if (team.leader !== leaderUid) return { ok: false, err: 'not_leader' };
  if (!targetUid || targetUid === leaderUid || !team.members.has(targetUid)) return { ok: false, err: 'no_target' };
  const r = removeFromTeam(team, targetUid);
  r.kicked = targetUid;
  return r;
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

// ---- race leaderboard persistence (storage lives in race-store.js; this file stays pure) ----
let boardSaver = null;
function setBoardSaver(fn) {
  boardSaver = typeof fn === 'function' ? fn : null;
}
// rows: [{ raceId, uid, name, ms }] read from the database at start-up
function loadRaceBoards(rows) {
  ensureShared();
  for (const row of rows || []) {
    const race = SHARED.races.find((r) => r.id === row.raceId);
    if (!race || !row.uid || !(row.ms > 0)) continue;
    const i = race.board.findIndex((b) => b.uid === row.uid);
    if (i >= 0) {
      if (row.ms < race.board[i].ms) race.board[i] = { uid: row.uid, name: row.name, ms: row.ms };
    } else race.board.push({ uid: row.uid, name: row.name, ms: row.ms });
  }
  for (const race of SHARED.races) {
    race.board.sort((a, b) => a.ms - b.ms);
    if (race.board.length > 20) race.board.length = 20;
  }
}

// ---- sea events (Battle Arena, Lava Run): circles in the sea; each player then plays in a PERSONAL arena (see arena.js).
// Boards keep the best SCORE per player (higher is better), saved through the same hook idea as the race boards.
let eventSaver = null;
function setEventSaver(fn) { eventSaver = typeof fn === 'function' ? fn : null; }
function loadEventBoards(rows) {
  ensureShared();
  for (const row of rows || []) {
    const ev = SHARED.events.find((e) => e.id === row.eventId);
    if (!ev || !row.uid || !(row.score > 0)) continue;
    const i = ev.board.findIndex((b) => b.uid === row.uid);
    if (i >= 0) { if (row.score > ev.board[i].score) ev.board[i] = { uid: row.uid, name: row.name, score: row.score }; }
    else ev.board.push({ uid: row.uid, name: row.name, score: row.score });
  }
  for (const ev of SHARED.events) { ev.board.sort((a, b) => b.score - a.score); if (ev.board.length > 30) ev.board.length = 30; }
}
function eventById(id) { ensureShared(); return SHARED.events.find((e) => e.id === id) || null; }
function eventRecord(eventId, uid, name, score) {
  const ev = eventById(eventId);
  if (!ev || !(score > 0)) return { best: 0, rank: 0, improved: false };
  const i = ev.board.findIndex((b) => b.uid === uid);
  let improved = false;
  if (i >= 0) { if (score > ev.board[i].score) { ev.board[i] = { uid, name, score }; improved = true; } }
  else { ev.board.push({ uid, name, score }); improved = true; }
  ev.board.sort((a, b) => b.score - a.score);
  if (ev.board.length > 30) ev.board.length = 30;
  if (improved && eventSaver) { try { eventSaver({ eventId, uid, name, score }); } catch (e) { /* never break the loop */ } }
  const k = ev.board.findIndex((b) => b.uid === uid);
  return { best: k >= 0 ? ev.board[k].score : score, rank: k + 1, improved };
}
function eventsNear(x, y) {
  ensureShared();
  return SHARED.events
    .filter((e) => Math.hypot(e.x - x, e.y - y) <= CFG.aoiR + e.r)
    .map((e) => ({ id: e.id, name: e.name, emoji: e.emoji, x: e.x, y: e.y, r: e.r, board: e.board.slice(0, 20).map((b) => ({ name: b.name, score: b.score })) }));
}

function raceJoin(uid, name, player, raceId) {
  ensureShared();
  const race = (SHARED.races || []).find((r) => r.id === raceId);
  if (!race) return { ok: false, err: 'no_race' };
  if (race.entrants[uid] && !race.entrants[uid].finishedAt) return { ok: false, err: 'already' };
  const d = Math.hypot(player.x - race.x, player.y - race.y);
  if (d > CFG.raceJoinR) return { ok: false, err: 'far' };
  // 3-2-1 countdown: the clock (and checkpoint detection) only starts at startAt
  const startAt = Date.now() + CFG.raceCountdownMs;
  race.entrants[uid] = { startAt, nextCp: 0, finishedAt: 0, name: name || 'Sailor' };
  return { ok: true, raceId, checkpoints: race.checkpoints.length, countdownMs: CFG.raceCountdownMs };
}

function raceTickPlayer(uid, player, now) {
  ensureShared();
  for (const race of SHARED.races || []) {
    const ent = race.entrants[uid];
    if (!ent || ent.finishedAt) continue;
    if (now < ent.startAt) continue; // still counting down
    const cp = race.checkpoints[ent.nextCp];
    if (!cp) continue;
    if (Math.hypot(player.x - cp.x, player.y - cp.y) <= cp.r) {
      ent.nextCp++;
      if (ent.nextCp >= race.checkpoints.length) {
        ent.finishedAt = now;
        const ms = now - ent.startAt;
        // keep only each player's best (lowest) time
        const prev = race.board.findIndex((b) => b.uid === uid);
        let improved = false;
        if (prev >= 0) {
          if (ms < race.board[prev].ms) {
            race.board[prev] = { uid, name: ent.name, ms };
            improved = true;
          }
        } else {
          race.board.push({ uid, name: ent.name, ms });
          improved = true;
        }
        if (improved && boardSaver) {
          try { boardSaver({ raceId: race.id, uid, name: ent.name, ms }); } catch (e) { /* never break the tick */ }
        }
        race.board.sort((a, b) => a.ms - b.ms);
        if (race.board.length > 20) race.board.length = 20;
        return { finished: true, ms, place: race.board.findIndex((b) => b.uid === uid) + 1, name: race.name };
      }
      return { checkpoint: ent.nextCp };
    }
  }
  return null;
}

function raceAbandon(uid) {
  ensureShared();
  for (const race of SHARED.races || []) {
    const ent = race.entrants[uid];
    if (ent && !ent.finishedAt) {
      delete race.entrants[uid];
    }
  }
}

function racesNear(x, y) {
  ensureShared();
  return (SHARED.races || [])
    .filter((r) => Math.hypot(r.x - x, r.y - y) < CFG.aoiR + r.r)
    .map((r) => ({
      id: r.id,
      name: r.name || r.id,
      x: r1(r.x),
      y: r1(r.y),
      r: r.r,
      checkpoints: r.checkpoints.map((c) => ({ x: r1(c.x), y: r1(c.y), r: c.r, finish: !!c.finish })),
      board: r.board.slice(0, 10).map((b) => ({ name: b.name, ms: b.ms })),
      entrants: Object.keys(r.entrants).filter((u) => r.entrants[u] && !r.entrants[u].finishedAt).length
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
  now = now || Date.now();
  const v = view(session, opts);
  if (!v) return null;
  v.others = others || [];
  const p = session.player;
  v.races = racesNear(p.x, p.y);
  v.arenas = eventsNear(p.x, p.y); // event circles (the drained sound/UI events stay in v.events)
  v.team = teamInfo(session.uid);
  v.selfUid = session.uid;
  // pending invite for this player
  ensureShared();
  v.teamInvite = null;
  const pinv = pendingInvite(session.uid);
  if (pinv && !getTeamFor(session.uid)) v.teamInvite = { teamId: pinv.teamId || 'p_' + pinv.from, from: pinv.from, name: pinv.name };
  // race progress for self
  v.raceProgress = null;
  for (const race of SHARED.races || []) {
    const ent = race.entrants[session.uid];
    if (ent && !ent.finishedAt) {
      // elapsed is relative (negative while counting down) so the client never depends on clock sync
      v.raceProgress = {
        raceId: race.id,
        nextCp: ent.nextCp,
        total: race.checkpoints.length,
        startAt: ent.startAt,
        elapsed: now - ent.startAt,
        countingDown: now < ent.startAt
      };
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
  _x: { segDist, fxSeq: () => ++fxSeq, steerNpc, resolveBoatBoat, resolveCircle, r1, r2, rng },
  CFG,
  EMOJIS,
  createSession,
  setIntent,
  tick,
  tickShared,
  attack,
  fireCannon,
  dropMine,
  tickMines,
  tickShots,
  loot,
  collectTreasure,
  openChest,
  invCap,
  treasuryCap,
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
  setBoardSaver,
  setEventSaver,
  loadEventBoards,
  eventById,
  eventRecord,
  loadRaceBoards,
  sameTeam,
  getTeamFor,
  teamInvite,
  teamAccept,
  teamDecline,
  teamLeave,
  teamKick,
  teamInfo,
  raceJoin,
  raceTickPlayer,
  raceAbandon,
  racesNear
};
