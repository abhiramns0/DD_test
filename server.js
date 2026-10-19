'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
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
    s.setHeader('Cache-Control',NOCACHE.has(rp)?'no-cache':rp.startsWith('/icons/')?'public, max-age=3600':'public, max-age=86400');
    if(rp==='/sw.js')s.setHeader('Service-Worker-Allowed','/');
    s.end(b)});
  const hit=findStatic(rel);
  if(hit)send(hit,rel);else if(!path.extname(rel))send(path.join(PUB,'index.html'),'/index.html');else{s.statusCode=404;s.end('not found')}
});
const io=new Server(srv,{cors:{origin:process.env.CLIENT_ORIGIN||'*'}});

// ---------- leaderboard: PostgreSQL (Supabase) via leaderboard.js. Credentials: DATABASE_URL (server environment only) ----------
const board=require('./leaderboard').create(console);
const auth=require('./auth').create(console); // Supabase sign-in (Google / Apple / email). Optional: without it everyone is a guest.
// Developer-only reset: set ADMIN_KEY in the environment, then open  /admin/clear-leaderboard?key=<ADMIN_KEY>&confirm=yes
const adminClear=()=>board.clear();

const CH='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode=()=>{let c;do{c=Array.from({length:4},()=>CH[Math.random()*CH.length|0]).join('')}while(rooms.has(c));return c};
const hex=n=>crypto.randomBytes(n).toString('hex');
const mkRoom=(opts)=>{const code=newCode(),socks=new Map();
  const rm=new Room(code,(e,d,to)=>{if(to){for(const id of to){const k=socks.get(id);if(k)k.emit(e,d)}}else io.to(code).emit(e,d)});
  rm.socks=socks;rm.solo=!!opts.solo;rm.public=!!opts.public&&!opts.solo;rm.onScore=board.record;if(MODES[opts.mode])rm.mode=opts.mode;if(opts.teamMode==='teams')rm.teamMode='teams';rooms.set(code,rm);return rm};
io.on('connection',s=>{
  let room=null,identUid=null,identAuthed=false,myAcct=null,myProf=null,lastIdentAt=0,pid='player_'+hex(2),tok=hex(8),bucket={inp:[0,0],mv:[0,0],push:[0,0],shoot:[0,0],shield:[0,0],lb:[0,0],prog:[0,0],acct:[0,0],ident:[0,0]};
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
      await board.remove(identUid);
      if(room){const rm=room;room=null;rm.socks.delete(pid);s.leave(rm.code);rm.removePlayer(pid);if(!rm.humans())rooms.delete(rm.code)}
      identUid=null;identAuthed=false;myAcct=null;myProf=null;reply({ok:true})
    }catch(e){console.error('[auth] delete account failed:',e.message);reply({ok:false,err:'failed'})}});
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
  s.on('disconnect',()=>{if(!room)return;const rm=room;if(rm.socks.get(pid)!==s)return; // a newer socket already took over this slot
    rm.socks.delete(pid);
    if(rm.state==='LOBBY')rm.removePlayer(pid);else rm.setOffline(pid,Date.now()); // grace period in game
    if(!rm.humans())rooms.delete(rm.code)});
});
// steady game loop: self-correcting timer (setInterval drifts), so every client gets evenly spaced snapshots
{const step=1000/CFG.tick;let next=Date.now();(function loop(){const n=Date.now();rooms.forEach((r,c)=>{r.tick(n);if(!r.humans())rooms.delete(c)});next+=step;if(next<Date.now()-250)next=Date.now();setTimeout(loop,Math.max(1,next-Date.now()))})()}
const PORT=process.env.PORT||3000;
srv.listen(PORT,()=>{console.log('Drowning Dash server on :'+PORT);board.init()}); // the game starts even if the database is down; the leaderboard just reports "unavailable"
for(const sig of['SIGTERM','SIGINT'])process.on(sig,()=>{board.close().finally(()=>process.exit(0))}); // flush queued scores on redeploy/restart
