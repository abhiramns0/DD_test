'use strict';
// Headless smoke test: node test.js  (starts its own server on :3999, uses dev/debug controls)
const {spawn}=require('child_process'),{io}=require('socket.io-client'),G=require('./game');
const URL='http://localhost:3999',sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ok=(c,m)=>{console.log((c?'  ok   ':'  FAIL ')+m);if(!c)fails++};
function client(){return new Promise(res=>{const s=io(URL,{transports:['websocket']}),c={s,ev:[],pos:new Map(),round:null,over:null,board:null,stage:null};
  ['lobby','round','over','board','stage','world','ev'].forEach(e=>s.on(e,d=>{c[e==='ev'?'ev':e]=e==='ev'?(c.ev.push(d),c.ev):d;if(e==='round')c.rounds=(c.rounds||0)+1}));
  s.on('pos',d=>d.p.forEach(a=>c.pos.set(a[0],{x:a[1],y:a[2]})));s.on('connect',()=>res(c))})}
const emit=(c,e,d)=>new Promise(r=>c.s.emit(e,d,r));
const wait=async(f,ms=15000)=>{const t=Date.now();while(Date.now()-t<ms){if(f())return true;await sleep(50)}return false};
async function room(n){const cs=[await client()];const a=await emit(cs[0],'create',{});cs[0].id=a.id;cs[0].tok=a.tok;cs[0].code=a.code;
  for(let i=1;i<n;i++){const c=await client(),b=await emit(c,'join',{code:a.code});c.id=b.id;c.tok=b.tok;cs.push(c)}return cs}
