'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {Server}=require('socket.io');
const {Room,CFG,MODES}=require('./game');
const PROD=process.env.NODE_ENV==='production',SOLO=process.env.ALLOW_SOLO==='1'||!PROD,DBG=process.env.ALLOW_DEBUG==='1'||!PROD;
const rooms=new Map();

// ---------- static files (public/) : game, PWA manifest, service worker, icons, ads.txt ----------
const PUB=path.join(__dirname,'public');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
const NOCACHE=new Set(['/index.html','/sw.js','/manifest.webmanifest']);
const srv=http.createServer((q,s)=>{
  const u=decodeURIComponent((q.url||'/').split('?')[0]);
  if(u==='/health'){s.end('ok');return}
  const rel=u==='/'?'/index.html':u,full=path.normalize(path.join(PUB,rel));
  if(!full.startsWith(PUB+path.sep)){s.statusCode=403;s.end('forbidden');return}
  const send=(file,rp)=>fs.readFile(file,(e,b)=>{
    if(e){s.statusCode=404;s.end('not found');return}
    if(rp==='/index.html'){const proto=String(q.headers['x-forwarded-proto']||'http').split(',')[0],origin=proto+'://'+q.headers.host;b=Buffer.from(b.toString('utf8').split('%%ORIGIN%%').join(origin))} // absolute URLs for share previews (og:image)
    s.setHeader('Content-Type',MIME[path.extname(file)]||'application/octet-stream');
    s.setHeader('Cache-Control',NOCACHE.has(rp)?'no-cache':'public, max-age=86400');
    if(rp==='/sw.js')s.setHeader('Service-Worker-Allowed','/');
    s.end(b)});
  fs.stat(full,(e,st)=>{if(!e&&st.isFile())send(full,rel);else if(!path.extname(rel))send(path.join(PUB,'index.html'),'/index.html');else{s.statusCode=404;s.end('not found')}});
});
const io=new Server(srv,{cors:{origin:process.env.CLIENT_ORIGIN||'*'}});

// ---------- leaderboard (best co-op level, solo and multiplayer). File persistence is best-effort: use a persistent disk / DB on hosts with ephemeral storage ----------
const LB_FILE=path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'leaderboard.json');
let lb={};try{lb=JSON.parse(fs.readFileSync(LB_FILE,'utf8'))}catch(e){}
let lbDirty=false;
setInterval(()=>{if(!lbDirty)return;lbDirty=false;try{fs.mkdirSync(path.dirname(LB_FILE),{recursive:true});fs.writeFileSync(LB_FILE,JSON.stringify(lb))}catch(e){}},15000);
const okUid=u=>typeof u==='string'&&/^[a-f0-9]{8,32}$/.test(u);
const cleanName=n=>String(n||'').replace(/[^\p{L}\p{N} _.-]/gu,'').trim().slice(0,14);
const recordScore=({uid,name,kind,level})=>{
  if(!okUid(uid)||(kind!=='solo'&&kind!=='mp')||!(level>=1&&level<=999))return;
  const e=lb[uid]||(lb[uid]={name:'Player',solo:0,mp:0}),n=cleanName(name);if(n)e.name=n;
  if(level>e[kind]){e[kind]=level;e.t=Date.now()}lbDirty=true;
  const ks=Object.keys(lb);if(ks.length>5000){ks.sort((a,b)=>Math.max(lb[a].solo,lb[a].mp)-Math.max(lb[b].solo,lb[b].mp)).slice(0,500).forEach(k=>delete lb[k])}};
const topList=(kind,uid)=>{
  const all=Object.entries(lb).filter(([,e])=>e[kind]>0).sort((a,b)=>b[1][kind]-a[1][kind]||(a[1].t||0)-(b[1].t||0));
  const rows=all.slice(0,50).map(([id,e],i)=>({rank:i+1,name:e.name,score:e[kind],me:id===uid?1:0}));
  const i=all.findIndex(([id])=>id===uid);return{rows,me:i>=0?{rank:i+1,score:all[i][1][kind]}:null}};

const CH='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode=()=>{let c;do{c=Array.from({length:4},()=>CH[Math.random()*CH.length|0]).join('')}while(rooms.has(c));return c};
const hex=n=>crypto.randomBytes(n).toString('hex');
const mkRoom=(opts)=>{const code=newCode(),socks=new Map();
  const rm=new Room(code,(e,d,to)=>{if(to){for(const id of to){const k=socks.get(id);if(k)k.emit(e,d)}}else io.to(code).emit(e,d)});
  rm.socks=socks;rm.solo=!!opts.solo;rm.public=!!opts.public&&!opts.solo;rm.onScore=recordScore;if(MODES[opts.mode])rm.mode=opts.mode;if(opts.teamMode==='teams')rm.teamMode='teams';rooms.set(code,rm);return rm};
