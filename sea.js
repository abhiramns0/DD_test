'use strict';
// Open Sea rules + world model. PURE: no database, no sockets, no drawing.
// sea sessions are owned by the server; this module only defines the world, entities, movement,
// discovery rules and a serialisable snapshot for the client renderer (public/sea-view.js).
//
// Boundaries:
//   world data  → CFG, generateWorld(), islets, treasures
//   behaviour   → tick(), intent movement, NPC AI hooks
//   persistence → packDiscoveries() / mergeDiscoveries() (plain data for island.js to store)
//
// No human multiplayer encounters and no clan system yet.

const CFG={
  worldR:3200,            // soft navigation radius from home (0,0)
  hardR:3600,             // absolute clamp — player cannot leave this
  homeR:180,              // home private-island visual radius
  returnR:220,            // enter return zone to dock
  leaveR:260,             // spawn just outside home when sailing out
  speed:165,              // player vessel units/sec
  npcSpeed:70,
  wildSpeed:55,
  tickHz:12,
  // spawn budgets (per voyage, regenerated each enter)
  npcBoats:5,
  wildlife:8,
  islets:7,
  treasures:10,
  // combat foundation (modular; expand later)
  playerHp:100,
  npcBoatHp:40,
  wildHp:20,
  attackRange:70,
  attackDamage:12,
  attackCooldownMs:700,
  lootRange:55,
  collectRange:50
};

// Deterministic PRNG from a string seed (player id + voyage counter)
function rng(seed){
  let h=2166136261>>>0;
  const s=String(seed||'sea');
  for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}
  return()=>{h^=h<<13;h^=h>>>17;h^=h<<5;return ((h>>>0)/4294967296)}}

function ang(x,y){return Math.atan2(y,x)}
function len(x,y){return Math.hypot(x,y)}
function clampToWorld(x,y){
  const d=len(x,y);
  if(d<=CFG.hardR)return{x,y};
  const k=CFG.hardR/d;return{x:x*k,y:y*k}}

// ---- world generation (islets + treasures). NPCs/wildlife are session-only.
function generateWorld(seed){
  const rnd=rng(seed),islets=[],treasures=[],used=[];
  const farEnough=(x,y,minD)=>{
    if(len(x,y)<CFG.homeR+140)return false;
    for(const u of used)if(Math.hypot(u.x-x,u.y-y)<minD)return false;
    return true};

  for(let i=0;i<CFG.islets;i++){
    let x=0,y=0,ok=false;
    for(let t=0;t<40&&!ok;t++){
      const a=rnd()*Math.PI*2,d=CFG.homeR+220+rnd()*(CFG.worldR-CFG.homeR-280);
      x=Math.cos(a)*d;y=Math.sin(a)*d;ok=farEnough(x,y,280)}
    if(!ok)continue;
    const id='islet_'+i,r=55+rnd()*45;
    islets.push({id,x,y,r,name:['Coral Cay','Driftwood Key','Mist Atoll','Shell Spit','Gull Rock','Palm Speck','Wreck Shoal'][i%7]});
    used.push({x,y})}

  for(let i=0;i<CFG.treasures;i++){
    let x=0,y=0,ok=false;
    for(let t=0;t<40&&!ok;t++){
      const a=rnd()*Math.PI*2,d=CFG.homeR+160+rnd()*(CFG.worldR-CFG.homeR-200);
      x=Math.cos(a)*d;y=Math.sin(a)*d;ok=farEnough(x,y,120)}
    if(!ok)continue;
    const id='tre_'+i;
    // Slight bias: some treasures near islets
    if(islets.length&&rnd()<0.45){
      const it=islets[(rnd()*islets.length)|0];
      const a=rnd()*Math.PI*2,d=it.r+30+rnd()*50;
      x=it.x+Math.cos(a)*d;y=it.y+Math.sin(a)*d}
    treasures.push({id,x,y,kind:rnd()<0.2?'chest':'crate',value:rnd()<0.15?3:1});
    used.push({x,y})}

  return{seed,islets,treasures}}