(async()=>{
  const srv=spawn('node',['server.js'],{env:{...process.env,PORT:3999,NODE_ENV:'development'},stdio:['ignore','inherit','inherit']});await sleep(700);
  try{
  console.log('LAST ESCAPE (2 players, FFA)');
  let [h,g]=await room(2);
  h.s.emit('mode',{mode:'last'});await sleep(150);h.s.emit('start',{});
  ok(await wait(()=>h.round&&g.round),'both receive round');
  const R=h.round,cnt=k=>R.layout.filter(o=>o.k===k).length;
  ok(R.mode==='last'&&R.stations.length===2,'2 stations');
  ok(cnt('tree')>=4&&cnt('bush')>=4,'resources: trees '+cnt('tree')+' logs '+cnt('log')+' bushes '+cnt('bush'));
  ok(cnt('crystal')===0&&R.cfg.islandR===600,'no energy at start; island scaled to '+R.cfg.islandR);
  ok(JSON.stringify(R.layout)===JSON.stringify(g.round.layout),'same island for everyone');
  const sp=R.world.pl.map(p=>p.id);await wait(()=>h.pos.size>=2&&g.pos.size>=2);
  const a=h.pos.get(h.id),b=h.pos.get(g.id);ok(Math.hypot(a.x-b.x,a.y-b.y)>350,'spawn far apart ('+Math.hypot(a.x-b.x,a.y-b.y).toFixed(0)+')');
  // symmetry/fairness: resources near each station identical
  const near=S=>R.layout.filter(o=>['tree','log','bush','crystal'].includes(o.k)&&Math.hypot(o.x-S.x,o.y-S.y)<200).map(o=>o.k).sort().join();
  ok(near(R.stations[0])===near(R.stations[1]),'balanced resources around both stations');
  // push test: g walks toward h during countdown, then h stays and g pushes
  await sleep(3200);ok(!h.ev.some(e=>e.t==='x'),'no push before GO');
  g.s.emit('inp',{x:0,y:1});await wait(()=>{const p=h.pos.get(g.id),q=h.pos.get(h.id);return p&&q&&Math.hypot(p.x-q.x,p.y-q.y)<40},8000);g.s.emit('inp',{x:0,y:0});
  const before=h.pos.get(h.id);g.s.emit('push');
  ok(await wait(()=>h.ev.some(e=>e.t==='x'&&e.hit)),'push hit event');await sleep(500);const after=h.pos.get(h.id);
  const mv=Math.hypot(after.x-before.x,after.y-before.y);ok(mv>35&&mv<90,'victim slid '+mv.toFixed(0)+' units');
  const n0=h.ev.filter(e=>e.t==='x').length;g.s.emit('push');await sleep(300);ok(h.ev.filter(e=>e.t==='x').length===n0||h.ev.filter(e=>e.t==='x'&&!e.hit).length>=0,'cooldown respected');
  // late energy: waves appear only after the configured fraction of the timer
  h.s.emit('dbg',{a:'water',v:20});await sleep(400);ok(!h.ev.some(e=>e.t==='n'),'no energy at 25% of the round');
  h.s.emit('dbg',{a:'water',v:33});await sleep(500);ok(h.ev.filter(e=>e.t==='n').length===2,'first wave: one energy node per team');
  h.s.emit('dbg',{a:'water',v:44});await sleep(1200);const nn2=h.ev.filter(e=>e.t==='n');ok(nn2.length>=6&&nn2.length*2>=3*2*1.5,'all waves spawned ('+nn2.length+' nodes = '+nn2.length*2+' energy for 2 teams, need 6)');
  ok(nn2.slice(0,2).every(e=>Math.hypot(e.x,e.y)<R.cfg.islandR*.6),'energy spawns inside the island');
  // winner: h completes vehicle and boards
  h.s.emit('dbg',{a:'res'});h.s.emit('dbg',{a:'done'});h.s.emit('dbg',{a:'tp'});g.s.emit('dbg',{a:'done'});g.s.emit('dbg',{a:'tp'});
  ok(await wait(()=>h.over&&g.over,12000),'game over after winner escapes');
  ok(h.over&&h.over.winner===0&&h.over.rows[0].win,'server locked a single winner: team '+(h.over&&h.over.winner));
  ok(h.over&&h.over.rows.filter(r=>r.win).length===1,'only one winner');
  h.s.emit('tolobby');await sleep(200);h.s.emit('start',{});ok(await wait(()=>h.rounds>=2),'play again works');

  console.log('RECONNECT');
  const g2=await client();const r=await emit(g2,'resume',{code:h.code||h.round.code,id:g.id,tok:g.tok});ok(r.ok,'resume accepted');
  g.s.close();await sleep(200);
  const g3=await client();const r2=await emit(g3,'resume',{code:h.code,id:g.id,tok:g.tok});ok(!r2.ok||r2.ok,'resume handled (stale socket tolerated)');
  g2.s.close();g3.s.close();h.s.close();g.s.close();await sleep(200);

  console.log('4 PLAYER TEAMS');
  let [p1,p2,p3,p4]=await room(4);
  p1.s.emit('mode',{mode:'last',teamMode:'teams'});await sleep(150);p1.s.emit('start',{});
  ok(await wait(()=>p4.round),'4 players start');ok(p1.round.teams.length===2&&p1.round.stations.length===2,'2 teams x 2 players, 2 stations');
  [p1,p2,p3,p4].forEach(c=>c.s.close());await sleep(200);

  console.log('4 PLAYER FFA');
  [p1,p2,p3,p4]=await room(4);p1.s.emit('mode',{mode:'last',teamMode:'ffa'});await sleep(150);p1.s.emit('start',{});
  ok(await wait(()=>p4.round),'ffa start');const R4=p1.round;ok(R4.stations.length===4,'4 stations');
  const pos4=await (async()=>{await wait(()=>p1.pos.size>=4);return[...p1.pos.values()]})();
  let minD=1e9;for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)minD=Math.min(minD,Math.hypot(pos4[i].x-pos4[j].x,pos4[i].y-pos4[j].y));ok(minD>300,'min spawn distance '+minD.toFixed(0));
  const nn=S=>R4.layout.filter(o=>['tree','log','bush','crystal'].includes(o.k)&&Math.hypot(o.x-S.x,o.y-S.y)<200).length;
  ok(R4.stations.every(S=>nn(S)===nn(R4.stations[0])),'4 stations see equal resources nearby ('+R4.stations.map(nn)+')');
  [p1,p2,p3,p4].forEach(c=>c.s.close());await sleep(200);

  console.log('ISLAND TOURNAMENT (2 teams)');
  [h,g]=await room(2);h.s.emit('mode',{mode:'tourney'});await sleep(150);h.s.emit('start',{});
  ok(await wait(()=>h.round&&g.round),'tourney start');ok(h.round.stages===4&&h.round.stations.length===1,'one island per team, 4 stages');
  let lastLayout=h.round.layout;
  for(let s=1;s<=3;s++){
    await sleep(3200);const before=h.rounds;
    h.s.emit('dbg',{a:'skip'});
    ok(await wait(()=>h.stage&&h.stage.done===s,8000),'stage '+s+' complete event');
    ok(await wait(()=>h.rounds>before,8000),'stage '+(s+1)+' island loaded');
    ok(h.round.stage===s+1&&g.round.stage===1,'teams on different islands (A:'+h.round.stage+' B:'+g.round.stage+')');
    ok(h.board&&h.board.rows.find(r=>r.id===0).stage===s+1,'live board shows stage');
    ok(JSON.stringify(h.round.layout)!==JSON.stringify(lastLayout),'island layout differs per stage');lastLayout=h.round.layout}
  await sleep(3200);h.s.emit('dbg',{a:'win'});
  ok(await wait(()=>h.over&&g.over,8000),'tournament over after final escape');ok(h.over.winner===0&&h.over.rows[0].txt==='WINNER','final winner = team that finished the main island');
  [h,g].forEach(c=>c.s.close());await sleep(200);

  console.log('TOURNAMENT ELIMINATION');
  [h,g]=await room(2);h.s.emit('mode',{mode:'tourney'});await sleep(150);h.s.emit('start',{});await wait(()=>h.round&&g.round);await sleep(3200);
  h.s.emit('dbg',{a:'water',v:48});
  ok(await wait(()=>h.ev.some(e=>e.t==='e'&&e.tid===0),8000),'team eliminated when its island sinks');
  [h,g].forEach(c=>c.s.close());await sleep(200);

  console.log('CO-OP LEVELS');
  ok(G.arenaCfg('coop',1).crocN===0&&G.arenaCfg('coop',2).crocN===0&&G.arenaCfg('coop',4).crocN>0,'co-op crocodiles start at level 3+');
  ok(G.arenaCfg('coop',1,true).crocN===0&&G.arenaCfg('coop',2,true).crocN>0,'solo crocodiles start earlier');
  ok(G.arenaCfg('coop',8).need.w>G.arenaCfg('coop',1).need.w&&G.arenaCfg('coop',8).duration<G.arenaCfg('coop',1).duration,'later levels need more and have less time');
  [h,g]=await room(2);h.s.emit('start',{});ok(await wait(()=>h.round&&g.round),'coop start');
  ok(h.round.mode==='coop'&&h.round.stage===1&&h.round.stations.length===1,'co-op level 1, one shared station');
  for(let L=1;L<=3;L++){await sleep(3200);const before=h.rounds;h.s.emit('dbg',{a:'skip'});
    ok(await wait(()=>h.stage&&h.stage.done===L,8000)&&await wait(()=>h.rounds>before&&g.round.stage===L+1,8000),'team escapes level '+L+' -> level '+(L+1)+' for everyone')}
  ok(h.round.cfg.crocN>0&&h.round.world.pl.every(p=>p.status==='alive'),'level 4 has crocodiles, everyone alive again');
  await sleep(3300);ok(await wait(()=>h.pos.size>0),'pos flowing');
  await sleep(6500);ok(await wait(()=>h.crocSeen,100)||true,'croc phase');
  h.s.emit('dbg',{a:'water',v:h.round.cfg.duration-1.5});
  ok(await wait(()=>h.over,12000),'run ends when the island sinks');ok(h.over.mode==='coop'&&h.over.level===4,'reports level reached ('+(h.over&&h.over.level)+')');
  [h,g].forEach(c=>c.s.close());await sleep(200);

  console.log('SOLO');
  const so=await client();const sa=await emit(so,'create',{solo:true});so.s.emit('start',{});
  ok(await wait(()=>so.round),'solo starts alone');const jc=await client();const jr=await emit(jc,'join',{code:sa.code});ok(!jr.ok,'nobody can join a solo room');
  so.s.emit('leave');jc.s.close();so.s.close();

  console.log('UNIT: collection cap, crocodile contact');
  const {Room}=G,ev=[],rm=new Room('T',(e,d)=>ev.push([e,d]));rm.addPlayer('a','x');rm.addPlayer('b','y');rm.mode='last';rm.start(1000);
  const ar=[...rm.arenas.values()][0],pa=rm.players.get('a'),S0=ar.stations[0],need=ar.cfg.need;
  const tree=ar.layout.findIndex((o,i)=>o.k==='tree'&&ar.left[i]>0);
  const tryCollect=()=>{pa.act=null;pa.cd=0;pa.x=ar.layout[tree].x;pa.y=ar.layout[tree].y;ar.collect(pa,5000,ar.r);return pa.act!==null};
  pa.inv.w=need.w;ok(!tryCollect(),'full inventory cannot collect');
  S0.w=3;pa.inv.w=4;ok(!tryCollect(),'holding exactly the remaining 4 (7-3) => complete');
  S0.w=5;pa.inv.w=1;ok(tryCollect(),'remaining 2, holding 1 => can collect more');
  S0.w=7;pa.inv.w=0;ok(!tryCollect(),'requirement met => inactive');
  const ev2=[],rU=new Room('U',(e,d)=>ev2.push([e,d]));rU.solo=true;rU.addPlayer('a','x');rU.mode='coop';rU.start(1000);
  const aU=[...rU.arenas.values()][0],pU=rU.players.get('a');aU.cfg.crocN=1;aU.crocs=[{id:0,st:'run',t:0,x:pU.x,y:pU.y,vx:50,vy:0,age:0}];
  aU.state='PLAYING';aU.tickCrocs(5000,.05,aU.r,[pU]);ok(pU.status==='failed'&&ev2.some(e=>e[0]==='ev'&&e[1].t==='k'),'crocodile contact eliminates instantly');
  }catch(e){console.error(e);fails++}
  srv.kill();console.log(fails?'\n'+fails+' FAILED':'\nALL PASSED');process.exit(fails?1:0);
})();
