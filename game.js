'use strict';
// Drowning Dash - authoritative game logic (no network code): Room gets emit(event,payload,pids?).
// Modes: coop (levels, also used by Solo), last (Last Escape), tourney (Island Tournament).
// ================= TUNING: everything you are likely to change lives in this block =================
// ISLAND + PLAYER ARE A PAIR: a bigger island needs a faster player so crossing time stays about the same.
// Change islandSizeMultiplier and moveSpeedMultiplier together (both 1.5 => roomier island, same feel).
const ISLAND={islandSizeMultiplier:1.5, // multiplies each mode's base islandR (see MODES / COOP)
  minimumIslandSize:260,maximumIslandSize:720}; // final island radius is clamped to this range
const PLAYER={moveSpeed:130,        // base units/second
  moveSpeedMultiplier:1.5};         // effective speed = moveSpeed * moveSpeedMultiplier (pair with islandSizeMultiplier)
// Co-op / Solo level progression (Solo = co-op with one player). Level n grows from level 1.
const COOP={
  coopLevelDuration:60,    // sinking timer (s) on level 1
  coopDurationStep:1.5,      // seconds removed per level
  coopMinimumDuration:45,  // timer never goes below this
  coopSpeedGrowth:.05,     // every level after 1 makes EVERYTHING faster by this much: player, crocodiles, collecting, building (0 = off)
  coopSpeedMax:1.8,        // speed factor never goes above this
  coopResourceScaling:1,   // 0 = needs never grow, 1 = default, 2 = twice as fast
  coopBaseIslandSize:380,  // base island radius at level 1 (before islandSizeMultiplier)
  coopIslandGrowth:6,      // extra base radius per level
  coopEnergyStartLevel:3,  // vehicles need energy from this level on
  coopCrocodileStartLevel:1,   // first level with crocodiles in Co-op (all modes now have crocodiles)
  coopCrocodileScaling:.4,     // crocodiles added per level after start (0.4 => +1 every 2.5 levels)
  soloCrocodileStartLevel:1,   // Solo is a single player, so crocodiles start earlier / grow faster
  soloCrocodileScaling:.5,
  crocodileMax:6};             // hard cap of simultaneous crocodiles
// Crocodiles: straight-line patrols, 1.4 s red lane warning before each run, instant elimination on contact.
const CROC={speed:80*PLAYER.moveSpeedMultiplier,hitR:28,warnMs:1400,respawnMs:[2500,5000],graceMs:4000};
// Last Escape: energy is NOT available at the start. It appears in waves late in the sinking cycle.
const LAST_ESCAPE={
  rounds:3,maxRounds:5,     // best-of-3 (most round wins takes the match). Ties after round 3 play extra rounds, up to maxRounds
  energySpawnStart:.4,      // fraction of the round timer before the first energy wave (0.4 = after 40% of the time)
  energySpawnInterval:5,    // seconds between waves
  energyTotalFactor:1.5,    // total energy = need * teams * this (>1 so everyone can finish, <2 so it stays a race)
  energySpawnRadiusMin:.25, // wave distance from the centre as a fraction of the CURRENT island radius (so it always lands on dry land)
  energySpawnRadiusMax:.65,
  energyContestedShare:.35};// chance a wave is placed on the borders BETWEEN teams (contested) instead of inside each team's own wedge.
                            // Every wave places one node per team at mirrored positions, so it is always fair.
// Energy crystals in Co-op / Tournament / Solo: random spots spread over a ring of the island that stays above water long enough to be collected.
// minR/maxR = distance from centre as a fraction of island radius (smaller maxR = safer, they sink last); minSep = minimum gap between crystals (fraction of radius); spread = width of the allowed arc around each team border (fraction of a team's sector).
const CRYSTAL={minR:.2,maxR:.55,minSep:.22,spread:.8};
// Shield + stun gun (Last Escape only) and their airdrops
const POWER={shieldMs:5000,stunMs:3000,gunShots:2,gunRange:340,gunConeDeg:22,gunHitR:14,gunCdMs:700, // gunRange = funnel length (world units), gunConeDeg = funnel angle (total width in degrees), gunHitR = body-size tolerance
  
  dropFirst:[9000,15000],dropEvery:[14000,26000],gunChance:.15,gunMaxPerRound:2,maxDrops:2,pickR:38,fallMs:1600}; // gunChance = share of drops that are the (very rare) stun gun
// Revive: a teammate killed by a crocodile can be revived by a living teammate standing close for holdMs, within windowMs of dying
const REVIVE={windowMs:10000,holdMs:3000,r:55,protectMs:2500};
// Bots fill public rooms. fillTo = total players the room tries to reach. levels = skill (0..1): rookie, average, expert.
const BOT={fillTo:4,fillDelayMs:6000,autoStartMs:20000,joinGraceMs:6000,levels:[.35,.6,.85],names:['Nova','Bolt','Pixel','Ziggy','Maple','Rusty','Echo','Mango']};
const REVIVE_LEFT_S=15,ROUND_BREAK_MS=5000,SKINS_FREE_BOT=['default','santa','elf','sunny','witch','holi','diwali'];
const CFG={tick:30,minPlayers:2,maxPlayers:4,countdownMs:3000,speed:PLAYER.moveSpeed*PLAYER.moveSpeedMultiplier,collectR:50,buildR:80,boardR:52,raftCap:4,contribMs:220,
collectMs:0,collectCdMs:400,collectSlow:.35,treeAmt:3,logAmt:2,bushAmt:2,crystalAmt:2, // crystal = energy node
push:{cdMs:1200,missMs:350,range:75,dist:105,decay:8,slideMs:800,immuneMs:700,occupyMs:400,graceMs:0}, // range = how far away you can push someone, dist = total slide distance (world units), slideMs = how long the server owns a pushed player (keep >= slide time; mirror in index.html PUSH_SLIDE_MS)
launchMs:1500,floodMs:1800,escapeCountdownMs:10000,collapseMs:4500,transitionMs:2500,offlineMs:20000,spawnF:.62,stationF:.26,endR:40,failR:60,croc:CROC};
// Skins any player may use; premium skins must be in p.ownedSkins (fill it from your shop/account DB when you add purchases).
const SKINS_FREE=['default','santa','witch','sunny']; // skins everyone owns (the rest are locked until the store sells them)
const skinAllowed=(p,id)=>SKINS_FREE.includes(id)||(p.ownedSkins||[]).includes(id);
const COLORS=['#4f9dff','#ff8a5c','#4fcf6f','#a678ff'],TCOL=['#4f9dff','#ff8a5c'],TNAME=['TEAM A','TEAM B'];
const MODES={
  coop:{name:'CO-OP'},
  last:{name:'END GAME',duration:80,islandR:400,need:{w:7,l:4,c:3},vehicle:'ship',supply:1.4,lateEnergy:true,crocN:2},
  tourney:{name:'TOURNAMENT',stages:[ // add/remove stages freely (islandR = base size, multiplied by islandSizeMultiplier)
    {name:'Sunny Shore',duration:50,islandR:300,need:{w:5,l:3,c:0},vehicle:'raft',supply:2.2,crocN:1},
    {name:'Palm Bay',duration:55,islandR:340,need:{w:7,l:4,c:0},vehicle:'boat',supply:2,crocN:1},
    {name:'Crystal Cove',duration:60,islandR:380,need:{w:8,l:5,c:2},vehicle:'bigboat',supply:1.8,crocN:2},
    {name:'MAIN ISLAND',duration:70,islandR:420,need:{w:8,l:5,c:4},vehicle:'ship',supply:1.6,crocN:2}]}
};
const KIND={tree:'w',log:'w',bush:'l',crystal:'c'},AMT={tree:CFG.treeAmt,log:CFG.logAmt,bush:CFG.bushAmt,crystal:CFG.crystalAmt};
const PH=['PLAYING','RAFT_READY','ESCAPE','COLLAPSE'];
const radius=(el,c)=>c.islandR-(c.islandR-c.endR)*Math.min(1,Math.max(0,el/c.duration));
function coopLevelCfg(L,solo){
  const sk=Math.min(COOP.coopSpeedMax,1+(L-1)*COOP.coopSpeedGrowth),k=COOP.coopResourceScaling,cs=solo?COOP.soloCrocodileStartLevel:COOP.coopCrocodileStartLevel,cr=solo?COOP.soloCrocodileScaling:COOP.coopCrocodileScaling;
  return{name:'Level '+L,duration:Math.max(COOP.coopMinimumDuration,COOP.coopLevelDuration-(L-1)*COOP.coopDurationStep),islandR:COOP.coopBaseIslandSize+(L-1)*COOP.coopIslandGrowth,
    need:{w:Math.min(16,Math.round(6+(L-1)*k)),l:Math.min(10,Math.round(4+(L-1)*.6*k)),c:L>=COOP.coopEnergyStartLevel?Math.min(5,1+Math.floor((L-COOP.coopEnergyStartLevel)*.5*k)):0},
    vehicle:L<3?'raft':L<6?'boat':L<9?'bigboat':'ship',supply:Math.max(1.7,2.2-.04*L), // plenty of resources on the island (1.7x what you need or more)
    spdK:sk,speed:CFG.speed*sk,collectCdMs:Math.round(CFG.collectCdMs/sk),contribMs:Math.round(CFG.contribMs/sk), // level speed-up: walking, picking up and building all scale together; crocodiles use spdK too
    crocN:L>=cs?Math.min(COOP.crocodileMax,1+Math.floor((L-cs)*cr)):0};
}
function arenaCfg(mode,stage,solo){
  const m=mode==='tourney'?MODES.tourney.stages[stage-1]:mode==='coop'?coopLevelCfg(stage,solo):MODES[mode];
  const R=Math.max(ISLAND.minimumIslandSize,Math.min(ISLAND.maximumIslandSize,Math.round(m.islandR*ISLAND.islandSizeMultiplier)));
  return Object.assign({mode,stage,tick:CFG.tick,endR:CFG.endR,failR:CFG.failR,speed:CFG.speed,collectR:CFG.collectR,buildR:CFG.buildR,boardR:CFG.boardR,
    raftCap:CFG.raftCap,collapseMs:CFG.collapseMs,comp:mode!=='coop',pvp:mode==='last',gunRange:POWER.gunRange,gunCone:POWER.gunConeDeg,launch:true,collectMs:CFG.collectMs,collectSlow:CFG.collectSlow,supply:1.5,crocN:0},
    m,{islandR:R},mode==='last'?{energy:LAST_ESCAPE}:{});
}
function rng(s){let a=s>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}