function spawnNpcs(seed,count){
  const rnd=rng(seed+':npc'),out=[];
  for(let i=0;i<count;i++){
    const a=rnd()*Math.PI*2,d=CFG.homeR+300+rnd()*(CFG.worldR-CFG.homeR-350);
    const x=Math.cos(a)*d,y=Math.sin(a)*d;
    const facing=rnd()*Math.PI*2;
    out.push({id:'npc_'+i,kind:'boat',x,y,vx:Math.cos(facing)*CFG.npcSpeed*0.4,vy:Math.sin(facing)*CFG.npcSpeed*0.4,
      facing,hp:CFG.npcBoatHp,maxHp:CFG.npcBoatHp,alive:true,loot:rnd()<0.5?1:0,aggro:rnd()<0.35})}
  return out}

function spawnWildlife(seed,count){
  const rnd=rng(seed+':wild'),out=[];
  for(let i=0;i<count;i++){
    const a=rnd()*Math.PI*2,d=CFG.homeR+200+rnd()*(CFG.worldR-CFG.homeR-250);
    const x=Math.cos(a)*d,y=Math.sin(a)*d;
    const type=rnd()<0.55?'croc':'gull';
    out.push({id:'wild_'+i,kind:type,x,y,vx:(rnd()-0.5)*CFG.wildSpeed,vy:(rnd()-0.5)*CFG.wildSpeed,
      facing:0,hp:CFG.wildHp,maxHp:CFG.wildHp,alive:true,loot:0,aggro:type==='croc'})}
  return out}

// ---- session document (in-memory while sailing; discoveries persist via packDiscoveries)
function createSession(uid,voyage,savedDiscoveries){
  // World layout is stable per player so collected treasure IDs stay valid across voyages.
  // Voyage only re-rolls NPCs/wildlife. Use ONE seed binding only (duplicate const crashes Node).
  const worldSeed=String(uid)+':world';
  const world=generateWorld(worldSeed);
  const disc=normalizeDiscoveries(savedDiscoveries);
  // Mark already-collected treasures from prior voyages so they don't respawn as collectible
  for(const t of world.treasures)if(disc.treasures.includes(t.id))t.collected=true;
  else t.collected=false;
  for(const it of world.islets)it.explored=disc.islets.includes(it.id);

  const spawnA=Math.PI*0.25; // leave SE of home toward open water
  const px=Math.cos(spawnA)*CFG.leaveR, py=Math.sin(spawnA)*CFG.leaveR;

  return{
    uid,voyage,seed:worldSeed,startedAt:Date.now(),
    player:{x:px,y:py,vx:0,vy:0,facing:spawnA,hp:CFG.playerHp,maxHp:CFG.playerHp,alive:true,
      attackAt:0,vessel:'raft'},
    islets:world.islets,
    treasures:world.treasures,
    npcs:spawnNpcs(String(uid)+':npc:v'+voyage,CFG.npcBoats),
    wildlife:spawnWildlife(String(uid)+':wild:v'+voyage,CFG.wildlife),
    intent:{mx:0,my:0},
    events:[],
    discoveries:disc,
    status:'sailing'
  }}

function normalizeDiscoveries(raw){
  const out={islets:[],treasures:[],voyages:0,treasureCount:0};
  if(!raw||typeof raw!=='object')return out;
  if(Array.isArray(raw.islets))out.islets=raw.islets.filter(id=>typeof id==='string').slice(0,200);
  if(Array.isArray(raw.treasures))out.treasures=raw.treasures.filter(id=>typeof id==='string').slice(0,200);
  if(Number.isInteger(raw.voyages)&&raw.voyages>=0)out.voyages=Math.min(raw.voyages,1e6);
  if(Number.isInteger(raw.treasureCount)&&raw.treasureCount>=0)out.treasureCount=Math.min(raw.treasureCount,1e6);
  return out}

function packDiscoveries(session){
  return{
    islets:session.discoveries.islets.slice(),
    treasures:session.discoveries.treasures.slice(),
    voyages:session.discoveries.voyages,
    treasureCount:session.discoveries.treasureCount
  }}

// ---- behaviour ------------------------------------------------------------
function setIntent(session,mx,my){
  if(!session||session.status!=='sailing')return;
  const m=Math.hypot(mx,my);
  if(m<0.05){session.intent.mx=0;session.intent.my=0;return}
  session.intent.mx=mx/m;session.intent.my=my/m}

