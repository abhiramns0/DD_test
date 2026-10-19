'use strict';
// Headless test of sign-in handling: node test-auth.js   (fake Supabase auth + local server; DATABASE_URL optional)
const http=require('http'),{spawn}=require('child_process'),{io}=require('socket.io-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let fails=0;const ok=(c,m)=>{console.log((c?'  ok   ':'  FAIL ')+m);if(!c)fails++};
const USERS={'second-token-cccccccccccccccccccc':{id:'99999999-2222-3333-4444-555555555555',email:'z@b.c',app_metadata:{provider:'apple'}},'good-token-aaaaaaaaaaaaaaaaaaaa':{id:'11111111-2222-3333-4444-555555555555',email:'a@b.c',app_metadata:{provider:'google'}}};
let down=false,deleted=[];
const fake=http.createServer((q,s)=>{
  if(q.url==='/auth/v1/user'){if(down){s.statusCode=503;return s.end('x')}const u=USERS[(q.headers.authorization||'').slice(7)];if(!u){s.statusCode=401;return s.end('{}')}s.setHeader('Content-Type','application/json');return s.end(JSON.stringify(u))}
  if(q.method==='DELETE'&&q.url.startsWith('/auth/v1/admin/users/')){deleted.push(q.url.split('/').pop());return s.end('{}')}
  s.statusCode=404;s.end()});
const emit=(c,e,d)=>new Promise(r=>c.emit(e,d,r));
(async()=>{
  await new Promise(r=>fake.listen(3998,r));
  const env=Object.assign({},process.env,{PORT:3997,NODE_ENV:'development',SUPABASE_URL:'http://localhost:3998',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'svc'});
  const srv=spawn('node',['server.js'],{env,stdio:['ignore','inherit','inherit']});await sleep(800);
  try{
    const html=await (await fetch('http://localhost:3997/')).text();
    ok(html.includes('http://localhost:3998')&&!html.includes('%%SB_URL%%')&&!html.includes('%%SB_KEY%%'),'index.html receives the public Supabase URL + key');
    const h=await (await fetch('http://localhost:3997/health/auth')).json();ok(h.configured&&h.canDelete,'/health/auth reports settings');
    const c=io('http://localhost:3997',{transports:['websocket']});await new Promise(r=>c.on('connect',r));
    let r=await emit(c,'ident',{uid:'a'.repeat(16),name:'Guest'});ok(r.ok&&!r.auth,'guest ident accepted');
    r=await emit(c,'link',{guest:'a'.repeat(16)});ok(!r.ok,'a guest cannot link/merge anything');
    r=await emit(c,'ident',{token:'forged-token-bbbbbbbbbbbbbbbbbbbb',name:'X'});ok(!r.ok&&r.err==='bad_token','forged token rejected');
    r=await emit(c,'ident',{token:'good-token-aaaaaaaaaaaaaaaaaaaa',name:'Abhi'});ok(r.ok&&r.auth,'valid token accepted, guest connection upgraded to the account');
    r=await emit(c,'ident',{uid:'c'.repeat(16)});ok(!r.ok&&r.err==='switch','signed-in connection cannot be switched to another id');
    if(!process.env.DATABASE_URL){r=await emit(c,'link',{guest:'a'.repeat(16)});ok(r.err==='unavailable'||r.ok===false,'link answered (no database in this test: "unavailable")')}
    else{
      const {Pool}=require('pg'),db=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
      const G='a'.repeat(16);await db.query("TRUNCATE lb_scores");await db.query("DELETE FROM lb_links");await db.query("DELETE FROM lb_players");
      await db.query("INSERT INTO lb_players(player_id,name) VALUES ($1,'Guesty')",[G]);await db.query("INSERT INTO lb_scores(player_id,game_mode,play_type,score) VALUES ($1,'coop','solo',8)",[G]);
      await db.query("INSERT INTO lb_profiles(player_id,done_level,owned_skins) VALUES ($1,5,'{royal}')",[G]);
      r=await emit(c,'link',{guest:G});ok(r.ok&&r.moved.solo===8&&r.best.solo===8&&r.profile.done===5&&r.profile.skins[0]==='royal','guest score, unlock progress and purchase moved into the account');
      const lb=await emit(c,'lb',{kind:'solo'});ok(lb.rows.length===1&&lb.rows[0].me===1&&lb.me.score===8,'leaderboard shows the account (me) with the moved score, no guest duplicate');
      const g=io('http://localhost:3997',{transports:['websocket']});await new Promise(x=>g.on('connect',x));
      r=await emit(g,'ident',{uid:G});ok(r.ok&&r.profile.done===0,'old guest id is now empty');
      const c3=io('http://localhost:3997',{transports:['websocket']});await new Promise(x=>c3.on('connect',x));
      r=await emit(c3,'ident',{token:'good-token-aaaaaaaaaaaaaaaaaaaa',name:''});ok(r.ok&&r.name.length>0&&r.profile.done===5&&r.profile.skins[0]==='royal','new device: signing in restores name, unlocks and purchases from the account');
      g.close();c3.close();globalThis.__db=db}
    down=true;const c2=io('http://localhost:3997',{transports:['websocket']});await new Promise(r=>c2.on('connect',r));
    r=await emit(c2,'ident',{token:'second-token-cccccccccccccccccccc'});ok(!r.ok&&r.err==='auth_unavailable','Supabase outage is reported as unavailable (NOT as a bad token, so nobody gets logged out)');down=false;
    r=await emit(c,'delacc',{token:'forged-token-bbbbbbbbbbbbbbbbbbbb'});ok(!r.ok&&deleted.length===0,'delete with a bad token does nothing');
    r=await emit(c,'delacc',{token:'good-token-aaaaaaaaaaaaaaaaaaaa'});ok(r.ok&&deleted[0]==='11111111-2222-3333-4444-555555555555','delete account removes the Supabase login');
    const rows=globalThis.__db?(await globalThis.__db.query("SELECT (SELECT count(*) FROM lb_players) p,(SELECT count(*) FROM lb_scores) s,(SELECT count(*) FROM lb_links) l")).rows[0]:null;
    if(rows)ok(+rows.p===0&&+rows.s===0&&+rows.l===0,'delete account removed every stored row for the player');
    c.close();c2.close();if(globalThis.__db)await globalThis.__db.end();
  }catch(e){console.error(e);fails++}
  srv.kill();fake.close();console.log(fails?'\n'+fails+' FAILED':'\nAUTH TESTS PASSED');process.exit(fails?1:0)})();