// ---- competitive sites: n sectors, rotational symmetry => every team gets identical surroundings
function sites(c,n){
  const R=c.islandR;
  if(n===1)return{st:[{x:0,y:0}],sp:[{x:Math.cos(.7854)*R*.5,y:Math.sin(.7854)*R*.5,a:.7854}],ang:[.7854]};
  const o={st:[],sp:[],ang:[]};
  for(let k=0;k<n;k++){const a=.7854+k*6.2832/n,cs=Math.cos(a),sn=Math.sin(a);o.ang.push(a);o.st.push({x:cs*R*CFG.stationF,y:sn*R*CFG.stationF});o.sp.push({x:cs*R*CFG.spawnF,y:sn*R*CFG.spawnF,a})}
  return o;
}
function genLayout(seed,c,n){
  const rnd=rng(seed),R=c.islandR,S=sites(c,n),W=Math.PI*2/n,a0=S.ang[0],sup=c.supply||1.5,nd=c.need,out=[],sc=R/380;
  const RES={tree:1,log:1,bush:1,crystal:1};
  const keepA=[],keep0=[{x:S.st[0].x,y:S.st[0].y,r:68},{x:S.sp[0].x,y:S.sp[0].y,r:46}];
  S.st.forEach(q=>keepA.push({x:q.x,y:q.y,r:68}));S.sp.forEach(q=>keepA.push({x:q.x,y:q.y,r:46}));
  const ok=(x,y,m,res,keep)=>keep.every(q=>Math.hypot(q.x-x,q.y-y)>q.r)&&out.every(o=>Math.hypot(o.x-x,o.y-y)>((RES[o.k]||res)?m:m*.6));
  const put=(k,a,sp,d0,d1,m)=>{for(let i=0;i<60;i++){const an=a+(rnd()-.5)*sp,d=R*(d0+rnd()*(d1-d0)),x=Math.cos(an)*d,y=Math.sin(an)*d;
    if(ok(x,y,m,1,keep0)){const o={k,x:+x.toFixed(1),y:+y.toFixed(1)};out.push(o);return o}}return null};
  const sp=n===1?6.283:W*.8,cnt=(v,a)=>Math.max(1,Math.ceil(v*sup/a));
  // sector 0 (random per seed), then rotated copies => fair
  for(let i=0;i<cnt(nd.w*.7,CFG.treeAmt);i++)put('tree',a0,sp,.4,.84,48);
  for(let i=0;i<cnt(nd.w*.3,CFG.logAmt);i++)put('log',a0,sp,.34,.8,40);
  for(let i=0;i<cnt(nd.l,CFG.bushAmt);i++)put('bush',a0,sp,.3,.78,38);
  if(nd.c>0&&!c.lateEnergy){ // crystals: random spread around the border between two sectors (whole island for solo), never clumped
    const CR=CRYSTAL,bA=a0+(n===1?Math.PI:W/2),spr=n===1?6.283:W*CR.spread,cr=[];
    for(let i=0;i<cnt(nd.c,CFG.crystalAmt);i++)for(let t=0;t<150;t++){
      const an=bA+(rnd()-.5)*spr,d=R*(CR.minR+rnd()*(CR.maxR-CR.minR)),x=Math.cos(an)*d,y=Math.sin(an)*d,sepOK=t>100?.5:1; // after 100 failed tries the spacing is relaxed
      if(ok(x,y,30,1,keep0)&&cr.every(q=>Math.hypot(q.x-x,q.y-y)>R*CR.minSep*sepOK)){const o={k:'crystal',x:+x.toFixed(1),y:+y.toFixed(1)};out.push(o);cr.push(o);break}}}
  const base=out.slice();
  for(let k=1;k<n;k++){const ca=Math.cos(k*W),sa=Math.sin(k*W);base.forEach(o=>out.push({k:o.k,x:+(o.x*ca-o.y*sa).toFixed(1),y:+(o.x*sa+o.y*ca).toFixed(1)}))}
  // decoration (random, no gameplay effect)
  const FC=['#ff9ec4','#fff3a0','#c8b6ff','#ffb27a'];
  const dec=(k,cn,d0,d1,m,mk)=>{for(let i=0;i<cn;i++)for(let t=0;t<30;t++){const an=rnd()*6.2832,d=R*(d0+rnd()*(d1-d0)),x=Math.cos(an)*d,y=Math.sin(an)*d;
    if(ok(x,y,m,0,keepA)){out.push(Object.assign({k,x:+x.toFixed(1),y:+y.toFixed(1)},mk?mk():{}));break}}};
  dec('rock',Math.round(7*sc),.15,.9,30);dec('flower',Math.round(16*sc),.1,.9,18,()=>({c:FC[(rnd()*4)|0]}));
  dec('tuft',Math.round(12*sc),.1,.9,16);dec('mush',5,.2,.8,20);dec('shell',8,.88,.95,18);
  return out;
}

const GAMEF=()=>({vx:0,vy:0,ix:0,iy:0,inv:{w:0,l:0,c:0},status:'alive',seat:-1,cd:0,pushCd:0,pushLen:0,immune:0,act:null,anim:'idle',face:1,collT:0,buildT:0,pushT:0,hitT:0,boardedAt:0,escAt:0,noBoard:0,invD:true,moving:false,hasShield:false,shieldUntil:0,gun:0,gunCd:0,stunUntil:0,protect:0,revivable:false,deadAt:0,rv:0,pwD:true,mvAt:0,mvBud:0,mvLock:0,mvMoveAt:0,mvSeq:0});