function steerNpc(e,tx,ty,speed,dt){
  const dx=tx-e.x,dy=ty-e.y,d=Math.hypot(dx,dy)||1;
  const wx=dx/d*speed,wy=dy/d*speed;
  e.vx+=(wx-e.vx)*Math.min(1,dt*2.2);
  e.vy+=(wy-e.vy)*Math.min(1,dt*2.2);
  e.x+=e.vx*dt;e.y+=e.vy*dt;
  e.facing=Math.atan2(e.vy,e.vx);
  const c=clampToWorld(e.x,e.y);e.x=c.x;e.y=c.y}

function tickNpc(e,dt){
  // wander / mild pursuit
  if(e.aggro){ /* placeholder: mild drift toward player is applied by caller */ }
  e.x+=e.vx*dt;e.y+=e.vy*dt;
  // soft bounce at world edge
  const d=len(e.x,e.y);
  if(d>CFG.worldR){
    const nx=e.x/d,ny=e.y/d;
    e.vx-=nx*40;e.vy-=ny*40;
    e.x=nx*CFG.worldR;e.y=ny*CFG.worldR}
  // keep moving
  const sp=Math.hypot(e.vx,e.vy);
  if(sp<8){const a=Math.random()*Math.PI*2;e.vx=Math.cos(a)*CFG.npcSpeed*0.35;e.vy=Math.sin(a)*CFG.npcSpeed*0.35}
  e.facing=Math.atan2(e.vy,e.vx)}

function tick(session,dt,now){
  if(!session||session.status!=='sailing')return session;
  dt=Math.max(0.01,Math.min(0.1,dt));
  const p=session.player;
  if(!p.alive)return session;

  // Player movement from intent
  if(session.intent.mx||session.intent.my){
    const tx=p.x+session.intent.mx*200,ty=p.y+session.intent.my*200;
    steerNpc(p,tx,ty,CFG.speed,dt);
  }else{
    p.vx*=Math.max(0,1-dt*1.8);p.vy*=Math.max(0,1-dt*1.8);
    p.x+=p.vx*dt;p.y+=p.vy*dt;
    const c=clampToWorld(p.x,p.y);p.x=c.x;p.y=c.y}

  // NPCs: wander; aggressive boats gently lean toward player if nearby
  for(const n of session.npcs){
    if(!n.alive)continue;
    if(n.aggro&&Math.hypot(n.x-p.x,n.y-p.y)<420){
      steerNpc(n,p.x,p.y,CFG.npcSpeed*0.85,dt);
    }else tickNpc(n,dt)}

  for(const w of session.wildlife){
    if(!w.alive)continue;
    if(w.kind==='croc'&&Math.hypot(w.x-p.x,w.y-p.y)<280){
      steerNpc(w,p.x,p.y,CFG.wildSpeed,dt);
    }else tickNpc(w,dt)}

  // Islet exploration (proximity)
  for(const it of session.islets){
    if(it.explored)continue;
    if(Math.hypot(it.x-p.x,it.y-p.y)<it.r+30){
      it.explored=true;
      if(!session.discoveries.islets.includes(it.id))session.discoveries.islets.push(it.id);
      session.events.push({t:'explore',id:it.id,name:it.name,at:now})}}

  // Near-home return prompt (client may call returnHome)
  session.nearHome=Math.hypot(p.x,p.y)<=CFG.returnR;
  return session}

// ---- interactions (foundations) ------------------------------------------
function attack(session,now){
  if(!session||session.status!=='sailing')return{ok:false,err:'not_sailing'};
  const p=session.player;
  if(!p.alive)return{ok:false,err:'dead'};
  if(now<p.attackAt)return{ok:false,err:'cooldown'};
  p.attackAt=now+CFG.attackCooldownMs;
  let hit=null,best=CFG.attackRange;
  const targets=[...session.npcs,...session.wildlife].filter(e=>e.alive);
  for(const e of targets){
    const d=Math.hypot(e.x-p.x,e.y-p.y);
    if(d<best){best=d;hit=e}}
  if(!hit){session.events.push({t:'miss',at:now});return{ok:true,hit:false}}
  hit.hp-=CFG.attackDamage;
  if(hit.hp<=0){
    hit.alive=false;hit.hp=0;
    session.events.push({t:'kill',id:hit.id,kind:hit.kind,loot:hit.loot|0,at:now});
    return{ok:true,hit:true,killed:true,id:hit.id,loot:hit.loot|0}}
  session.events.push({t:'hit',id:hit.id,hp:hit.hp,at:now});
  return{ok:true,hit:true,killed:false,id:hit.id,hp:hit.hp}}