io.on('connection',s=>{
  let room=null,pid='player_'+hex(2),tok=hex(8),bucket={inp:[0,0],push:[0,0],shoot:[0,0],shield:[0,0],lb:[0,0]};
  const lim=(k,max,perSec)=>{const b=bucket[k],t=Date.now();b[0]=Math.min(max,b[0]+(t-b[1])/1000*perSec);b[1]=t;if(b[0]<1)return false;b[0]--;return true};
  const join=rm=>{room=rm;s.join(rm.code);rm.socks.set(pid,s);rm.addPlayer(pid,tok)};
  const ack=(rm)=>({ok:true,code:rm.code,id:pid,tok,solo:SOLO,dbg:DBG,pub:rm.public});
  // enter a room: lobby = normal join (a bot makes space if needed); running public match = take over a bot's character
  const enter=(rm,cb)=>{
    if(rm.state==='LOBBY'){rm.makeRoom();join(rm)}
    else{if(!rm.takeOver(pid,tok))return cb&&cb({ok:false,err:'Game already in progress'});room=rm;s.join(rm.code);rm.socks.set(pid,s)}
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
    room=rm;pid=d.id;tok=d.tok;s.join(rm.code);rm.socks.set(pid,s);cb&&cb(ack(rm));rm.snapshot(pid);rm.lobby()});
  s.on('inp',d=>room&&lim('inp',60,60)&&room.setInput(pid,d));
  s.on('push',()=>room&&lim('push',4,6)&&room.push(pid,Date.now()));
  s.on('shoot',d=>room&&lim('shoot',4,4)&&room.shoot(pid,d,Date.now()));
  s.on('shield',()=>room&&lim('shield',2,2)&&room.shield(pid,Date.now()));
  s.on('revive',()=>room&&room.reviveSolo(pid,Date.now())); // solo second chance (see Room.reviveSolo)
  s.on('ident',d=>{ // {uid,name}: links this player to the leaderboard
    if(!d)return;const n=cleanName(d.name);if(room)room.ident(pid,d);
    if(okUid(d.uid)&&n&&lb[d.uid]&&lb[d.uid].name!==n){lb[d.uid].name=n;lbDirty=true}});
  s.on('lb',(d,cb)=>{if(typeof cb!=='function')return; // always answers, so the client never hangs on "Loading"
    if(!lim('lb',6,1))return cb({rows:[],me:null,busy:1});
    try{cb(topList(d&&d.kind==='mp'?'mp':'solo',d&&okUid(d.uid)?d.uid:''))}catch(e){cb({rows:[],me:null})}});
  s.on('name',d=>room&&room.setName(pid,d));
  s.on('skin',d=>room&&room.setSkin(pid,d));
  s.on('mode',d=>room&&room.setMode(pid,d));
  s.on('setteam',d=>room&&room.setTeam(pid,d));
  s.on('start',d=>{if(!room||room.host!==pid||!['LOBBY','GAME_OVER'].includes(room.state))return;
    if(!room.canStart(SOLO&&d&&d.solo).ok)return;room.start(Date.now())});
  s.on('leave',()=>{if(!room)return;const rm=room;room=null;rm.socks.delete(pid);s.leave(rm.code);rm.removePlayer(pid);if(!rm.humans())rooms.delete(rm.code)});
  s.on('again',()=>{if(room&&room.host===pid&&(room.state==='GAME_OVER'||(room.state==='PLAYING'&&SOLO))&&room.canStart(SOLO).ok)room.start(Date.now())});
  s.on('tolobby',()=>{if(room&&room.host===pid&&room.state==='GAME_OVER')room.toLobby()});
  s.on('dbg',d=>{if(DBG&&room)room.dbg(pid,d,Date.now())});
  s.on('disconnect',()=>{if(!room)return;const rm=room;if(rm.socks.get(pid)!==s)return; // a newer socket already took over this slot
    rm.socks.delete(pid);
    if(rm.state==='LOBBY')rm.removePlayer(pid);else rm.setOffline(pid,Date.now()); // grace period in game
    if(!rm.humans())rooms.delete(rm.code)});
});
setInterval(()=>{const n=Date.now();rooms.forEach((r,c)=>{r.tick(n);if(!r.humans())rooms.delete(c)})},1000/CFG.tick);
const PORT=process.env.PORT||3000;srv.listen(PORT,()=>console.log('Drowning Dash server on :'+PORT));