class Arena{
  constructor(room,id,o){
    this.room=room;this.id=id;this.cfg=o.cfg;this.tids=o.tids;this.seed=o.seed;this.startAt=o.startAt;this.state='COUNTDOWN';
    this.tickN=0;this.last=o.now;this.r=o.cfg.islandR;this.col=null;this.dirty=true;this.over=false;
    const n=o.tids.length;
    this.layout=genLayout(o.seed,o.cfg,n);
    this.left=this.layout.map(x=>AMT[x.k]||0);
    this.site=sites(o.cfg,n);
    this.crocs=[];for(let i=0;i<(o.cfg.crocN||0);i++)this.crocs.push({id:i,st:'wait',t:o.startAt+CFG.croc.graceMs+i*1200,x:0,y:0,vx:0,vy:0,age:0});
    this.eWaves=0;this.eMax=0;this.drops=[];this.nextDrop=0;this.gunDrops=0;
    if(o.cfg.energy)this.eMax=Math.ceil(Math.ceil(o.cfg.need.c*n*o.cfg.energy.energyTotalFactor/CFG.crystalAmt)/n);
    this.stations=o.tids.map((tid,k)=>({id:k,tid,x:this.site.st[k].x,y:this.site.st[k].y,w:0,l:0,c:0,done:false,dead:false,cd:0,rr:0,launchAt:0,cdAt:0,launched:false,flooding:false,departAt:0,seats:0,kind:o.cfg.vehicle}));
  }
  members(){return this.room.pl().filter(p=>p.aid===this.id)}
  spawnFor(k,j,m,i){
    const s=this.site.sp[k],o=(j-(m-1)/2)*34;return{x:s.x-Math.sin(s.a)*o,y:s.y+Math.cos(s.a)*o};
  }
  world(){
    return{st:this.state,left:this.left,col:this.col,host:this.room.host,
      stn:this.stations.map(S=>({id:S.id,tid:S.tid,w:S.w,l:S.l,c:S.c,done:S.done,dead:S.dead,dep:S.cdAt||0,ln:S.launched?1:(S.launchAt||S.flooding)?2:0})),
      pl:this.members().map(p=>({id:p.id,name:p.name,color:p.color,tid:p.tid,status:p.status,seat:p.seat,esc:p.escAt||0,off:p.offline?1:0,skin:p.skin,bot:p.bot?1:0,sa:p.shieldUntil,su:p.stunUntil}))};
  }
  take(p,i,now){const n=this.layout[i];p.act=null;if(this.left[i]<=0)return;this.left[i]--;p.inv[KIND[n.k]]++;p.cd=now+(this.cfg.collectCdMs||CFG.collectCdMs);p.collT=now;p.invD=true;this.dirty=true;this.room.ea(this,'ev',{t:'c',p:p.id,i})}
  collect(p,now,r){
    const c=this.cfg,need=c.need,L=this.layout,S=this.stations.find(s=>s.tid===p.tid);
    // you can only carry what the vehicle still needs: remaining = need - already built (updates live as you build)
    const full=res=>p.inv[res]>=Math.max(0,need[res]-(S?S[res]:0));
    if(p.act){ // channel in progress (competitive modes)
      const n=L[p.act.i],dd=Math.hypot(n.x-p.x,n.y-p.y);
      if(this.left[p.act.i]<=0||dd>c.collectR*1.3||Math.hypot(n.x,n.y)>r-8||full(KIND[n.k])){p.act=null;return}
      if(now>=p.act.end)this.take(p,p.act.i,now);
      return;
    }
    if(now<p.cd)return;
    let bi=-1,bd=1e9;
    L.forEach((n,i)=>{const res=KIND[n.k];if(!res||this.left[i]<=0||full(res))return;if(Math.hypot(n.x,n.y)>r-8)return;
      const dd=Math.hypot(n.x-p.x,n.y-p.y);if(dd<c.collectR*1.1&&dd<bd){bd=dd;bi=i}});
    if(bi<0)return;
    if(c.collectMs>0){p.act={i:bi,end:now+c.collectMs};this.room.ea(this,'ev',{t:'s',p:p.id,i:bi})}else this.take(p,bi,now);
  }
  freeSeat(S){const used=new Set(this.members().filter(q=>q.tid===S.tid&&(q.status==='boarded'||q.status==='escaped')).map(q=>q.seat));let i=0;while(used.has(i)&&i<3)i++;return i}
  startFlood(S,now,r){ // water fast-forwards to the vehicle (short), then the vehicle leaves - no sliding across grass
    const d=Math.hypot(S.x,S.y);
    S.flooding=true;S.departAt=now+CFG.floodMs;this.col={t0:now,r0:r,r1:Math.min(r,d<5?CFG.endR+16:d+28),ms:CFG.floodMs};this.dirty=true;
    this.room.ea(this,'ev',{t:'fl',s:S.id});
  }
  board(p,now){
    const c=this.cfg,S=this.stations.find(s=>s.tid===p.tid);
    if(!S||!S.done||S.dead||S.launched||S.flooding||now<p.noBoard)return;
    if(Math.hypot(p.x-S.x,p.y-S.y)>=c.boardR||this.members().filter(q=>q.tid===S.tid&&q.status==='boarded').length>=c.raftCap)return;
    p.status='boarded';p.seat=this.freeSeat(S);p.x=S.x+(p.seat%2)*20-10;p.y=S.y+(p.seat>>1)*20-10;p.boardedAt=now;p.ix=p.iy=0;p.vx=p.vy=0;p.act=null;
    this.dirty=true;
    if(this.state==='RAFT_READY')this.state='ESCAPE';
    if(c.mode==='coop'&&!this.room.solo){
  if(!S.cdAt)S.cdAt=now+CFG.escapeCountdownMs; // the 10 s countdown starts when the FIRST player sits aboard
  this.members().forEach(q=>{if(q.tid===S.tid&&q.status==='boarded')q.escAt=S.cdAt});
}else if(c.launch&&!S.launchAt){S.launchAt=now+CFG.launchMs;this.room.ea(this,'ev',{t:'l0',s:S.id})}
this.room.ea(this,'ev',{t:'o',p:p.id,s:S.id});
// If every living player is already boarded, finish the level immediately (no waiting for the 10 s)
if(c.mode==='coop'&&!this.room.solo){
  const live=this.members().filter(q=>(q.status==='alive'||q.status==='boarded')&&!q.offline);
  if(live.length&&live.every(q=>q.status==='boarded')&&!S.launchAt&&!S.launched&&!S.flooding){
    S.launchAt=now; // depart right away
  }
}
  }
  push(p,now){
    const c=this.cfg,P=CFG.push,R=this.room;
    if(!c.pvp||p.status!=='alive'||now<p.stunUntil||!PH.includes(this.state)||now<this.startAt+P.graceMs)return; // push exists in Last Escape only
    if(p.act||now-p.buildT<P.occupyMs||now<p.pushCd)return; // occupied (collecting/building) or cooling down
    let q=null,bd=1e9;
    for(const o of this.members()){if(o===p||o.status!=='alive'||o.tid===p.tid||now<o.immune)continue;const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<P.range&&d<bd){bd=d;q=o}}
    p.pushT=now;p.invD=true;
    if(!q){p.pushCd=now+P.missMs;p.pushLen=P.missMs;R.ea(this,'ev',{t:'x',p:p.id,hit:0});return}
    if(now<q.shieldUntil){q.shieldUntil=0;q.protect=now+500;this.dirty=true;p.pushCd=now+P.cdMs;p.pushLen=P.cdMs;R.ea(this,'ev',{t:'sb',p:q.id});R.ea(this,'ev',{t:'x',p:p.id,hit:0});return} // shield absorbs the push and pops
    const ux=bd>0?(q.x-p.x)/bd:p.face,uy=bd>0?(q.y-p.y)/bd:0;
    q.vx=ux*P.dist*P.decay;q.vy=uy*P.dist*P.decay;q.immune=now+P.immuneMs;q.hitT=now;q.mvLock=now+P.slideMs; // the server owns the slide: client positions are ignored until it ends
    const was=!!q.act;q.act=null;
    p.pushCd=now+P.cdMs;p.pushLen=P.cdMs;
    R.ea(this,'ev',{t:'x',p:p.id,q:q.id,hit:1,was:was?1:0});
  }
  spawnEnergy(now,el,r){ // Last Escape: late, symmetric, partly contested energy waves. A wave is NEVER skipped: placement relaxes until it fits.
    const E=this.cfg.energy;if(!E||this.eWaves>=this.eMax)return;
    if(el<E.energySpawnStart*this.cfg.duration+this.eWaves*E.energySpawnInterval)return;
    const n=this.tids.length,W=Math.PI*2/n,a0=this.site.ang[0],contested=Math.random()<E.energyContestedShare;
    const free=(q,k)=>this.layout.every(o=>Math.hypot(o.x-q.x,o.y-q.y)>46*k)&&this.stations.every(S=>Math.hypot(S.x-q.x,S.y-q.y)>75*k);
    let pts=null;
    for(let t=0;t<260&&!pts;t++){
      const k=t<120?1:t<200?.6:0,wide=t<120?.6:.95,
        la=contested&&t<160?W/2+(Math.random()-.5)*.16*W:(Math.random()-.5)*W*wide,
        d=Math.max(30,Math.min(r*(E.energySpawnRadiusMin+Math.random()*(E.energySpawnRadiusMax-E.energySpawnRadiusMin)),r-45)); // always inside what is left of the island
      const c=[];for(let j=0;j<n;j++){const an=a0+la+j*W;c.push({x:+(Math.cos(an)*d).toFixed(1),y:+(Math.sin(an)*d).toFixed(1)})}
      if(k===0||c.every(q=>free(q,k)))pts=c;
    }
    if(!this.eWaves)this.room.ea(this,'ev',{t:'en'});
    pts.forEach(q=>{const i=this.layout.length;this.layout.push({k:'crystal',x:q.x,y:q.y});this.left.push(AMT.crystal);this.room.ea(this,'ev',{t:'n',i,k:'crystal',x:q.x,y:q.y})});
    this.dirty=true;this.eWaves++;
  }
  // ---- shield + stun gun
  shield(p,now){if(!this.cfg.pvp||p.status!=='alive'||!p.hasShield||now<p.stunUntil||now<p.shieldUntil)return;
    p.hasShield=false;p.shieldUntil=now+POWER.shieldMs;p.pwD=true;this.dirty=true;this.room.ea(this,'ev',{t:'sa',p:p.id})}
  shoot(p,d,now){let ax=+(d&&d.x)||0,ay=+(d&&d.y)||0,vx=ax+2*ay,vy=2*ay-ax,l=Math.hypot(vx,vy);if(l<.05){vx=p.face;vy=0;l=1}this.fire(p,vx/l,vy/l,now)} // aim arrives in screen space, same mapping as movement
  fire(p,vx,vy,now){const c=this.cfg; // the stun gun fires a narrow funnel: EVERY enemy inside it is stunned
    if(!c.pvp||p.status!=='alive'||p.gun<=0||now<p.gunCd||now<p.stunUntil||!PH.includes(this.state)||now<this.startAt+CFG.push.graceMs)return;
    p.gun--;p.gunCd=now+POWER.gunCdMs;p.pwD=true;
    const half=POWER.gunConeDeg*Math.PI/360,hit=[];
    for(const o of this.members()){if(o===p||o.status!=='alive'||o.tid===p.tid)continue;
      const rx=o.x-p.x,ry=o.y-p.y,d=Math.hypot(rx,ry);if(d>POWER.gunRange||d<1)continue;
      const dot=rx*vx+ry*vy;if(dot<=0||Math.atan2(Math.abs(rx*vy-ry*vx),dot)>half+Math.atan2(POWER.gunHitR,d))continue;
      if(now<o.shieldUntil){o.shieldUntil=0;o.protect=now+500;this.room.ea(this,'ev',{t:'sb',p:o.id})}
      else{o.stunUntil=now+POWER.stunMs;o.vx=o.vy=0;o.act=null;hit.push(o.id)}}
    this.dirty=true;this.room.ea(this,'ev',{t:'sh',p:p.id,x:+p.x.toFixed(1),y:+p.y.toFixed(1),dx:+vx.toFixed(3),dy:+vy.toFixed(3),len:POWER.gunRange,half:+half.toFixed(3),h:hit})}
  rr(a){return a[0]+Math.random()*(a[1]-a[0])}
  spawnDrops(now,r){const c=this.cfg;if(!c.pvp||r<150)return;
    if(!this.nextDrop){this.nextDrop=now+this.rr(POWER.dropFirst);return}
    if(now<this.nextDrop)return;this.nextDrop=now+this.rr(POWER.dropEvery);
    if(this.drops.filter(d=>!d.taken).length>=POWER.maxDrops)return;
    const k=Math.random()<POWER.gunChance&&this.gunDrops<POWER.gunMaxPerRound?'gun':'shield';
    for(let t=0;t<30;t++){const a=Math.random()*6.2832,d=Math.sqrt(Math.random())*(r-70),x=Math.cos(a)*d,y=Math.sin(a)*d;
      if(!this.stations.every(S=>Math.hypot(S.x-x,S.y-y)>80)||!this.layout.every(o=>Math.hypot(o.x-x,o.y-y)>34))continue;
      if(k==='gun')this.gunDrops++;
      const dr={id:this.drops.length,k,x:+x.toFixed(1),y:+y.toFixed(1),landAt:now+POWER.fallMs,taken:false};this.drops.push(dr);
      this.room.ea(this,'ev',{t:'dr',id:dr.id,k,x:dr.x,y:dr.y,landAt:dr.landAt});break}}
  pickDrops(p,now){if(!this.cfg.pvp)return;
    for(const d of this.drops){if(d.taken||now<d.landAt||Math.hypot(d.x-p.x,d.y-p.y)>POWER.pickR)continue;
      d.taken=true;if(d.k==='gun')p.gun=POWER.gunShots;else p.hasShield=true;p.pwD=true;this.dirty=true;this.room.ea(this,'ev',{t:'dt',id:d.id,p:p.id,k:d.k});break}}
  // ---- revive: a living teammate standing next to a crocodile victim for 3 s (within 10 s of the death) brings them back
  tickRevive(now,dt,ps,r){
    for(const d of ps){if(d.status!=='failed'||!d.revivable)continue;
      if(now-d.deadAt>REVIVE.windowMs||r<=this.cfg.failR+10||Math.hypot(d.x,d.y)>r-8){d.revivable=false;d.rv=0;this.dirty=true;continue}
      const n=ps.find(q=>q.status==='alive'&&q.tid===d.tid&&now>=q.stunUntil&&Math.hypot(q.x-d.x,q.y-d.y)<REVIVE.r);
      if(!n){d.rv=0;continue}
      d.rv+=dt*1000;
      if(d.rv>=REVIVE.holdMs){d.status='alive';d.revivable=false;d.rv=0;d.protect=now+REVIVE.protectMs;d.ix=d.iy=0;d.vx=d.vy=0;d.invD=true;d.pwD=true;this.dirty=true;this.room.ea(this,'ev',{t:'rv',p:d.id,by:n.id})}}
  }
  // ---- bots: skill 0..1 (rookies wander, react slowly and dodge badly; experts are quick, dodge crocodiles, push, shoot and use shields)
  botMove(p,wx,wy,sp){const ix=(wx-wy)/1.414,iy=(wx+wy)*1.414/4,l=Math.hypot(ix,iy)||1;p.ix=ix/l*sp;p.iy=iy/l*sp;if(p.ix)p.face=p.ix>0?1:-1} // world direction -> screen input
  botAI(p,now,r,ps){
    if(p.status!=='alive'||now<this.startAt||now<p.stunUntil){p.ix=p.iy=0;return}
    if(now<p.bNext)return;
    const c=this.cfg,sk=p.skill,S=this.stations.find(s=>s.tid===p.tid),need=c.need;p.bNext=now+220+(1-sk)*480+Math.random()*160;
    let fx=0,fy=0; // 1) dodge crocodiles
    for(const q of this.crocs){if(q.st==='wait'||(q.st==='warn'&&sk<.7)||Math.random()>.4+sk*.6)continue;
      const sp=Math.hypot(q.vx,q.vy)||1,ux=q.vx/sp,uy=q.vy/sp,rx=p.x-q.x,ry=p.y-q.y,al=rx*ux+ry*uy,pp=rx*uy-ry*ux;
      if(al>-60&&al<300&&Math.abs(pp)<85){const sg=pp>=0?1:-1;fx+=uy*sg;fy+=-ux*sg}}
    if(fx||fy){if(p.hasShield&&sk>.5&&this.crocs.some(q=>q.st==='run'&&Math.hypot(q.x-p.x,q.y-p.y)<110))this.shield(p,now);const l=Math.hypot(fx,fy);this.botMove(p,fx/l,fy/l,1);return}
    let tx=null,ty=null;
    if(c.pvp){ // 2) fight: gun, push, shield, and grab nearby airdrops
      let e=null,ed=1e9;for(const o of ps){if(o===p||o.status!=='alive'||o.tid===p.tid)continue;const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<ed){ed=d;e=o}}
      if(e&&sk>.45){
        if(p.gun>0&&ed<POWER.gunRange-40&&Math.random()<.5)this.fire(p,(e.x-p.x)/ed,(e.y-p.y)/ed,now);
        else if(ed<CFG.push.range-6&&now>=p.pushCd&&Math.random()<sk)this.push(p,now);
        if(p.hasShield&&ed<140&&Math.random()<.35)this.shield(p,now)}
      if(sk>.4){let bd=220;for(const d of this.drops)if(!d.taken&&now>=d.landAt-600){const dd=Math.hypot(d.x-p.x,d.y-p.y);if(dd<bd){bd=dd;tx=d.x;ty=d.y}}}
    }
    if(tx===null){const dead=ps.find(q=>q.status==='failed'&&q.revivable&&q.tid===p.tid&&now-q.deadAt<REVIVE.windowMs-3500&&Math.hypot(q.x,q.y)<r-10);
      if(dead&&sk>.35){tx=dead.x;ty=dead.y} // 3) revive a fallen teammate
      else if(S&&S.done){tx=S.x;ty=S.y}
      else if(S&&S.dead){tx=0;ty=0}
      else{const rem=k=>need[k]-(S?S[k]:0)-p.inv[k];let best=null,bd=1e9;
        if(rem('w')>0||rem('l')>0||rem('c')>0)this.layout.forEach((n,i)=>{const k=KIND[n.k];if(!k||this.left[i]<=0||rem(k)<=0||Math.hypot(n.x,n.y)>r-14)return;
          const d=Math.hypot(n.x-p.x,n.y-p.y)+Math.random()*(1-sk)*140;if(d<bd){bd=d;best=n}});
        if(best){tx=best.x;ty=best.y}else if(S){tx=S.x;ty=S.y}}}
    if(tx===null){p.ix=p.iy=0;return}
    let dx=tx-p.x,dy=ty-p.y;const d=Math.hypot(dx,dy);if(d<10){p.ix=p.iy=0;return}
    dx/=d;dy/=d;const w=(1-sk)*.9*(Math.random()-.5),cs=Math.cos(w),sn=Math.sin(w);
    this.botMove(p,dx*cs-dy*sn,dx*sn+dy*cs,Math.random()<(1-sk)*.12?0:1);
  }
  tickCrocs(now,dt,r,ps){
    const K=CFG.croc;
    for(const q of this.crocs){
      if(q.st==='wait'){
        if(now<q.t)continue;
        const a=Math.random()*6.2832,sx=Math.cos(a)*(r-10),sy=Math.sin(a)*(r-10),ta=Math.random()*6.2832,td=Math.sqrt(Math.random())*r*.5,dx=Math.cos(ta)*td-sx,dy=Math.sin(ta)*td-sy,l=Math.hypot(dx,dy)||1;
        q.x=sx;q.y=sy;q.vx=dx/l*K.speed*(this.cfg.spdK||1);q.vy=dy/l*K.speed*(this.cfg.spdK||1);q.st='warn';q.t=now+K.warnMs;q.age=0; // random straight line through the island
      }else if(q.st==='warn'){if(now>=q.t)q.st='run'}
      else{
        q.x+=q.vx*dt;q.y+=q.vy*dt;q.age+=dt;
        if(q.age>1&&Math.hypot(q.x,q.y)>r+30){q.st='wait';q.t=now+K.respawnMs[0]+Math.random()*(K.respawnMs[1]-K.respawnMs[0]);continue}
        for(const p of ps)if(p.status==='alive'&&Math.hypot(p.x-q.x,p.y-q.y)<K.hitR){
          if(now<p.protect)continue;
          if(now<p.shieldUntil){p.shieldUntil=0;p.protect=now+900;this.dirty=true;this.room.ea(this,'ev',{t:'sb',p:p.id});continue} // shield pops, crocodile cannot bite this time
          p.status='failed';p.ix=p.iy=0;p.vx=p.vy=0;p.act=null;p.cause='croc';p.deadAt=now;p.rv=0;p.revivable=((this.room.teams[p.tid]||{pids:[]}).pids.length>1);this.dirty=true;this.room.ea(this,'ev',{t:'k',p:p.id,cid:q.id})}
      }
    }
  }
  tick(now){
    const R=this.room,c=this.cfg,PU=CFG.push;
    if(this.state==='COUNTDOWN'&&now>=this.startAt){this.state='PLAYING';this.dirty=true}
    if(this.state!=='COUNTDOWN'&&!PH.includes(this.state))return;
    const dt=Math.min(.2,(now-this.last)/1000);this.last=now;this.tickN++;
    const live=now>=this.startAt,el=(now-this.startAt)/1000;
    let r;
    if(this.col){const k=Math.min(1,(now-this.col.t0)/this.col.ms);r=this.col.r0+(this.col.r1-this.col.r0)*k*k}else r=radius(Math.max(0,el),c);
    this.r=r;
    const ps=this.members(),k=this.tickN%Math.max(1,ps.length),order=ps.slice(k).concat(ps.slice(0,k)); // rotate so ties are fair
    for(const p of order){
      if(p.bot)this.botAI(p,now,r,ps);
      if(p.status==='boarded'&&c.mode==='coop'&&!R.solo&&Math.hypot(p.ix,p.iy)>.4){ // multiplayer co-op: steering = get off the vehicle, countdown resets
        const S=this.stations.find(s=>s.tid===p.tid);
        if(S&&!S.flooding&&!S.launched){const vx=(p.ix+2*p.iy)/1.414,vy=(2*p.iy-p.ix)/1.414,l=Math.hypot(vx,vy)||1;
          p.status='alive';p.seat=-1;p.escAt=0;p.noBoard=now+1200;if(!ps.some(q=>q!==p&&q.tid===S.tid&&q.status==='boarded'))S.cdAt=0; /* nobody aboard any more: countdown resets */ p.x=S.x+vx/l*(c.boardR+18);p.y=S.y+vy/l*(c.boardR+18);this.dirty=true;R.ea(this,'ev',{t:'u',p:p.id})}
      }
      if(p.status!=='alive')continue;
      let moving=false;if(now<p.stunUntil)p.vx=p.vy=0;
      if(p.vx||p.vy){p.x+=p.vx*dt;p.y+=p.vy*dt;const f=Math.exp(-PU.decay*dt);p.vx*=f;p.vy*=f;if(Math.hypot(p.vx,p.vy)<5)p.vx=p.vy=0}
      if((p.ix||p.iy)&&now>=p.stunUntil){
        if(p.bot||!p.mvCap){const sp=c.speed*(p.act?c.collectSlow:1),vx=(p.ix+2*p.iy)/1.414,vy=(2*p.iy-p.ix)/1.414;p.x+=vx*sp*dt;p.y+=vy*sp*dt;moving=true} // bots (and very old clients): the server steps them
        else if(now-p.mvMoveAt<160)moving=true; // real players move only through validated 'mv' positions (Room.setPos): no server-side extra steps after they let go
      }
      const d=Math.hypot(p.x,p.y),mx=r-12;if(d>mx){p.x*=mx/d;p.y*=mx/d}
      p.moving=moving;
      if(!live||now<p.stunUntil)continue; // countdown = spawn protection: movement only (stunned players can't act)
      this.collect(p,now,r);this.pickDrops(p,now);
      this.board(p,now);
    }
    // stations: build (global rate limit per station) + sinking
    for(const S of this.stations){
      if(c.comp&&!S.dead&&Math.hypot(S.x,S.y)>r-6){S.dead=true;this.dirty=true;R.ea(this,'ev',{t:'d',s:S.id})}
      if(S.done||S.dead||!live)continue;
      S.cd-=dt*1000;if(S.cd>0)continue;
      const need=c.need,near=ps.filter(p=>p.status==='alive'&&now>=p.stunUntil&&p.tid===S.tid&&Math.hypot(p.x-S.x,p.y-S.y)<c.buildR);
      for(let j=0;j<near.length;j++){const p=near[(S.rr+j)%near.length];
        if(S.w<need.w&&p.inv.w>0){p.inv.w--;S.w++}else if(S.l<need.l&&p.inv.l>0){p.inv.l--;S.l++}else if(S.c<need.c&&p.inv.c>0){p.inv.c--;S.c++}else continue;
        S.rr=(S.rr+j+1)%near.length;S.cd=c.contribMs||CFG.contribMs;p.buildT=now;p.invD=true;this.dirty=true;R.ea(this,'ev',{t:'b',p:p.id,s:S.id});break}
      if(S.w>=need.w&&S.l>=need.l&&S.c>=need.c){S.done=true;this.dirty=true;if(this.state==='PLAYING')this.state='RAFT_READY';R.ea(this,'ev',{t:'r',s:S.id})}
    }
    if(live){this.spawnEnergy(now,el,r);if(this.crocs.length)this.tickCrocs(now,dt,r,ps);this.spawnDrops(now,r);this.tickRevive(now,dt,ps,r)}
    if(c.mode==='coop'){const act=ps.filter(p=>p.status!=='spectator');if(act.length&&act.every(p=>p.status==='failed')){R.finish(this,now);return}} // whole team eliminated (spectators don't count)
    // water: anyone not on a vehicle when it hits failR drowns
    if(r<=c.failR){let any=false;for(const p of ps)if(p.status==='alive'){p.status='failed';p.cause='water';p.ix=p.iy=0;p.vx=p.vy=0;p.act=null;any=true;R.ea(this,'ev',{t:'f',p:p.id})}
      if(any){this.dirty=true;if(c.mode==='tourney'){R.checkElim(this,now);if(R.state!=='PLAYING')return}}}
    // multiplayer co-op: a player's own countdown reaching 0 starts the departure
        // multiplayer co-op: launch when any boarded player's 10 s timer expires,
    // OR when every living player is already boarded
    if(c.mode==='coop'&&!R.solo){
      const S0=this.stations[0];
      if(S0&&!S0.launchAt&&!S0.launched&&!S0.flooding){
        const live=ps.filter(p=>(p.status==='alive'||p.status==='boarded')&&!p.offline);
        const allBoarded=live.length&&live.every(p=>p.status==='boarded');
        if(allBoarded||(S0.cdAt&&now>=S0.cdAt))S0.launchAt=now; // leaves when everyone is aboard, or when the countdown runs out (anyone not aboard is left behind and spectates from the next level)
      }
    }
    const Ls=this.stations.filter(S=>S.launchAt&&!S.launched&&!S.flooding&&now>=S.launchAt).sort((a,b)=>a.launchAt-b.launchAt||a.id-b.id);
    if(Ls.length&&!this.col)this.startFlood(Ls[0],now,r);
    const Ds=this.stations.filter(S=>S.flooding&&!S.launched&&now>=S.departAt);
    if(Ds.length){R.launch(this,Ds[0],now);if(R.state!=='PLAYING'||this.over)return}
    if(r<=c.endR+5){R.arenaEnd(this,now);return}
    for(const p of ps)p.anim=p.status==='boarded'?'sit':now-p.pushT<300?'push':now-p.hitT<350?'hit':p.act?'collect':now-p.buildT<400?'build':now-p.collT<350?'collect':p.moving?'walk':'idle';
    R.ea(this,'pos',{t:now,p:ps.map(p=>[p.id,+p.x.toFixed(1),+p.y.toFixed(1),p.anim,p.face,p.mvSeq|0]),c:this.crocs.length?this.crocs.map(q=>[q.id,+q.x.toFixed(1),+q.y.toFixed(1),Math.round(q.vx),Math.round(q.vy),q.st==='warn'?1:q.st==='run'?2:0]):undefined,rv:ps.some(p=>p.revivable&&p.status==='failed')?ps.filter(p=>p.revivable&&p.status==='failed').map(p=>[p.id,+Math.min(1,p.rv/REVIVE.holdMs).toFixed(2),Math.max(0,REVIVE.windowMs-(now-p.deadAt))|0]):undefined});
    if(this.dirty){this.dirty=false;R.ea(this,'world',this.world())}
    for(const p of ps)if(p.invD){p.invD=false;R.emit('inv',{w:p.inv.w,l:p.inv.l,c:p.inv.c,pcd:Math.max(0,p.pushCd-now),pl:p.pushLen||CFG.push.cdMs},[p.id])}
    for(const p of ps)if(p.pwD){p.pwD=false;R.emit('pw',{sh:p.hasShield?1:0,gn:p.gun},[p.id])}
  }
}