function loot(session,now){
  if(!session||session.status!=='sailing')return{ok:false,err:'not_sailing'};
  const p=session.player;
  const dead=session.npcs.filter(n=>!n.alive&&(n.loot|0)>0);
  let best=null,bd=CFG.lootRange;
  for(const n of dead){
    const d=Math.hypot(n.x-p.x,n.y-p.y);
    if(d<bd){bd=d;best=n}}
  if(!best)return{ok:false,err:'nothing'};
  const gained=best.loot;best.loot=0;
  session.events.push({t:'loot',id:best.id,gained,at:now});
  return{ok:true,gained,id:best.id}}

function collectTreasure(session,now){
  if(!session||session.status!=='sailing')return{ok:false,err:'not_sailing'};
  const p=session.player;
  let best=null,bd=CFG.collectRange;
  for(const t of session.treasures){
    if(t.collected)continue;
    const d=Math.hypot(t.x-p.x,t.y-p.y);
    if(d<bd){bd=d;best=t}}
  if(!best)return{ok:false,err:'nothing'};
  // Dedupe against persistent discoveries
  if(session.discoveries.treasures.includes(best.id)){
    best.collected=true;return{ok:false,err:'already'}}
  best.collected=true;
  session.discoveries.treasures.push(best.id);
  session.discoveries.treasureCount+=best.value|1;
  session.events.push({t:'treasure',id:best.id,kind:best.kind,value:best.value,at:now});
  return{ok:true,id:best.id,kind:best.kind,value:best.value}}

function returnHome(session){
  if(!session||session.status!=='sailing')return{ok:false,err:'not_sailing'};
  session.status='docked';
  session.discoveries.voyages=(session.discoveries.voyages|0)+1;
  return{ok:true,nearHome:!!session.nearHome,discoveries:packDiscoveries(session)}}

// Snapshot for the client renderer (no secrets, plain data)
function view(session){
  if(!session)return null;
  const drain=session.events.splice(0,session.events.length);
  return{
    status:session.status,
    nearHome:!!session.nearHome,
    cfg:{worldR:CFG.worldR,homeR:CFG.homeR,returnR:CFG.returnR,attackRange:CFG.attackRange},
    player:{x:session.player.x,y:session.player.y,facing:session.player.facing,
      hp:session.player.hp,maxHp:session.player.maxHp,vessel:session.player.vessel,alive:session.player.alive},
    islets:session.islets.map(i=>({id:i.id,x:i.x,y:i.y,r:i.r,name:i.name,explored:!!i.explored})),
    treasures:session.treasures.filter(t=>!t.collected).map(t=>({id:t.id,x:t.x,y:t.y,kind:t.kind})),
    npcs:session.npcs.filter(n=>n.alive).map(n=>({id:n.id,x:n.x,y:n.y,facing:n.facing,kind:n.kind,hp:n.hp,maxHp:n.maxHp})),
    wildlife:session.wildlife.filter(w=>w.alive).map(w=>({id:w.id,x:w.x,y:w.y,facing:w.facing,kind:w.kind})),
    wrecks:session.npcs.filter(n=>!n.alive).map(n=>({id:n.id,x:n.x,y:n.y,loot:n.loot|0})),
    events:drain,
    discoveries:{islets:session.discoveries.islets.length,treasures:session.discoveries.treasureCount,voyages:session.discoveries.voyages}
  }}

module.exports={CFG,createSession,setIntent,tick,attack,loot,collectTreasure,returnHome,view,
  packDiscoveries,normalizeDiscoveries,generateWorld,clampToWorld};
