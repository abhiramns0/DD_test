'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const Sea=require('./sea'); // open-sea rules (pure) + multiplayer helpers
const SEA_PROTO=4; // bump when the sea wire format changes: the client reloads itself if it is older/newer than the server
const seaSessions=new Map(); // uid -> {session, sockId, name, emoji, emojiUntil, emojiMeta, proto, dropAt, saveTimer, saving, again}
const seaVitals=new Map();   // uid -> {hp,at}  boat health at the moment the player left the sea; it keeps regenerating while away (computed lazily)
const seaCooldown=new Map(); // uid -> timestamp: 'Leave Sea' / being sunk blocks sailing out again until then. Docking at home never sets it.
const seaHpNow=(uid,now)=>{const max=Sea.CFG.playerHp,v=seaVitals.get(uid);if(!v)return max;return Math.min(max,v.hp+(now-v.at)/1000*max/Sea.CFG.regenSeconds)};
const seaStoreHp=(uid,hp,now)=>seaVitals.set(uid,{hp:Math.max(0,Math.min(Sea.CFG.playerHp,hp)),at:now});
const seaCooldownLeft=(uid,now)=>Math.max(0,(seaCooldown.get(uid)||0)-now);
function seaVitalsPack(uid,now){
  const slot=seaSessions.get(uid),live=slot&&slot.session&&slot.session.status==='sailing'?slot.session.player.hp:null;
  return{hp:Math.round((live==null?seaHpNow(uid,now):live)*10)/10,maxHp:Sea.CFG.playerHp,regenPerSec:Sea.CFG.playerHp/Sea.CFG.regenSeconds}}
function seaVoyagerList(){
  const list=[];
  for(const [uid,slot] of seaSessions){
    if(!slot||!slot.session||slot.session.status!=='sailing')continue;
    list.push({uid,name:slot.name,player:slot.session.player,emoji:slot.emoji,emojiUntil:slot.emojiUntil,clanId:null});
  }
  return list}
// Look up a player's voyage and re-attach it to the CURRENT socket. After a network blip the client gets a new
// socket id; the old strict id check made every later tick/intent fail silently (frozen screen, ghost boat).
function seaSlotFor(uid,s){
  const slot=seaSessions.get(uid);if(!slot)return null;
  if(slot.sockId!==s.id){slot.sockId=s.id;slot.dropAt=0}
  return slot}
// full=true -> includes the static world (islets, cfg). Sockets that did not announce proto>=2 always get full snapshots.
function seaPackFor(uid,slot,now,voyagers,full){
  const sess=slot.session,t=now||Date.now();
  const others=Sea.othersView(uid,sess.player.x,sess.player.y,voyagers||seaVoyagerList(),t);
  return Sea.viewWithOthers(sess,others,t,{full:!!full||(slot.proto|0)<2,proto:SEA_PROTO})}
function seaEmitTo(uid,event,payload){
  const slot=seaSessions.get(uid);if(!slot||!slot.sockId)return;
  try{const sock=io.sockets.sockets.get(slot.sockId);if(sock)sock.emit(event,payload)}catch(e){}}
function seaBroadcastNearby(fromUid,event,payload,x,y){
  for(const [uid,slot] of seaSessions){
    if(!slot||!slot.session||slot.session.status!=='sailing')continue;
    if(fromUid&&uid===fromUid)continue;
    const p=slot.session.player;if(!p)continue;
    if(Math.hypot(p.x-x,p.y-y)>Sea.CFG.aoiR)continue;
    seaEmitTo(uid,event,payload);
  }}
// Gems / discoveries are saved shortly after every pickup (not only when the voyage ends), so a closed tab, a dropped
// connection or a server redeploy can no longer lose them. One save at a time per player; later changes are coalesced.
function seaQueueSave(uid,slot){
  if(!slot||slot.saveTimer)return;
  slot.saveTimer=setTimeout(()=>{slot.saveTimer=0;seaSaveNow(uid,slot)},1200)}
async function seaSaveNow(uid,slot){
  if(slot.saving){slot.again=true;return}
  slot.saving=true;
  try{await island.saveSea(uid,Sea.packDiscoveries(slot.session))}catch(e){console.error('[sea] save',e.message)}
  slot.saving=false;
  if(slot.again){slot.again=false;seaQueueSave(uid,slot)}}
