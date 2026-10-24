'use strict';
// node test-island-server.js
// Loads the REAL server.js with small stand-ins for socket.io / pg / game.js (so it runs anywhere, no install, no database)
// and drives its socket handlers directly. Checks the island wiring: identity binding, ownership, rate limit, delete, static files.
// It does NOT exercise real Socket.IO transport or the real game rooms (use test-auth.js style tests + a manual game for that).
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const T=fs.mkdtempSync(path.join(os.tmpdir(),'dd-'));
const w=(f,s)=>{fs.mkdirSync(path.dirname(path.join(T,f)),{recursive:true});fs.writeFileSync(path.join(T,f),s)};
for(const f of['server.js','auth.js','leaderboard.js','island.js','island-store.js'])fs.copyFileSync(path.join(__dirname,f),path.join(T,f));
fs.cpSync(path.join(__dirname,'public'),path.join(T,'public'),{recursive:true});
w('node_modules/pg/index.js','exports.Pool=class{};');
w('node_modules/socket.io/index.js',"class Server{constructor(){global.__IO=this;this.h={}}on(e,f){this.h[e]=f}to(){return{emit(){}}}}exports.Server=Server;");
w('game.js',"exports.Room=class{};exports.CFG={tick:20,maxPlayers:8,islandR:100};exports.MODES={};");
let fails=0;const ok=(c,m)=>{console.log((c?'  ok   ':'  FAIL ')+m);if(!c)fails++};
const mkSock=()=>{const h={};return{h,on(e,f){h[e]=f},join(){},leave(){},emit(){},call:(e,d)=>new Promise(r=>h[e](d,r))}};
const G1='a1'.repeat(8),G2='b2'.repeat(8);
process.env.PORT='0';delete process.env.DATABASE_URL;delete process.env.SUPABASE_URL;process.env.NODE_ENV='development';
const log=console.log;console.log=()=>{};console.warn=()=>{};console.error=()=>{};
process.chdir(T);require(path.join(T,'server.js'));console.log=log;
(async()=>{
  const io=global.__IO;const a=mkSock(),b=mkSock();io.h.connection(a);io.h.connection(b);
  let r=await a.call('island:load',{});ok(!r.ok&&r.err==='not_ready','island:load before identifying is refused');
  r=await a.call('island:act',{action:{op:'place',type:'palm',x:8,y:11},rev:1});ok(!r.ok&&r.err==='not_ready','island:act before identifying is refused');
  r=await a.call('ident',{uid:G1,name:'Alice'});ok(r.ok,'guest A identifies');
  r=await b.call('ident',{uid:G2,name:'Bob'});ok(r.ok,'guest B identifies');
  const la=await a.call('island:load',{});ok(la.ok&&la.created&&la.island.structures.length===7&&la.persistent===false,'new player A receives an island (memory store here: persistent:false is reported)');
  const lb=await b.call('island:load',{});ok(lb.ok&&lb.created,'new player B receives their own island');
  r=await a.call('island:act',{action:{op:'place',type:'palm',x:8,y:11},rev:la.island.rev});ok(r.ok&&r.island.structures.length===8,'A builds a decoration');
  const lb2=await b.call('island:load',{});ok(lb2.island.structures.length===7&&lb2.island.rev===1,'B\'s island is unaffected by A');
  r=await a.call('island:load',{uid:G2,player_id:G2,owner:G2});ok(r.ok&&r.island.structures.length===8,'an owner id in the payload is ignored: A still gets A\'s island, not B\'s');
  r=await a.call('island:act',{uid:G2,action:{op:'place',type:'rock',x:9,y:11},rev:2});const lb3=await b.call('island:load',{});ok(r.ok&&lb3.island.structures.length===7,'acting with B\'s id in the payload changes only A\'s island');
  r=await a.call('ident',{uid:G2});ok(!r.ok&&r.err==='switch','a connection cannot switch to another player\'s id after identifying');
  const a2=mkSock();io.h.connection(a2);await a2.call('ident',{uid:G1,name:'Alice'});const re=await a2.call('island:load',{});ok(re.ok&&!re.created&&re.island.structures.length===9&&re.island.rev===3,'reconnect / refresh (new connection, same player): the island and its changes are restored');
  r=await a.call('island:act',null);ok(!r.ok,'garbage island:act payload is rejected');
  r=await a.call('island:act',{action:{op:'place',type:'palm',x:1,y:1},rev:3});ok(!r.ok&&r.err==='not_land','server-side validation errors come back to the client');
  let busy=0;for(let i=0;i<30;i++){const x=await b.call('island:load',{});if(x.err==='busy')busy++}ok(busy>0,'island requests are rate limited');
  const dr=await a2.call('delacc',{});ok(dr.ok,'guest data deletion succeeds');
  const a3=mkSock();io.h.connection(a3);await a3.call('ident',{uid:G1});const fresh=await a3.call('island:load',{});ok(fresh.created&&fresh.island.rev===1,'after deleting their data the player starts with a brand-new island');
  await new Promise(res=>setTimeout(res,100));
  const addr=(()=>{try{return process._getActiveHandles().find(h=>h.constructor&&h.constructor.name==='Server'&&h.address&&h.address()).address().port}catch(e){return 0}})();
  if(addr){const get=p=>new Promise(res=>http.get('http://127.0.0.1:'+addr+p,x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>res({s:x.statusCode,b:s,t:x.headers['content-type']}))}));
    const js=await get('/island-view.js?v=1');ok(js.s===200&&/javascript/.test(js.t)&&js.b.includes('IslandView'),'/island-view.js is served as JavaScript');
    const hi=await get('/health/island');ok(hi.s===200&&JSON.parse(hi.b).store==='memory','/health/island reports the storage backend');
    const ix=await get('/');ok(ix.s===200&&ix.b.includes('id="islandBtn"')&&ix.b.includes('island-view.js'),'index.html contains the island entry point')}
  else ok(false,'could not find the HTTP server port');
  console.log(fails?'\n'+fails+' FAILED':'\nISLAND SERVER TESTS PASSED');process.exit(fails?1:0)})();
