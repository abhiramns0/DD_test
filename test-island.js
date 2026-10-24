'use strict';
// node test-island.js            -> island rules + store logic (in-memory backend, no database needed)
// DATABASE_URL=... node test-island.js  -> the SAME checks against real PostgreSQL (needs 001-003 SQL run; touches only the test ids below)
const I=require('./island'),{create}=require('./island-store');
let fails=0;const ok=(c,m)=>{console.log((c?'  ok   ':'  FAIL ')+m);if(!c)fails++};
const A='a1'.repeat(8),B='b2'.repeat(8),quiet={log(){},warn(){},error(){}};

(async()=>{
  console.log('island rules');
  const d=I.createDefault(),n=I.normalize(d);
  ok(n.ok&&n.dropped===0,'default island passes its own validation');
  ok(d.structures.some(s=>s.type==='workshop')&&d.structures.some(s=>s.type==='jetty')&&d.structures.filter(s=>I.STRUCTURES[s.type].kind==='decor').length>=3,'default island has Workshop, Boat Jetty and a decorative area');
  const tiles=I.terrainGrid(d.unlocked);
  ok(tiles.every(r=>r.length===I.GRID.w)&&tiles.length===I.GRID.h&&tiles[0][0]==='w'&&tiles[10][10]==='g','terrain grid is derived from unlocked zones');
  ok(I.view(d,1).zones.filter(z=>z.unlocked).length===1&&I.view(d,1).zones.length>1,'one zone unlocked, expansion zones present but locked');
  ok(!I.normalize({v:99}).ok&&I.normalize({v:99}).err==='too_new','data from a newer game version is refused (never overwritten)');
  ok(!I.normalize(null).ok&&!I.normalize([]).ok,'corrupt documents are refused');
  const messy=I.normalize({v:1,unlocked:['core','nope'],structures:[{id:'s1',type:'workshop',x:7,y:6},{id:'s2',type:'workshop',x:7,y:6},{id:'s3',type:'dragon',x:1,y:1},{id:'s4',type:'palm',x:0,y:0},{id:'x',type:'palm',x:8,y:12}]});
  ok(messy.ok&&messy.doc.structures.length===1&&messy.dropped===4,'overlapping / unknown / off-land / badly-named structures are dropped, valid ones kept');
  let r=I.apply(d,{op:'place',type:'palm',x:8,y:11});ok(r.ok&&r.doc.structures.length===d.structures.length+1&&d.structures.length===7,'place decor on free land (input document not mutated)');
  ok(I.apply(d,{op:'place',type:'palm',x:8,y:7}).err==='occupied','cannot place on the Workshop');
  ok(I.apply(d,{op:'place',type:'palm',x:0,y:0}).err==='not_land','cannot place on water');
  ok(I.apply(d,{op:'place',type:'palm',x:7.5,y:3}).err==='bad_position','fractional coordinates rejected');
  ok(I.apply(d,{op:'place',type:'palm',x:-1,y:5}).err==='out_of_bounds','out-of-grid rejected');
  ok(I.apply(d,{op:'place',type:'workshop',x:11,y:5}).err==='bad_type','buildings cannot be spawned by a player');
  ok(I.apply(d,{op:'place',type:'palm',x:'8',y:'11'}).err==='bad_position','string coordinates rejected');
  ok(I.apply(d,{op:'__proto__'}).err==='bad_action'&&I.apply(d,{op:'constructor'}).err==='bad_action'&&I.apply(d,null).err==='bad_action','unknown / prototype-name actions rejected');
  ok(I.apply(d,{op:'remove',id:'s1'}).err==='locked'&&I.apply(d,{op:'remove',id:'s2'}).err==='locked','Workshop and Jetty cannot be removed');
  ok(I.apply(d,{op:'remove',id:'s3'}).ok&&I.apply(d,{op:'remove',id:'zzz'}).err==='not_found','decor can be removed');
  let big=d;for(let k=0;big&&k<60;k++){const spot=[[8,10],[9,10],[10,10],[11,10],[12,10],[8,11],[9,11],[10,11],[11,11],[12,11],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[11,5],[12,5],[13,5],[14,5],[5,6],[5,7],[14,6],[14,7],[14,8],[14,9]][k];if(!spot)break;const q=I.apply(big,{op:'place',type:'rock',x:spot[0],y:spot[1]});if(!q.ok){ok(q.err==='limit','decor limit enforced ('+q.err+')');big=null}else big=q.doc}

  const suite=async(label,mk)=>{
    console.log('\nstore: '+label);
    const s1=mk();await s1.clean([A,B]);
    let r=await s1.store.load(A);
    ok(r.ok&&r.created&&r.island.rev===1&&r.island.structures.length===7,'new player receives an island');
    const again=await s1.store.load(A);ok(again.ok&&!again.created&&JSON.stringify(again.island)===JSON.stringify(r.island),'loading again returns the SAME island (no duplicate / re-create)');
    const par=await Promise.all([s1.store.load(B),s1.store.load(B),s1.store.load(B)]);ok(par.every(x=>x.ok)&&par.filter(x=>x.created).length===1,'three simultaneous first loads create exactly one island');
    let a=await s1.store.act(A,{op:'place',type:'palm',x:8,y:11},1);ok(a.ok&&a.island.rev===2&&a.island.structures.length===8,'valid action saved, revision bumped');
    ok((await s1.store.act(A,{op:'place',type:'palm',x:8,y:7},2)).err==='occupied','invalid action refused and nothing saved');
    const st=await s1.store.act(A,{op:'place',type:'rock',x:9,y:11},1);ok(!st.ok&&st.err==='stale'&&st.island.rev===2,'out-of-date client gets "stale" plus the real island');
    const race=await Promise.all([s1.store.act(A,{op:'place',type:'rock',x:10,y:11},2),s1.store.act(A,{op:'place',type:'rock',x:11,y:11},2)]);
    ok(race.filter(x=>x.ok).length===1&&race.filter(x=>x.err==='stale').length===1,'two devices saving at once: one wins, the other is told it is stale');
    const bl=await s1.store.load(B);ok(bl.island.structures.length===7&&bl.island.rev===1,'a different player\'s island is untouched');
    const s2=mk();const back=await s2.store.load(A);ok(back.ok&&!back.created&&back.island.structures.length===9&&back.island.rev===3,'after a restart (new store instance) the player\'s changes are all still there');
    ok((await s2.store.load('nothex')).err==='bad_id'&&(await s2.store.act('../x',{op:'place'},1)).err==='bad_id','malformed owner ids rejected');
    ok((await s2.store.act('c3'.repeat(8),{op:'place',type:'palm',x:8,y:11},1)).err==='no_island','acting on an island that was never created fails (no implicit creation)');
    await s2.store.remove(A);const fresh=await s2.store.load(A);ok(fresh.created&&fresh.island.rev===1&&fresh.island.structures.length===7,'after delete, the player starts over with a fresh default island');
    await s1.clean([A,B]);if(s1.close)await s1.close();if(s2.close)await s2.close()};

  const mem=new Map();
  await suite('in-memory backend (restart = new store sharing the same Map)',()=>({store:create({log:quiet,mem}),clean:async ids=>ids.forEach(i=>mem.delete(i))}));
  if(process.env.DATABASE_URL){
    const {Pool}=require('pg'),pools=[];
    await suite('PostgreSQL backend (restart = brand-new connection pool)',()=>{const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='off'?false:{rejectUnauthorized:false}});pools.push(pool);
      return{store:create({pool,log:quiet}),close:()=>pool.end().catch(()=>{}),clean:async ids=>{for(const i of ids)await pool.query('DELETE FROM lb_players WHERE player_id=$1',[i])}}});
  }else console.log('\n(PostgreSQL backend skipped: set DATABASE_URL to run the same checks against the real database)');
  console.log(fails?'\n'+fails+' FAILED':'\nISLAND TESTS PASSED');process.exit(fails?1:0)})();