// Ends a voyage on the server (dock, leave, sunk, or connection never came back). The boat's health is remembered so it keeps
// regenerating; leaving / being sunk starts the sail-out cooldown.
function seaEnd(uid,slot,now,o){
  o=o||{};
  // cargo rules: dock = banked; Leave Sea / lost connection = half is lost to the sea; sunk = everything floats
  const p=slot.session.player,r=Sea.returnHome(slot.session,{mode:o.sunk?'sunk':(o.leave||o.timeout)?'leave':'dock'});
  if(r.ok&&r.dropped&&p){
    // a visible wreck / floating cargo that every nearby sailor can loot (10 s after a sinking, longer after Leave Sea)
    try{
      if(o.sunk)Sea.addPlayerWreck(uid,p.x,p.y,r.dropped);
      else if(r.dropped.gems||r.dropped.gold)Sea.addPlayerWreck(uid,p.x,p.y,r.dropped,Sea.CFG.dropTtlMs);
    }catch(e){}
  }
  // leave any sea team + abandon in-progress race
  try{
    const tl=Sea.teamLeave(uid);
    if(tl&&tl.ok&&!tl.dissolved){
      for(const m of tl.members||[])seaEmitTo(m,'sea:team',{op:'left',uid,leader:tl.leader,members:tl.members});
    }
  }catch(e){}
  try{Sea.raceAbandon(uid)}catch(e){}
  seaStoreHp(uid,o.sunk?0:p.hp,now);
  if(o.cooldown||o.sunk)seaCooldown.set(uid,now+Sea.CFG.seaCooldownMs);
  if(slot.saveTimer){clearTimeout(slot.saveTimer);slot.saveTimer=0}
  seaSessions.delete(uid);
  seaBroadcastNearby(null,'sea:presence',{op:'leave',uid},p.x,p.y);
  return r}
async function seaSink(uid,slot,byName,now){
  const sock=slot.sockId?io.sockets.sockets.get(slot.sockId):null;
  const r=seaEnd(uid,slot,now,{sunk:true});
  let saved=null;try{if(r.ok)saved=await island.saveSea(uid,r.discoveries)}catch(e){}
  if(sock)sock.emit('sea:sunk',{by:byName,cooldownMs:seaCooldownLeft(uid,Date.now()),vitals:seaVitalsPack(uid,Date.now()),island:saved&&saved.ok?saved.island:undefined})}
async function seaFlushAll(){ // redeploy / shutdown: write every sailor's gems before the process exits
  const jobs=[];
  for(const [uid,slot] of seaSessions)if(slot&&slot.session&&slot.session.status==='sailing')jobs.push(Promise.resolve(island.saveSea(uid,Sea.packDiscoveries(slot.session))).catch(()=>{}));
  await Promise.race([Promise.all(jobs),new Promise(r=>setTimeout(r,3000))])}

const {Server}=require('socket.io');
const {Room,CFG,MODES}=require('./game');
const PROD=process.env.NODE_ENV==='production',SOLO=process.env.ALLOW_SOLO==='1'||!PROD,DBG=process.env.ALLOW_DEBUG==='1'||!PROD;
const rooms=new Map();

// ---------- static files (public/) : game, PWA manifest, service worker, icons, ads.txt ----------
const PUB=path.join(__dirname,'public');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
const NOCACHE=new Set(['/index.html','/sw.js','/manifest.webmanifest']);
// Finds a static file even if the repo stores it with different letter case (Linux/Render is case-sensitive) or keeps /icons at the project root instead of public/.
function ci(base,rel){let cur=base;for(const seg of rel.split('/').filter(Boolean)){let nxt=path.join(cur,seg);if(!fs.existsSync(nxt)){let l;try{l=fs.readdirSync(cur)}catch(e){return null}const m=l.find(n=>n.toLowerCase()===seg.toLowerCase());if(!m)return null;nxt=path.join(cur,m)}cur=nxt}
  try{return fs.statSync(cur).isFile()?cur:null}catch(e){return null}}