class Room{
  constructor(code,emit){
    this.code=code;this.emit=emit;this.solo=false;this.state='LOBBY';this.mode='coop';this.teamMode='ffa';this.players=new Map();this.host=null;this.teams=[];
    this.arenas=new Map();this.tm=new Map();this.tickN=0;this.aidN=0;this.winner=null;this.seed=0;this.boardJ='';this.boardAt=0;this.overMsg=null;
    this.reviveUsed=false;this.onScore=null;this.public=false;this.botAt=0;this.nextBot=0;this.autoAt=0;this.lobbyAt=0;this.botN=0;this.lastRound=1;this.lastWins={};this.roundBreak=0;
  }
  pl(){return[...this.players.values()]}
  humans(){return this.pl().filter(p=>!p.bot).length}
  hasBot(){return this.pl().some(p=>p.bot)}
  ea(a,e,d){if(this.mode==='tourney')this.emit(e,d,this.pl().filter(p=>p.aid===a.id).map(p=>p.id));else this.emit(e,d)}
  addPlayer(id,token){
    let idx=0;const used=new Set(this.pl().map(p=>p.idx));while(used.has(idx))idx++;
    const p=Object.assign({id,token,idx,name:'Player '+(idx+1),color:COLORS[idx],tid:0,aid:0,x:0,y:0,offline:false,offAt:0,spec:false,skin:'default',ownedSkins:[]},GAMEF());
    this.players.set(id,p);this.tm.set(id,idx%2);if(!this.host)this.host=id;
    if(this.public){const n=Date.now(),H=this.humans();this.autoAt=H>=CFG.maxPlayers?Math.min(this.autoAt||n+3000,n+3000):Math.max(this.autoAt||n+BOT.autoStartMs,n+BOT.joinGraceMs)}
    this.lobby();return p;
  }
  makeRoom(){if(this.players.size>=CFG.maxPlayers){const b=this.pl().filter(p=>p.bot).pop();if(b)this.removePlayer(b.id)}} // a joining human pushes a bot out
  addBot(){let idx=0;const used=new Set(this.pl().map(p=>p.idx));while(used.has(idx))idx++;if(idx>=CFG.maxPlayers)return null;
    const id='bot_'+(++this.botN)+Math.random().toString(36).slice(2,5),nm=BOT.names[(Math.random()*BOT.names.length)|0];
    const p=Object.assign({id,token:'',idx,name:nm+' 🤖',color:COLORS[idx],tid:0,aid:0,x:0,y:0,offline:false,offAt:0,spec:false,skin:SKINS_FREE_BOT[(Math.random()*SKINS_FREE_BOT.length)|0],ownedSkins:[],bot:true,skill:BOT.levels[(Math.random()*BOT.levels.length)|0],bNext:0},GAMEF());
    this.players.set(id,p);this.tm.set(id,idx%2);this.lobby();return p}
  takeOver(id,token){ // a real player joins a running public match: they take over a bot's character (bot leaves)
    const b=this.pl().find(p=>p.bot);if(!b)return null;const old=b.id,t=this.tm.get(old);
    this.players.delete(old);this.tm.delete(old);b.id=id;b.token=token;b.bot=false;b.skill=0;b.name='Player '+(b.idx+1);b.skin='default';b.offline=false;b.ix=b.iy=0;
    this.players.set(id,b);this.tm.set(id,t||0);this.teams.forEach(T=>{T.pids=T.pids.map(x=>x===old?id:x)});
    const a=this.arenas.get(b.aid);if(a)a.dirty=true;this.emit('sys',{msg:'A player replaced a bot'});this.lobby();return b}
  publicTick(now){ // public lobby: bots fill the gap and leave as real players arrive; the match auto-starts
    const H=this.humans();if(!H)return;if(!this.botAt)this.botAt=now+BOT.fillDelayMs;if(!this.autoAt)this.autoAt=now+BOT.autoStartMs;
    const bots=this.pl().filter(p=>p.bot),want=Math.max(0,BOT.fillTo-H);
    if(bots.length>want){this.removePlayer(bots[bots.length-1].id);return}
    if(bots.length<want&&now>=this.botAt&&now>=this.nextBot){this.addBot();this.nextBot=now+1200}
    if(now>=this.autoAt&&this.canStart(false).ok){this.start(now);return}
    if(now>=this.lobbyAt){this.lobbyAt=now+1000;this.lobby()}
  }
  removePlayer(id){
    const p=this.players.get(id);if(!p)return;this.players.delete(id);this.tm.delete(id);
    if(this.host===id){const on=this.pl().find(q=>!q.offline&&!q.bot);this.host=(on||this.pl().find(q=>!q.bot)||{}).id||null}
    this.emit('sys',{msg:p.name+(p.bot?' left':' disconnected')});
    if(this.state==='PLAYING'){const T=this.teams[p.tid];if(T){T.pids=T.pids.filter(x=>x!==id);
      if(!T.pids.length&&T.status!=='eliminated'&&this.mode!=='coop'){T.status='eliminated';T.elimAt=Date.now();if(this.mode==='tourney')this.checkTourneyEnd(Date.now())}}}
    const a=this.arenas.get(p.aid);if(a)a.dirty=true;this.lobby();
  }
  setOffline(id,now){const p=this.players.get(id);if(!p)return;p.offline=true;p.offAt=now+CFG.offlineMs;p.ix=p.iy=0;
    if(this.host===id){const on=this.pl().find(q=>!q.offline&&!q.bot);if(on)this.host=on.id}
    const a=this.arenas.get(p.aid);if(a)a.dirty=true;this.emit('sys',{msg:p.name+' lost connection'});this.lobby()}
  resume(id,token){const p=this.players.get(id);if(!p||p.token!==token)return null;p.offline=false;const a=this.arenas.get(p.aid);if(a)a.dirty=true;return p}
  housekeep(now){for(const p of this.pl())if(p.offline&&now>p.offAt)this.removePlayer(p.id)}
  canStart(solo){
    const n=this.players.size;if((solo||this.solo)&&n>=1)return{ok:true};
    if(n<CFG.minPlayers)return{ok:false,why:'Waiting for another player…'};
    if(this.mode!=='coop'&&this.teamMode==='teams'){const a=this.pl().filter(p=>this.tm.get(p.id)!==1).length;if(a===0||a===n)return{ok:false,why:'Each team needs at least one player'}}
    return{ok:true};
  }
  lobby(to){
    const cs=this.canStart(false);
    this.emit('lobby',{solo:this.solo,code:this.code,host:this.host,state:this.state,min:CFG.minPlayers,mode:this.mode,teamMode:this.teamMode,ok:cs.ok,why:cs.why||'',pub:this.public?1:0,auto:this.public&&this.autoAt?Math.max(0,Math.ceil((this.autoAt-Date.now())/1000)):0,
      players:this.pl().map(p=>({id:p.id,name:p.name,color:p.color,t:this.teamMode==='teams'&&this.mode!=='coop'?(this.tm.get(p.id)===1?1:0):-1,off:p.offline?1:0,bot:p.bot?1:0}))},to);
  }
  setName(id,n){const p=this.players.get(id);if(!p||p.bot||typeof n!=='string')return;n=n.replace(/[^\p{L}\p{N} _.-]/gu,'').trim().slice(0,14);if(!n)return;p.name=n;const a=this.arenas.get(p.aid);if(a)a.dirty=true;this.lobby()}
  ident(id,d){const p=this.players.get(id);if(!p||p.bot||!d)return;if(typeof d.uid==='string'&&/^[a-f0-9]{16,32}$/.test(d.uid))p.uid=d.uid;if(d.name)this.setName(id,d.name)}
  reviveSolo(id,now){ // Solo only, once per run: low tide gives 15 s more + enough resources to finish the level
    if(!this.solo||this.mode!=='coop'||this.state!=='GAME_OVER'||this.reviveUsed)return false;
    const p=this.players.get(id),a=p&&this.arenas.get(p.aid);if(!a||p.status!=='failed')return false;
    const c=a.cfg,S=a.stations.find(s=>s.tid===p.tid);if(!S||S.launched)return false;
    this.reviveUsed=true;
    const el=Math.max(0,(now-a.startAt)/1000),left=Math.min(el,c.duration-REVIVE_LEFT_S);a.startAt=now-left*1000; // island grows back to its size at (duration-15 s)
    a.over=false;a.state=S.done?'RAFT_READY':'PLAYING';this.state='PLAYING';this.overMsg=null;a.col=null;a.last=now;
    const r=radius(left,c),n=c.need;a.r=r;
    p.inv={w:Math.max(0,n.w-S.w)+1,l:Math.max(0,n.l-S.l)+1,c:n.c>0?Math.max(0,n.c-S.c)+1:0}; // more than required
    let ux=-S.x,uy=-S.y;const ul=Math.hypot(ux,uy)||1;p.x=S.x+ux/ul*34;p.y=S.y+uy/ul*34;const pl=Math.hypot(p.x,p.y);if(pl>r-14){p.x*=(r-14)/pl;p.y*=(r-14)/pl}
    Object.assign(p,{status:'alive',seat:-1,cause:null,ix:0,iy:0,vx:0,vy:0,act:null,stunUntil:0,protect:now+3500,invD:true,pwD:true});
    a.crocs.forEach(q=>{q.st='wait';q.t=now+5000});a.dirty=true;
    this.emit('rev',{startAt:a.startAt,endAt:a.startAt+c.duration*1000,serverNow:now});this.ea(a,'world',a.world());this.lobby();this.emitBoard(now,true);return true}
  setSkin(id,s){const p=this.players.get(id);if(p&&typeof s==='string'&&s.length<20&&skinAllowed(p,s))p.skin=s}
  setMode(id,d){if(this.host!==id||this.state!=='LOBBY'||!d)return;if(typeof d.public==='boolean'&&!this.solo){this.public=d.public;this.autoAt=0;this.botAt=0;if(!d.public)this.pl().filter(p=>p.bot).forEach(p=>this.removePlayer(p.id))}
    if(MODES[d.mode])this.mode=d.mode;if(d.teamMode==='ffa'||d.teamMode==='teams')this.teamMode=d.teamMode;this.lobby()}
  setTeam(id,d){if(!d||this.state!=='LOBBY'||!this.players.has(d.id)||(this.host!==id&&d.id!==id))return; // anyone may switch themselves; the host may move anyone
    this.tm.set(d.id,d.t?1:0);this.lobby()}
  setInput(id,d){const p=this.players.get(id);if(!p||!d)return;let x=+d.x||0,y=+d.y||0;const m=Math.hypot(x,y);if(m>1){x/=m;y/=m}p.ix=x;p.iy=y;if(x)p.face=x>0?1:-1}
  // The joystick moves the character on the player's own device; this method only VALIDATES the reported position.
  // Movement is limited by a speed budget measured in joystick (screen) space, so a legitimate player is never held back,
  // while teleporting or speed-hacking is clamped. The server stays the authority for pushes, stuns, deaths and the island edge.
  setPos(id,d,now){
    const p=this.players.get(id);if(!p||p.bot||!d)return;
    const a=this.arenas.get(p.aid);if(!a||a.over||this.state!=='PLAYING')return;
    if(a.state!=='COUNTDOWN'&&!PH.includes(a.state))return;
    const x=+d.x,y=+d.y;if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>6000||Math.abs(y)>6000)return;
    p.mvCap=true;                         // this client moves itself: the server stops stepping its input
    if(p.status!=='alive')return;
    p.mvSeq=(+d.s||0)|0;                  // acknowledged in the next snapshot
    if(now<p.stunUntil||now<p.mvLock||p.vx||p.vy){p.mvAt=now;return} // stunned / sliding: the server decides where the player is
    const c=a.cfg,sp=c.speed*1.25;        // 25% tolerance for timing jitter
    const el=p.mvAt?Math.min(.5,Math.max(0,(now-p.mvAt)/1000)):.1;p.mvAt=now;
    p.mvBud=Math.min(sp*.35,(p.mvBud||0)+sp*el); // unused allowance may bank up to 0.35 s of travel (absorbs bursty networks)
    let dx=x-p.x,dy=y-p.y;
    const sx=(dx-dy)*.7071,sy=(dx+dy)*.35355,L=Math.hypot(sx,sy); // world delta -> joystick space (inverse of the movement mapping)
    if(L>.001){if(L>p.mvBud){const k=p.mvBud/L;dx*=k;dy*=k;p.mvBud=0}else p.mvBud-=L}
    let nx=p.x+dx,ny=p.y+dy;const m=Math.hypot(nx,ny),mx=(a.r||1e9)-12;if(m>mx){nx*=mx/m;ny*=mx/m}
    if(L>.05)p.mvMoveAt=now;
    p.x=nx;p.y=ny;
  }
  push(id,now){const p=this.players.get(id);if(!p||this.state!=='PLAYING')return;const a=this.arenas.get(p.aid);if(a&&!a.over)a.push(p,now)}
  shield(id,now){const p=this.players.get(id);if(!p||this.state!=='PLAYING')return;const a=this.arenas.get(p.aid);if(a&&!a.over)a.shield(p,now)}
  shoot(id,d,now){const p=this.players.get(id);if(!p||this.state!=='PLAYING')return;const a=this.arenas.get(p.aid);if(a&&!a.over)a.shoot(p,d,now)}
  buildTeams(){
    const ps=this.pl(),T=[];
    if(this.mode==='coop')T.push({name:'CREW',color:'#ffffff',pids:ps.map(p=>p.id)});
    else if(this.teamMode==='teams'){const g=[[],[]];ps.forEach(p=>g[this.tm.get(p.id)===1?1:0].push(p));
      g.forEach((m,i)=>{if(m.length)T.push({name:TNAME[i],color:TCOL[i],pids:m.map(p=>p.id)})})}
    else ps.forEach(p=>T.push({name:p.name,color:COLORS[p.idx],pids:[p.id]}));
    this.teams=T.map((t,i)=>Object.assign(t,{id:i,stage:1,status:'active',aid:0,nextAt:0,elimAt:0}));
    this.teams.forEach(t=>t.pids.forEach(id=>{const p=this.players.get(id);p.tid=t.id;if(this.mode!=='coop')p.color=t.color}));
  }
  start(now){
    this.state='PLAYING';this.winner=null;this.overMsg=null;this.arenas=new Map();this.aidN=0;this.reviveUsed=false;this.lastRound=1;this.lastWins={};this.roundBreak=0;this.autoAt=0;this.seed=(Math.random()*2147483647)|0;this.boardJ='';
    this.pl().forEach(p=>{p.spec=false;p.reach=1});this.buildTeams();
    if(this.mode==='tourney')this.teams.forEach(t=>{t.aid=this.makeArena([t.id],now).id});
    else{const a=this.makeArena(this.teams.map(t=>t.id),now);this.teams.forEach(t=>t.aid=a.id)}
    this.lobby();this.emitBoard(now,true);
  }
  makeArena(tids,now){
    const T0=this.teams[tids[0]],stage=this.mode==='tourney'||this.mode==='coop'?T0.stage:1,cfg=arenaCfg(this.mode,stage,this.solo);
    const a=new Arena(this,++this.aidN,{cfg,tids,seed:(this.seed+stage*7919)|0,startAt:now+CFG.countdownMs,now});
    this.arenas.set(a.id,a);let i=0;
    tids.forEach((tid,k)=>{const T=this.teams[tid],all=T.pids.map(id=>this.players.get(id)).filter(Boolean);
      let mem=all.filter(p=>!p.spec);
      if(this.mode==='coop'&&!mem.length){all.forEach(p=>p.spec=false);mem=all} // safety net: never start a level with nobody to play it
      all.filter(p=>p.spec).forEach(p=>Object.assign(p,GAMEF(),{x:0,y:0,aid:a.id,tid,status:'spectator'})); // eliminated players only watch
      mem.forEach((p,j)=>Object.assign(p,GAMEF(),a.spawnFor(k,j,mem.length,i++),{aid:a.id,tid}));
      if(this.mode==='coop'){mem.forEach(p=>{p.reach=stage;if(this.onScore&&!p.bot&&p.uid)this.onScore({uid:p.uid,name:p.name,kind:this.solo?'solo':'mp',level:stage})})}}); // reach = last level this player was still alive to play (spectators stop counting)
    this.ea(a,'round',this.roundMsg(a,now));
    return a;
  }
  roundMsg(a,now){
    return{cfg:a.cfg,mode:this.mode,stage:a.cfg.stage,stages:this.mode==='tourney'?MODES.tourney.stages.length:0,solo:this.solo,stageName:a.cfg.name||'',seed:a.seed,layout:a.layout,
      stations:a.stations.map(S=>({id:S.id,tid:S.tid,x:S.x,y:S.y,kind:S.kind})),teams:this.teams.map(t=>({id:t.id,name:t.name,color:t.color})),
      startAt:a.startAt,endAt:a.startAt+a.cfg.duration*1000,serverNow:now,world:a.world(),drops:a.drops.filter(d=>!d.taken),lr:this.mode==='last'?{n:this.lastRound,total:LAST_ESCAPE.rounds,wins:this.lastWins}:undefined};
  }
  snapshot(id){ // used when a player reconnects
    const p=this.players.get(id);this.lobby([id]);
    if(this.state==='PLAYING'&&p){const a=this.arenas.get(p.aid);if(a)this.emit('round',this.roundMsg(a,Date.now()),[id]);this.emit('board',this.boardMsg(),[id])}
    else if(this.state==='GAME_OVER'&&this.overMsg)this.emit('over',this.overMsg,[id]);
  }
  toLobby(){this.state='LOBBY';this.autoAt=0;this.roundBreak=0;this.arenas.clear();this.teams=[];this.winner=null;this.overMsg=null;
    this.pl().forEach(p=>Object.assign(p,GAMEF(),{x:0,y:0,color:COLORS[p.idx],tid:0,aid:0,spec:false}));this.lobby()}
  progOf(T){const a=this.arenas.get(T.aid);if(!a)return 0;const S=a.stations.find(s=>s.tid===T.id);if(!S)return 0;const n=a.cfg.need,tot=n.w+n.l+n.c;return Math.min(100,Math.round(100*(S.done?tot:S.w+S.l+S.c)/tot))}
  boardMsg(){ // coarse competitor info only: stage, state, approx progress (never exact inventories)
    return{rows:this.teams.map(T=>{const a=this.arenas.get(T.aid),S=a&&a.stations.find(s=>s.tid===T.id),prog=this.progOf(T);let s='COLLECTING';
      if(T.status==='eliminated')s='ELIMINATED';else if(T.status==='escaped'||T.status==='transition')s='ESCAPED';else if(this.winner!=null&&this.mode==='last')s='LOST';
      else if(S&&S.done)s='READY';else if(prog>0)s='BUILDING';
      const pr=s==='ESCAPED'?100:prog;return{id:T.id,name:T.name,color:T.color,stage:T.stage,st:s,prog:pr,sc:(T.stage-1)*100+pr+(s==='ELIMINATED'?-1000:0)}})};
  }
  emitBoard(now,force){
    if(this.mode==='coop'||!this.teams.length)return;
    const m=JSON.stringify(this.boardMsg());
    if(m!==this.boardJ&&(force||now-this.boardAt>250)){this.boardJ=m;this.boardAt=now;this.emit('board',JSON.parse(m))}
  }
  tick(now){
    this.housekeep(now);
    if(this.state==='LOBBY'&&this.public)this.publicTick(now);
    if(this.roundBreak&&now>=this.roundBreak&&this.state==='PLAYING'){this.roundBreak=0;this.nextLastRound(now)}
    if(this.state!=='PLAYING')return;
    this.tickN++;
    const as=[...this.arenas.values()],k=this.tickN%Math.max(1,as.length);
    for(const a of as.slice(k).concat(as.slice(0,k))){if(!a.over)a.tick(now);if(this.state!=='PLAYING')return}
    if(this.mode==='tourney'||this.mode==='coop')for(const T of this.teams)if(T.status==='transition'&&now>=T.nextAt)this.nextStage(T,now);
    this.emitBoard(now,false);
  }
  nextStage(T,now){
    T.stage++;T.status='active';this.arenas.delete(T.aid);T.aid=this.makeArena([T.id],now).id;
  }
  launch(a,S,now){
    const T=this.teams[S.tid];
    const carry=()=>{ // Co-op: only seated players escape (others stay and drown). Other modes: the whole team rides.
      this.pl().filter(p=>p.tid===S.tid&&p.aid===a.id&&(p.status==='boarded'||(p.status==='alive'&&this.mode!=='coop'))).forEach(p=>{
        if(p.status==='alive'){p.seat=a.freeSeat(S);p.x=S.x+(p.seat%2)*20-10;p.y=S.y+(p.seat>>1)*20-10;p.boardedAt=p.boardedAt||now}
        p.status='escaped';p.escAt=0;p.ix=p.iy=0;p.vx=p.vy=0;p.act=null});
    };
    if(this.mode==='last'){
      if(this.winner!=null){S.launchAt=0;return}
      this.winner=S.tid;S.launched=true;T.status='escaped';T.escAt=now;carry();
      a.col={t0:now,r0:a.r,r1:CFG.endR,ms:CFG.collapseMs};a.state='COLLAPSE';a.dirty=true; // island destruction
      a.stations.forEach(o=>{if(o!==S&&!o.launched)o.launchAt=0});
      this.ea(a,'ev',{t:'l',s:S.id,tid:S.tid});this.emitBoard(now,true);
    }else if(this.mode==='tourney'||this.mode==='coop'){ // tournament stages / co-op levels
      S.launched=true;carry();this.leaveBehind(a,S);a.dirty=true;
      const final=this.mode==='tourney'&&T.stage>=MODES.tourney.stages.length;
      this.ea(a,'ev',{t:'l',s:S.id,tid:S.tid,stage:T.stage,final:final?1:0});
      if(final){this.winner=T.id;T.status='escaped';this.ea(a,'world',a.world());this.finishTourney(now);return}
      T.status='transition';T.nextAt=now+CFG.transitionMs;a.over=true;this.ea(a,'world',a.world());
      this.ea(a,'stage',{done:T.stage,next:T.stage+1,name:this.mode==='coop'?'Level '+(T.stage+1):MODES.tourney.stages[T.stage].name,ms:CFG.transitionMs});
      this.emitBoard(now,true);
    }
  }
  leaveBehind(a,S){ // Multiplayer co-op: anyone not seated when the vehicle leaves is out for the rest of the run and only spectates from the next level
    if(this.mode!=='coop'||this.solo)return;
    this.pl().filter(p=>p.tid===S.tid&&p.aid===a.id&&p.status!=='escaped'&&p.status!=='spectator').forEach(p=>{
      p.spec=true;p.status='failed';p.ix=p.iy=0;p.vx=p.vy=0;p.act=null;p.escAt=0});
  }
  checkElim(a,now){
    for(const id of a.tids){const T=this.teams[id];
      if(T.status==='active'&&T.pids.every(x=>{const p=this.players.get(x);return!p||p.status==='failed'}))this.eliminate(T,now)}
  }
  eliminate(T,now){
    T.status='eliminated';T.elimAt=now;this.emit('ev',{t:'e',tid:T.id});this.emitBoard(now,true);this.checkTourneyEnd(now);
  }
  checkTourneyEnd(now){
    if(this.mode!=='tourney'||this.state!=='PLAYING')return;
    if(!this.teams.some(t=>t.status==='active'||t.status==='transition'))this.finishTourney(now);
  }
  arenaEnd(a,now){
    if(this.mode==='tourney'){ // island fully sunk
      a.over=true;for(const id of a.tids){const T=this.teams[id];if(T.status==='active')this.eliminate(T,now);if(this.state!=='PLAYING')return}
      this.checkTourneyEnd(now);return;
    }
    if(this.mode==='coop'){const S=a.stations[0];if(S&&!S.launched&&this.pl().some(p=>p.aid===a.id&&p.status==='boarded')){this.launch(a,S,now);return}} // seated when time runs out => still escapes
    this.finish(a,now);
  }
  finish(a,now){
    const ps=this.pl();
    ps.forEach(p=>{if(p.status==='boarded')p.status=this.mode==='coop'?'escaped':'failed';else if(p.status==='alive')p.status='failed'});
    if(this.mode==='last'){this.endRound(a,now);return}
    let msg;
    if(this.mode==='coop'){ // run over: report the level reached (Solo uses this for its best-level score)
      const lv=this.teams[0]?this.teams[0].stage:1;
      const fp=this.pl().find(x=>x.status==='failed');msg={mode:'coop',reason:'SUNK',winner:null,level:lv,solo:this.solo,canRevive:!!this.solo&&!this.reviveUsed,cause:fp&&fp.cause||'water',reach:Object.fromEntries(this.pl().map(x=>[x.id,x.reach||1])),rows:ps.map(x=>({id:x.id,name:x.name,color:x.color,txt:'LEVEL '+(x.reach||lv),win:false}))};
    }else{
      const W=this.winner,rows=this.teams.slice().sort((x,y)=>(y.id===W)-(x.id===W)).map(T=>({id:T.id,name:T.name,color:T.color,txt:T.id===W?'ESCAPED FIRST':'LOST',win:T.id===W}));
      msg={mode:'last',reason:W!=null?'ESCAPED':'SUNK',winner:W,rows:W!=null?rows:[]};
    }
    this.over(msg);
  }
  endRound(a,now){ // Last Escape is best-of-3: most round wins takes the match (ties play extra rounds)
    const W=this.winner,LE=LAST_ESCAPE;a.over=true;if(W!=null)this.lastWins[W]=(this.lastWins[W]||0)+1;
    const w=t=>this.lastWins[t.id]||0,best=Math.max(0,...this.teams.map(w)),lead=this.teams.filter(t=>best>0&&w(t)===best);
    const done=(lead.length===1&&(best>LE.rounds/2||this.lastRound>=LE.rounds))||this.lastRound>=LE.maxRounds;
    if(!done){this.emit('rres',{n:this.lastRound,total:LE.rounds,winner:W,wins:this.lastWins,ms:ROUND_BREAK_MS});this.lastRound++;this.roundBreak=now+ROUND_BREAK_MS;return}
    const G=lead.length===1?lead[0].id:(lead.some(t=>t.id===W)?W:lead.length?lead[0].id:null);this.winner=G;
    const rows=this.teams.slice().sort((x,y)=>(y.id===G)-(x.id===G)||w(y)-w(x)).map(T=>({id:T.id,name:T.name,color:T.color,txt:(T.id===G?'MATCH WINNER · ':'')+w(T)+(w(T)===1?' ROUND':' ROUNDS'),win:T.id===G}));
    this.over({mode:'last',reason:G!=null?'ESCAPED':'SUNK',winner:G,rows:G!=null?rows:[]});
  }
  nextLastRound(now){this.winner=null;this.seed=(Math.random()*2147483647)|0;this.arenas=new Map();this.aidN=0;this.boardJ='';
    this.teams.forEach(t=>{t.status='active';t.stage=1;t.escAt=0;t.elimAt=0});
    const a=this.makeArena(this.teams.map(t=>t.id),now);this.teams.forEach(t=>t.aid=a.id);this.emitBoard(now,true)}
  finishTourney(now){
    const W=this.winner,eff=T=>T.stage+(T.status==='transition'?1:0);
    const rank=this.teams.slice().sort((a,b)=>(b.id===W)-(a.id===W)||eff(b)-eff(a)||this.progOf(b)-this.progOf(a)||(b.elimAt||1e15)-(a.elimAt||1e15));
    this.over({mode:'tourney',reason:W!=null?'ESCAPED':'SUNK',winner:W,
      rows:rank.map(T=>({id:T.id,name:T.name,color:T.color,txt:T.id===W?'WINNER':T.status==='eliminated'?'ELIMINATED · ISLAND '+T.stage:'ISLAND '+eff(T),win:T.id===W}))});
  }
  over(msg){
    this.state='GAME_OVER';this.overMsg=msg;
    this.arenas.forEach(a=>{a.state='GAME_OVER';a.over=true;this.ea(a,'world',a.world())});
    this.emit('over',msg);this.lobby();this.emitBoard(Date.now(),true);
  }
  // ---- dev-only controls (server only accepts them when not in production or ALLOW_DEBUG=1)
  dbg(id,d,now){
    const p=this.players.get(id);if(!p||!d||this.state!=='PLAYING')return;
    const a=this.arenas.get(p.aid);if(!a)return;const S=a.stations.find(s=>s.tid===p.tid),n=a.cfg.need;
    switch(d.a){
      case'water':a.startAt=now-(+d.v||0)*1000;break;
      case'res':p.inv={w:n.w,l:n.l,c:n.c};p.invD=true;break;
      case'done':if(S&&!S.done){Object.assign(S,{w:n.w,l:n.l,c:n.c,done:true});a.dirty=true;this.ea(a,'ev',{t:'r',s:S.id})}break;
      case'tp':p.x=S?S.x:0;p.y=S?S.y:0;break;
      case'push':p.pushCd=0;p.buildT=0;p.act=null;a.push(p,now);break;
      case'skip':case'win':if(S&&!S.launched){Object.assign(S,{w:n.w,l:n.l,c:n.c,done:true});
        if(a.cfg.mode==='coop'&&!this.solo){p.x=S.x;p.y=S.y;p.noBoard=0;a.board(p,now);p.escAt=now}else S.launchAt=now;a.dirty=true}break;
      case'restart':this.start(now);break;
    }
  }
}
module.exports={Room,CFG,MODES,genLayout,arenaCfg};