function findStatic(rel){let f=ci(PUB,rel);if(!f&&rel.startsWith('/icons/'))f=ci(__dirname,rel);return f}
const srv=http.createServer((q,s)=>{
  const u=decodeURIComponent((q.url||'/').split('?')[0]);
  if(u==='/health'){s.end('ok');return}
  if(u==='/health/icons'){ // quick check that the PWA / share-preview images are really deployed: open /health/icons in a browser
    const want=['/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-512.png','/icons/apple-touch-icon.png','/icons/favicon-32.png','/icons/og-image.jpg','/icons/title.png'],o={};
    want.forEach(w=>{const f=findStatic(w);o[w]=f?{found:true,bytes:fs.statSync(f).size}:{found:false}});
    s.setHeader('Content-Type','application/json');s.end(JSON.stringify(o,null,1));return}
  if(u==='/health/auth'){s.setHeader('Content-Type','application/json');s.end(JSON.stringify(Object.assign(auth.status(),{clientUrl:!!auth.publicUrl,clientKey:!!auth.publicKey})));return} // which sign-in settings are present (no secrets)
  if(u==='/health/island'){s.setHeader('Content-Type','application/json');s.end(JSON.stringify(island.status()));return} // {store:'postgres'|'memory',persistent,ok} - no secrets
  if(u==='/health/db'){s.setHeader('Content-Type','application/json');s.end(JSON.stringify(board.status()));return} // {db:'ok'|'down'|'not_configured',queued:n} - no secrets
  if(u==='/admin/clear-leaderboard'){
    const qs=new URLSearchParams((q.url.split('?')[1])||''),key=process.env.ADMIN_KEY||'';
    const same=key&&qs.get('key')&&qs.get('key').length===key.length&&crypto.timingSafeEqual(Buffer.from(qs.get('key')),Buffer.from(key));
    if(!same||qs.get('confirm')!=='yes'){s.statusCode=403;s.end('forbidden (needs ADMIN_KEY and confirm=yes)');return}
    adminClear().then(ok=>{s.statusCode=ok?200:500;s.end(ok?'leaderboard cleared':'could not clear the leaderboard (see server logs)')});return}
  const rel=u==='/'?'/index.html':u,full=path.normalize(path.join(PUB,rel));
  if(!full.startsWith(PUB+path.sep)){s.statusCode=403;s.end('forbidden');return}
  if(rel.includes('..')){s.statusCode=403;s.end('forbidden');return}
  const send=(file,rp)=>fs.readFile(file,(e,b)=>{
    if(e){s.statusCode=404;s.end('not found');return}
    if(rp==='/index.html'){const proto=String(q.headers['x-forwarded-proto']||'http').split(',')[0],origin=(process.env.PUBLIC_URL||'').replace(/\/+$/,'')||(proto+'://'+q.headers.host);b=Buffer.from(b.toString('utf8').split('%%ORIGIN%%').join(origin).split('%%SB_URL%%').join(auth.clientOk?auth.publicUrl:'').split('%%SB_KEY%%').join(auth.clientOk?auth.publicKey:''))} // SB_URL / SB_KEY are PUBLIC values (project URL + anon/publishable key) for the browser sign-in // absolute URLs for share previews (og:image)
    s.setHeader('Content-Type',MIME[path.extname(file)]||'application/octet-stream');
    s.setHeader('Cache-Control',(NOCACHE.has(rp)||rp.endsWith('.js'))?'no-cache':rp.startsWith('/icons/')?'public, max-age=3600':'public, max-age=86400');
    if(rp==='/sw.js')s.setHeader('Service-Worker-Allowed','/');
    s.end(b)});
  const hit=findStatic(rel);
  if(hit)send(hit,rel);else if(!path.extname(rel))send(path.join(PUB,'index.html'),'/index.html');else{s.statusCode=404;s.end('not found')}
});
// pingInterval/pingTimeout: a dead phone connection is noticed in ~20 s instead of ~45 s, and the idle keep-alive stops proxies dropping it.
const io=new Server(srv,{cors:{origin:process.env.CLIENT_ORIGIN||'*'},pingInterval:10000,pingTimeout:10000});

// ---------- leaderboard: PostgreSQL (Supabase) via leaderboard.js. Credentials: DATABASE_URL (server environment only) ----------
const board=require('./leaderboard').create(console);
const island=require('./island-store').create({pool:board.getPool(),log:console}); // persistent private islands (island.js = rules, island-store.js = storage)
const raceStore=require('./race-store').create({pool:board.getPool(),log:console}); // race leaderboards survive restarts (PostgreSQL, or a JSON file without a database)
Sea.setBoardSaver(r=>raceStore.save(r));
const auth=require('./auth').create(console); // Supabase sign-in (Google / Apple / email). Optional: without it everyone is a guest.
// Developer-only reset: set ADMIN_KEY in the environment, then open  /admin/clear-leaderboard?key=<ADMIN_KEY>&confirm=yes
const adminClear=()=>board.clear();

const CH='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode=()=>{let c;do{c=Array.from({length:4},()=>CH[Math.random()*CH.length|0]).join('')}while(rooms.has(c));return c};
const hex=n=>crypto.randomBytes(n).toString('hex');
const IRules=require('./island'); // pure XP formulas (no storage)
const mkRoom=(opts)=>{const code=newCode(),socks=new Map();
  const rm=new Room(code,(e,d,to)=>{if(to){for(const id of to){const k=socks.get(id);if(k)k.emit(e,d)}}else io.to(code).emit(e,d)});
  rm.socks=socks;rm.solo=!!opts.solo;rm.public=!!opts.public&&!opts.solo;rm.onScore=board.record;
  // Island XP is server-authoritative: amount + dedupe key are computed here, never trusted from the client.
  rm.onIslandXp=({uid,stage,solo,mode,elapsedMs})=>{
    const amount=IRules.stageXp(stage,solo,elapsedMs);
    const key='stage:'+mode+':'+(solo?'s':'m')+':'+Math.max(1,stage|0);
    island.grantXp(uid,amount,key).then(r=>{
      if(!r||!r.ok||!r.gained)return;
      // Push to every socket in this room whose player id matches the rewarded uid.
      for(const [pid,sock] of socks){
        const pl=rm.players.get(pid);
        if(pl&&pl.uid===uid){try{sock.emit('island:xp',{gained:r.gained,unlocked:r.unlocked||[],levelUp:!!r.levelUp,progress:r.island&&r.island.progress,island:r.island})}catch(e){}}
      }
    }).catch(()=>{})};
  if(MODES[opts.mode])rm.mode=opts.mode;if(opts.teamMode==='teams')rm.teamMode='teams';rooms.set(code,rm);return rm};
io.on('connection',s=>{
  let room=null,identUid=null,identAuthed=false,myAcct=null,myProf=null,lastIdentAt=0,pid='player_'+hex(2),tok=hex(8),bucket={inp:[0,0],mv:[0,0],push:[0,0],shoot:[0,0],shield:[0,0],lb:[0,0],prog:[0,0],acct:[0,0],ident:[0,0],isl:[0,0],sea:[0,0],seaAct:[0,0],emo:[0,0],sint:[0,0],seaUi:[0,0]};
  const lim=(k,max,perSec)=>{const b=bucket[k],t=Date.now();b[0]=Math.min(max,b[0]+(t-b[1])/1000*perSec);b[1]=t;if(b[0]<1)return false;b[0]--;return true};
  const applyOwned=()=>{if(room&&myProf){const p=room.players.get(pid);if(p&&!p.bot)p.ownedSkins=myProf.skins}}; // purchased premium skins come from the database, never from the client
  const join=rm=>{room=rm;s.join(rm.code);rm.socks.set(pid,s);rm.addPlayer(pid,tok);applyOwned()};
  const ack=(rm)=>({ok:true,code:rm.code,id:pid,tok,solo:SOLO,dbg:DBG,pub:rm.public});
  // enter a room: lobby = normal join (a bot makes space if needed); running public match = take over a bot's character
  const enter=(rm,cb)=>{
    if(rm.state==='LOBBY'){rm.makeRoom();join(rm)}
    else{if(!rm.takeOver(pid,tok))return cb&&cb({ok:false,err:'Game already in progress'});room=rm;s.join(rm.code);rm.socks.set(pid,s);applyOwned()}
    cb&&cb(ack(rm));if(rm.state!=='LOBBY')rm.snapshot(pid)};
  s.on('pg',(t,cb)=>typeof cb==='function'&&cb(Date.now()));
  s.on('create',(d,cb)=>{if(room)return;const rm=mkRoom({solo:d&&d.solo,public:d&&d.public,mode:d&&d.mode,teamMode:d&&d.teamMode});join(rm);cb&&cb(ack(rm))});
  // QUICK PLAY: straight into a public room. Prefer lobbies that already have players waiting, then running matches that have a bot to replace;
  // if none exists, open a new public room (random mode) that auto-starts with bots after its countdown.
  s.on('quick',(d,cb)=>{if(room)return;const want=MODES[d&&d.mode]?d.mode:null;
    const cand=[...rooms.values()].filter(r=>r.public&&!r.solo&&(!want||r.mode===want)&&r.humans()<CFG.maxPlayers&&(r.state==='LOBBY'||(r.state==='PLAYING'&&r.hasBot())))
      .sort((a,b)=>(b.state==='LOBBY')-(a.state==='LOBBY')||b.humans()-a.humans());
    const modes=Object.keys(MODES),rm=cand[0]||mkRoom({public:true,mode:want||modes[(Math.random()*modes.length)|0],teamMode:Math.random()<.5?'teams':'ffa'});enter(rm,cb)});
  s.on('join',(d,cb)=>{if(room)return;const rm=rooms.get(String(d&&d.code||'').toUpperCase().trim());
    if(!rm||rm.solo)return cb&&cb({ok:false,err:'Room not found'});
    if(rm.state!=='LOBBY'&&!(rm.public&&rm.hasBot()))return cb&&cb({ok:false,err:'Game already in progress'});
    if(rm.humans()>=CFG.maxPlayers)return cb&&cb({ok:false,err:'Room is full'});
    enter(rm,cb)});
  // reconnect (phone slept / network blip): rebind this socket to the existing player slot
  s.on('resume',(d,cb)=>{if(room||!d)return cb&&cb({ok:false});const rm=rooms.get(String(d.code||'').toUpperCase());const p=rm&&rm.resume(d.id,d.tok);
    if(!p)return cb&&cb({ok:false});
    room=rm;pid=d.id;tok=d.tok;s.join(rm.code);rm.socks.set(pid,s);applyOwned();if(identUid)rm.ident(pid,{uid:identUid});cb&&cb(ack(rm));rm.snapshot(pid);rm.lobby()});
  s.on('inp',d=>room&&lim('inp',60,60)&&room.setInput(pid,d));
  s.on('mv',d=>room&&lim('mv',90,70)&&room.setPos(pid,d,Date.now())); // client-reported position, validated by Room.setPos (speed budget + island edge)
  s.on('push',()=>room&&lim('push',4,6)&&room.push(pid,Date.now()));
  s.on('shoot',d=>room&&lim('shoot',4,4)&&room.shoot(pid,d,Date.now()));
  s.on('shield',()=>room&&lim('shield',2,2)&&room.shield(pid,Date.now()));
  s.on('revive',()=>room&&room.reviveSolo(pid,Date.now())); // solo second chance (see Room.reviveSolo)
  // {uid,name,token?,done?}: links this connection to ONE leaderboard identity. token = Supabase access token of a signed-in player (the server checks it
  // with Supabase and derives the id itself - a client can never claim someone else's account). A guest connection may upgrade to an account once; nothing else can switch.
  s.on('ident',async(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!d||!lim('ident',6,.5))return reply({ok:false,err:'busy'});
    let uid=null,acct=null;
    if(d.token){
      try{acct=await auth.verify(d.token)}catch(e){console.error('[auth] verify failed:',e.message);return reply({ok:false,err:'auth_unavailable'})}
      if(!acct)return reply({ok:false,err:'bad_token'});uid=acct.uid}
    else if(board.validUid(d.uid))uid=d.uid;
    if(!uid)return reply({ok:false,err:'bad_id'});
    if(identUid&&identUid!==uid&&!(acct&&!identAuthed))return reply({ok:false,err:'switch'});
    identUid=uid;identAuthed=!!acct;myAcct=acct;
    {const sl=seaSessions.get(uid);if(sl&&!sl.sockId){sl.sockId=s.id;sl.dropAt=0}} // voyage waiting for a reconnect: pick it up on this socket
    if(room)room.ident(pid,{uid,name:d.name});
    const n=Date.now();if(n-lastIdentAt>2000){lastIdentAt=n;board.rename(uid,d.name)}
    if(d.done)await board.progress(uid,d.done); // catch-up for unlocks earned while offline
    myProf=await board.profile(uid);applyOwned();
    reply({ok:true,auth:identAuthed,name:myProf.name,profile:{done:myProf.done,skins:myProf.skins,scenery:myProf.scenery}})});
  s.on('prog',d=>{if(identUid&&lim('prog',3,.5))board.progress(identUid,d&&d.done)}); // unlock progress (highest solo level completed)
  // guest -> account: move the guest's scores, unlock progress and purchases into the signed-in account
  s.on('link',async(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identAuthed||!d||!board.validUid(d.guest)||d.guest===identUid||!lim('acct',3,.2))return reply({ok:false,err:'bad_request'});
    const r=await board.merge(d.guest,identUid);if(r.ok&&r.profile){myProf=r.profile;applyOwned()}reply(r)});
  // delete account: signed-in -> removes the login AND all stored data; guest -> removes the data stored for this guest id
  s.on('delacc',async(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid||!lim('acct',3,.2))return reply({ok:false,err:'bad_request'});
    try{
      if(identAuthed){
        const a=await auth.verify(String(d&&d.token||''),true); // fresh check: the person must still hold a valid session
        if(!a||a.uid!==identUid)return reply({ok:false,err:'bad_token'});
        if(!auth.canDelete)return reply({ok:false,err:'not_configured'});
        await auth.deleteUser(a.id)}
      await board.remove(identUid);await island.remove(identUid);
      if(room){const rm=room;room=null;rm.socks.delete(pid);s.leave(rm.code);rm.removePlayer(pid);if(!rm.humans())rooms.delete(rm.code)}
      identUid=null;identAuthed=false;myAcct=null;myProf=null;reply({ok:true})
    }catch(e){console.error('[auth] delete account failed:',e.message);reply({ok:false,err:'failed'})}});
  // PRIVATE ISLAND. The owner is ALWAYS identUid (the id this connection proved in 'ident': a verified Supabase account, or the guest's own id).
  // Nothing the client sends can name another owner - the payload has no id field at all.
  s.on('island:load',async(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid)return reply({ok:false,err:'not_ready'});
    if(!lim('isl',10,1))return reply({ok:false,err:'busy'});
    const r=await island.load(identUid),now=Date.now();
    reply(Object.assign({},r,{seaCooldownMs:seaCooldownLeft(identUid,now),vitals:seaVitalsPack(identUid,now)}))});
  s.on('island:act',async(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid)return reply({ok:false,err:'not_ready'});
    if(!d||typeof d!=='object'||!lim('isl',10,1))return reply({ok:false,err:'busy'});
    reply(await island.act(identUid,d.action,d.rev))});

  s.on('sea:enter',async(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid)return reply({ok:false,err:'not_ready'});
    if(!lim('sea',6,.5))return reply({ok:false,err:'busy'});
    const now0=Date.now(),wait=seaCooldownLeft(identUid,now0);
    if(wait>0)return reply({ok:false,err:'cooldown',waitMs:wait,vitals:seaVitalsPack(identUid,now0)});
    try{
      // an unfinished voyage of this player (page refresh, second tab) is closed and saved properly first
      const old=seaSessions.get(identUid);
      if(old&&old.session&&old.session.status==='sailing'){
        const r0=seaEnd(identUid,old,now0);
        try{if(r0.ok)await island.saveSea(identUid,r0.discoveries)}catch(e){}}
      let disc={islets:[],treasures:[],voyages:0,treasureCount:0};
      try{const g=await island.getSea(identUid);if(g&&g.ok&&g.sea)disc=g.sea}catch(e){console.error('[sea] load discoveries',e.message)}
      const now=Date.now();
      const voyage=(disc.voyages|0)+1;
      let level=1;try{const il=await island.load(identUid);if(il&&il.ok&&il.island&&il.island.progress)level=il.island.progress.level|0||1}catch(e){} // bigger cargo hold with experience level
      const session=Sea.createSession(identUid,voyage,disc,{hp:seaHpNow(identUid,now),level}); // boat health continues from where it was left
      session.staleIntent=(d&&d.proto|0)>=2;
      const spread=((parseInt(String(identUid).slice(-4),16)||0)%360)*Math.PI/180;
      session.player.x=Math.cos(spread)*Sea.CFG.leaveR;
      session.player.y=Math.sin(spread)*Sea.CFG.leaveR;
      session.player.facing=spread;
      const name=(myProf&&myProf.name)||(d&&typeof d.name==='string'?d.name:'')||'Sailor';
      const slot={session,sockId:s.id,name:String(name).slice(0,14),proto:(d&&d.proto|0)||1,dropAt:0,saveTimer:0,saving:false,again:false,
        emoji:null,emojiUntil:0,emojiMeta:{lastAt:0,countWindowStart:0,countInWindow:0}};
      seaSessions.set(identUid,slot);
      reply({ok:true,sea:seaPackFor(identUid,slot,now,null,true),vitals:seaVitalsPack(identUid,now)});
      seaBroadcastNearby(identUid,'sea:presence',{op:'join',uid:identUid,name:slot.name},session.player.x,session.player.y);
    }catch(e){console.error('[sea] enter',e.message);reply({ok:false,err:'unavailable'})}});
  s.on('sea:intent',(d)=>{
    if(!identUid||!lim('sint',60,40))return;const slot=seaSlotFor(identUid,s);if(!slot)return;
    const mx=d&&typeof d.mx==='number'&&isFinite(d.mx)?Math.max(-1,Math.min(1,d.mx)):0;
    const my=d&&typeof d.my==='number'&&isFinite(d.my)?Math.max(-1,Math.min(1,d.my)):0;
    Sea.setIntent(slot.session,mx,my,Date.now())});
  s.on('sea:tick',(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid)return reply({ok:false,err:'not_ready'});
    const slot=seaSlotFor(identUid,s);if(!slot)return reply({ok:false,err:'no_session'});
    const now=Date.now(); // snapshot only (always the full one: this is the client's resync path); the server loop owns the clock
    reply({ok:true,sea:seaPackFor(identUid,slot,now,null,true)})});
  s.on('sea:act',async(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid)return reply({ok:false,err:'not_ready'});
    if(!d||typeof d!=='object'||!lim('seaAct',10,4))return reply({ok:false,err:'busy'});
    const slot=seaSlotFor(identUid,s);if(!slot)return reply({ok:false,err:'no_session'});
    const now=Date.now();let r,sunkSlot=null,sunkUid=null;
    if(d.op==='attack'){
      if(d.targetUid&&typeof d.targetUid==='string'&&d.targetUid!==identUid){
        const tSlot=seaSessions.get(d.targetUid);
        if(!tSlot||!tSlot.session||tSlot.session.status!=='sailing')r={ok:false,err:'no_target'};
        else{
          r=Sea.pvpAttack(slot.session,tSlot.session.player,now,identUid,d.targetUid);
          if(r.ok&&r.sunk){sunkSlot=tSlot;sunkUid=d.targetUid}
          else if(r.ok&&r.hit)seaEmitTo(d.targetUid,'sea:event',{t:'pvp_hit',by:slot.name,hp:tSlot.session.player.hp,sea:seaPackFor(d.targetUid,tSlot,now)});
        }
      }else r=Sea.attack(slot.session,now);
    }
    else if(d.op==='loot')r=Sea.loot(slot.session,now);
    else if(d.op==='collect')r=Sea.collectTreasure(slot.session,now);
    else if(d.op==='chest')r=Sea.openChest(slot.session,String(d.id||''),now);
    else return reply({ok:false,err:'bad_action'});
    if(slot.session.dirty){slot.session.dirty=false;seaQueueSave(identUid,slot)}
    reply(Object.assign({ok:!!r.ok},r,{sea:seaPackFor(identUid,slot,now)}));
    if(sunkSlot)seaSink(sunkUid,sunkSlot,slot.name,now).catch(e=>console.error('[sea] sink',e.message))}); // the sunk boat leaves the sea and gets the cooldown
  s.on('sea:emoji',(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid)return reply({ok:false,err:'not_ready'});
    if(!lim('emo',6,2))return reply({ok:false,err:'busy'});
    const slot=seaSlotFor(identUid,s);if(!slot)return reply({ok:false,err:'no_session'});
    const id=d&&typeof d.id==='string'?d.id:'';
    const now=Date.now();
    const v=Sea.validateEmoji(id,now,slot.emojiMeta);
    if(!v.ok)return reply(v);
    slot.emojiMeta=v.meta;slot.emoji=id;slot.emojiUntil=now+v.ttl;
    const p=slot.session.player;
    const payload={uid:identUid,name:slot.name,id,x:p.x,y:p.y,until:slot.emojiUntil};
    for(const [uid,s2] of seaSessions){
      if(!s2||!s2.session||s2.session.status!=='sailing')continue;
      const op=s2.session.player;if(!op)continue;
      if(Math.hypot(op.x-p.x,op.y-p.y)>Sea.CFG.aoiR)continue;
      seaEmitTo(uid,'sea:emoji',payload);
    }
    reply({ok:true,id,ttl:v.ttl,until:slot.emojiUntil})});
  // ---- teaming ----
  s.on('sea:team',(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid)return reply({ok:false,err:'not_ready'});
    if(!d||typeof d!=='object'||!lim('seaUi',12,6))return reply({ok:false,err:'busy'}); // own bucket: spamming attack must never starve the team / race buttons
    const slot=seaSlotFor(identUid,s);if(!slot)return reply({ok:false,err:'no_session'});
    const now=Date.now(),p=slot.session.player;
    if(d.op==='invite'){
      const toUid=d.toUid;if(!toUid||toUid===identUid)return reply({ok:false,err:'bad'});
      const tSlot=seaSessions.get(toUid);if(!tSlot||!tSlot.session||tSlot.session.status!=='sailing')return reply({ok:false,err:'no_target'});
      const r=Sea.teamInvite(identUid,toUid,slot.name,tSlot.name,p,tSlot.session.player);
      if(r.ok)seaEmitTo(toUid,'sea:team',{op:'invite',teamId:r.teamId,from:identUid,name:slot.name});
      return reply(r);
    }
    if(d.op==='accept'){
      const r=Sea.teamAccept(identUid,d.teamId,slot.name);
      if(r.ok){
        for(const m of r.members)seaEmitTo(m,'sea:team',{op:'joined',teamId:r.teamId,leader:r.leader,members:r.members,name:slot.name});
      }
      return reply(Object.assign({ok:!!r.ok},r,{sea:seaPackFor(identUid,slot,now)}));
    }
    if(d.op==='leave'){
      const r=Sea.teamLeave(identUid);
      if(r.ok&&!r.dissolved){
        for(const m of r.members)seaEmitTo(m,'sea:team',{op:'left',uid:identUid,leader:r.leader,members:r.members});
      }
      return reply(Object.assign({ok:!!r.ok},r,{sea:seaPackFor(identUid,slot,now)}));
    }
    if(d.op==='decline'){
      const r=Sea.teamDecline(identUid,d.teamId);
      return reply(Object.assign({ok:!!r.ok},r,{sea:seaPackFor(identUid,slot,now)}));
    }
    reply({ok:false,err:'bad_op'})});
  // ---- racing ----
  s.on('sea:race',(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid)return reply({ok:false,err:'not_ready'});
    if(!d||typeof d!=='object'||!lim('seaUi',8,3))return reply({ok:false,err:'busy'});
    const slot=seaSlotFor(identUid,s);if(!slot)return reply({ok:false,err:'no_session'});
    const now=Date.now();
    if(d.op==='join'){
      const r=Sea.raceJoin(identUid,slot.name,slot.session.player,d.raceId);
      return reply(Object.assign({ok:!!r.ok},r,{sea:seaPackFor(identUid,slot,now)}));
    }
    reply({ok:false,err:'bad_op'})});
  // {leave:true} = 'Leave Sea' (works anywhere, starts the 30 s cooldown). Without it = DOCK: only accepted next to the home island, no cooldown.
  s.on('sea:return',async(d,cb)=>{const reply=typeof cb==='function'?cb:()=>{};
    if(!identUid)return reply({ok:false,err:'not_ready'});
    const now=Date.now(),slot=seaSessions.get(identUid);
    if(!slot||!slot.session||slot.session.status!=='sailing')return reply({ok:false,err:'no_session',cooldownMs:seaCooldownLeft(identUid,now),vitals:seaVitalsPack(identUid,now)});
    const leave=!!(d&&d.leave),p=slot.session.player;
    if(!leave&&Math.hypot(p.x,p.y)>Sea.CFG.returnR+30)return reply({ok:false,err:'far'});
    const r=seaEnd(identUid,slot,now,{cooldown:leave,leave});
    if(!r.ok)return reply(r);
    let saved=null;try{saved=await island.saveSea(identUid,r.discoveries)}catch(e){}
    const t=Date.now();
    reply({ok:true,docked:!leave,dropped:r.dropped||null,nearHome:!!r.nearHome,island:saved&&saved.ok?saved.island:undefined,sea:r.discoveries,cooldownMs:seaCooldownLeft(identUid,t),vitals:seaVitalsPack(identUid,t)})});

  s.on('lb',(d,cb)=>{if(typeof cb!=='function')return; // always answers, so the client never hangs on "Loading"
    if(!lim('lb',6,1))return cb({rows:[],me:null,busy:1});
    board.top(d&&d.kind==='mp'?'mp':'solo',identUid||(d&&board.validUid(d.uid)?d.uid:'')).then(cb).catch(()=>cb({rows:[],me:null,error:'unavailable'}))});
  s.on('name',d=>room&&room.setName(pid,d));
  s.on('skin',d=>room&&room.setSkin(pid,d));
  s.on('mode',d=>room&&room.setMode(pid,d));
  s.on('setteam',d=>room&&room.setTeam(pid,d));
  s.on('start',d=>{if(!room||room.host!==pid||!['LOBBY','GAME_OVER'].includes(room.state))return;
    if(!room.canStart(SOLO&&d&&d.solo).ok)return;room.start(Date.now())});
  s.on('leave',cb=>{if(room){const rm=room;room=null;rm.socks.delete(pid);s.leave(rm.code);rm.removePlayer(pid);if(!rm.humans())rooms.delete(rm.code)}typeof cb==='function'&&cb(true)}); // always answers: after this ack no more room events can reach the client
  s.on('again',()=>{if(room&&room.host===pid&&(room.state==='GAME_OVER'||(room.state==='PLAYING'&&SOLO))&&room.canStart(SOLO).ok)room.start(Date.now())});
  s.on('tolobby',()=>{if(room&&room.host===pid&&room.state==='GAME_OVER')room.toLobby()});
  s.on('dbg',d=>{if(DBG&&room)room.dbg(pid,d,Date.now())});
  s.on('disconnect',()=>{
    if(identUid){const slot=seaSessions.get(identUid); // keep the voyage for a short grace period so a reconnect resumes it
      if(slot&&slot.sockId===s.id){slot.sockId=null;slot.dropAt=Date.now()+30000;try{Sea.setIntent(slot.session,0,0)}catch(e){}}}
    if(!room)return;const rm=room;if(rm.socks.get(pid)!==s)return; // a newer socket already took over this slot
    rm.socks.delete(pid);
    if(rm.state==='LOBBY')rm.removePlayer(pid);else rm.setOffline(pid,Date.now()); // grace period in game
    if(!rm.humans())rooms.delete(rm.code)});
});
// steady game loop: self-correcting timer (setInterval drifts), so every client gets evenly spaced snapshots
{const step=1000/CFG.tick;let next=Date.now();(function loop(){const n=Date.now();rooms.forEach((r,c)=>{r.tick(n);if(!r.humans())rooms.delete(c)});next+=step;if(next<Date.now()-250)next=Date.now();setTimeout(loop,Math.max(1,next-Date.now()))})()}
const PORT=process.env.PORT||3000;

// Open Sea: ONE authoritative simulation clock on the server. State is pushed to every sailor ~15x/s.
// - the list of boats is built once per tick (not once per sailor)
// - 'volatile' emits: if a phone's connection is backed up the stale snapshot is dropped instead of queued, so the picture
//   jumps to the newest state when the network recovers rather than replaying old frames (this was the 'lag' on weak links)
// - snapshots that carry events (pickups, kills) are sent reliably
{let last=Date.now(),lastClean=0;
setInterval(()=>{
  const now=Date.now(),dt=Math.min(0.1,Math.max(0.001,(now-last)/1000));last=now;
  const voy=seaVoyagerList();
  // shared world (NPCs, wildlife, collectables) ticks once; players chase nearest sailor
  const playerPositions=[];
  for(const v of voy)if(v&&v.player&&v.player.alive)playerPositions.push({x:v.player.x,y:v.player.y});
  try{Sea.tickShared(dt,now,playerPositions)}catch(e){console.error('[sea] shared',e.message)}
  // soft boat-vs-boat collisions between living sailors
  {const live=[];
    for(const [uid,slot] of seaSessions){
      if(slot&&slot.session&&slot.session.status==='sailing'&&slot.session.player&&slot.session.player.alive)
        live.push(slot.session.player)}
    for(let i=0;i<live.length;i++)for(let j=i+1;j<live.length;j++){
      const a=live[i],b=live[j],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||0.001,r=Sea.CFG.boatRadius*2;
      if(d>=r)continue;
      const o=(r-d)*0.5,nx=dx/d,ny=dy/d;
      a.x-=nx*o;a.y-=ny*o;b.x+=nx*o;b.y+=ny*o}}
  for(const [uid,slot] of seaSessions){
    try{
      if(!slot||!slot.session||slot.session.status!=='sailing')continue;
      if(!slot.sockId&&slot.dropAt&&now>slot.dropAt){ // player never came back: save discoveries, free the boat
        const r=seaEnd(uid,slot,now,{timeout:true});
        if(r.ok)Promise.resolve(island.saveSea(uid,r.discoveries)).catch(()=>{});
        continue}
      Sea.tick(slot.session,dt,now);
      // if the player was sunk by crocodile / NPC contact this frame, end the voyage
      if(slot.session.player&&!slot.session.player.alive){
        seaSink(uid,slot,null,now).catch(e=>console.error('[sea] contact sink',e.message));
        continue}
      if(slot.session.dirty){slot.session.dirty=false;seaQueueSave(uid,slot)}
      if(slot.sockId){
        const sock=io.sockets.sockets.get(slot.sockId);
        if(sock){const pack=seaPackFor(uid,slot,now,voy,false);(pack.events&&pack.events.length?sock:sock.volatile).emit('sea:state',pack)}}
    }catch(e){console.error('[sea] loop',e.message)}
  }
  if(now-lastClean>30000){ // forget boats that are fully repaired again and cooldowns that ended
    lastClean=now;
    for(const [u,v] of seaVitals)if(now-v.at>Sea.CFG.regenSeconds*1000+1000)seaVitals.delete(u);
    for(const [u,t] of seaCooldown)if(t<=now)seaCooldown.delete(u)}
},66)}

srv.listen(PORT,()=>{console.log('Drowning Dash server on :'+PORT);board.init();island.init();raceStore.init().then(rows=>{Sea.loadRaceBoards(rows);if(rows.length)console.log('[race-board] restored',rows.length,'best times')}).catch(e=>console.error('[race-board] init',e.message))}); // the game starts even if the database is down; the leaderboard just reports "unavailable"
for(const sig of['SIGTERM','SIGINT'])process.on(sig,()=>{raceStore.flush().catch(()=>{});seaFlushAll().catch(()=>{}).finally(()=>board.close().finally(()=>process.exit(0)))}); // flush gems + queued scores on redeploy/restart
