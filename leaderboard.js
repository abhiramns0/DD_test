'use strict';
// Persistent public leaderboard stored in PostgreSQL (Supabase). Credentials come ONLY from the server environment (DATABASE_URL).
// Rules kept from the old in-memory version: score = highest co-op level reached (separate Solo / Multiplayer boards),
// ranked by score desc, then who reached it first. A player's best score only ever goes UP.
// Failure policy: a database problem NEVER erases or replaces stored data and never produces invented rows -
// writes are queued and retried, reads return the last real list we saw (marked stale) or an explicit error.
const {Pool}=require('pg');

const PLAY={solo:'solo',mp:'multiplayer'};                    // board key used by the game  ->  lb_scores.play_type
const MODE='coop';                                             // the game records co-op levels today
const ID_RE=/^[a-f0-9]{16,32}$/;
const MAX_LEVEL=+process.env.LB_MAX_LEVEL||200;                // anything above this is rejected as implausible
const MAX_PENDING=2000;
const cleanName=n=>String(n||'').replace(/[^\p{L}\p{N} _.-]/gu,'').trim().slice(0,14);
const validUid=u=>typeof u==='string'&&ID_RE.test(u);

function create(log=console){
  const url=process.env.DATABASE_URL||'';
  const st={configured:!!url,ok:false,lastError:'',lastOkAt:0};
  let pool=null;
  if(url){
    pool=new Pool({connectionString:url,
      ssl:process.env.DATABASE_SSL==='off'?false:{rejectUnauthorized:false}, // Supabase requires TLS
      max:+process.env.DB_POOL_MAX||5,idleTimeoutMillis:30000,connectionTimeoutMillis:8000,statement_timeout:8000,query_timeout:10000,keepAlive:true});
    pool.on('error',e=>{st.ok=false;st.lastError=e.message;log.error('[leaderboard] idle connection error:',e.message)});
  }else log.warn('[leaderboard] DATABASE_URL is not set -> the public leaderboard is DISABLED (nothing is stored or shown, nothing is invented).');

  const pending=new Map(),pendingNames=new Map(),best=new Map(),lastGood={};   // pending: unsaved scores; best: highest level already queued/saved this process
  let flushing=false,fails=0,nextTry=0,timer=null;

  // ---- write path -------------------------------------------------------------------------------------------------
  function record(s){ // {uid,name,kind:'solo'|'mp',level}  (called by the game server when a level starts - server-authoritative, not client-submitted)
    if(!pool||!s||!validUid(s.uid)||!PLAY[s.kind]||!Number.isInteger(s.level)||s.level<1||s.level>MAX_LEVEL)return false;
    const key=s.uid+'|'+s.kind,name=cleanName(s.name)||'Player';
    if(s.level<=(best.get(key)||0)){rename(s.uid,name);return false}                     // duplicate / not an improvement
    best.set(key,s.level);pending.set(key,{uid:s.uid,name,kind:s.kind,level:s.level});
    if(pending.size>MAX_PENDING){const k=pending.keys().next().value;pending.delete(k);log.error('[leaderboard] queue full, dropped oldest unsaved score')}
    kick();return true}
  function rename(uid,name){const n=cleanName(name);if(pool&&validUid(uid)&&n){pendingNames.set(uid,n);kick()}}
  function kick(){if(!timer&&pool)timer=setTimeout(()=>{timer=null;flush()},400)}

  async function upsert(v){
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      await c.query(`INSERT INTO lb_players (player_id,name) VALUES ($1,$2)
                     ON CONFLICT (player_id) DO UPDATE SET name=EXCLUDED.name, updated_at=now()`,[v.uid,v.name]);
      await c.query(`INSERT INTO lb_scores (player_id,game_mode,play_type,score) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (player_id,game_mode,play_type) DO UPDATE SET
                       score=GREATEST(lb_scores.score,EXCLUDED.score),
                       achieved_at=CASE WHEN EXCLUDED.score>lb_scores.score THEN now() ELSE lb_scores.achieved_at END,
                       updated_at=now()`,[v.uid,MODE,PLAY[v.kind],v.level]);
      await c.query('COMMIT');
    }catch(e){try{await c.query('ROLLBACK')}catch(_){}throw e}
    finally{c.release()}}
  const permanent=e=>e&&typeof e.code==='string'&&/^(22|23)/.test(e.code);  // bad data / constraint: retrying can never succeed

  async function flush(){
    if(!pool||flushing||Date.now()<nextTry)return;
    flushing=true;
    try{
      for(const[k,v]of[...pending]){
        try{await upsert(v)}catch(e){if(permanent(e)){log.error('[leaderboard] rejected score',k,v.level,'-',e.message);pending.delete(k);continue}throw e}
        if(pending.get(k)===v)pending.delete(k);
      }
      for(const[u,n]of[...pendingNames]){
        await pool.query('UPDATE lb_players SET name=$2, updated_at=now() WHERE player_id=$1 AND name<>$2',[u,n]);
        if(pendingNames.get(u)===n)pendingNames.delete(u);
      }
      st.ok=true;st.lastError='';st.lastOkAt=Date.now();fails=0;
    }catch(e){
      st.ok=false;st.lastError=e.message;fails++;nextTry=Date.now()+Math.min(60000,1000*2**fails);
      log.error('[leaderboard] database write failed; keeping',pending.size,'score(s) queued and retrying:',e.message);
      setTimeout(kick,Math.max(0,nextTry-Date.now())+50);
    }finally{flushing=false}
  }

  // ---- read path --------------------------------------------------------------------------------------------------
  const rankSql=`SELECT s.score,
      1+(SELECT count(*) FROM lb_scores x WHERE x.game_mode=s.game_mode AND x.play_type=s.play_type AND x.score>0 AND
         (x.score>s.score OR (x.score=s.score AND (x.achieved_at<s.achieved_at OR (x.achieved_at=s.achieved_at AND x.player_id<s.player_id))))) AS rank
    FROM lb_scores s WHERE s.game_mode=$1 AND s.play_type=$2 AND s.player_id=$3 AND s.score>0`;
  async function top(kind,uid){ // -> {rows:[{rank,name,score,me}], me:{rank,score}|null, stale?, error?}
    const play=PLAY[kind]||'solo';
    if(!pool)return{rows:[],me:null,error:'not_configured'};
    try{
      const r=await pool.query(`SELECT s.player_id,p.name,s.score FROM lb_scores s JOIN lb_players p USING (player_id)
        WHERE s.game_mode=$1 AND s.play_type=$2 AND s.score>0
        ORDER BY s.score DESC, s.achieved_at ASC, s.player_id ASC LIMIT 50`,[MODE,play]);
      let me=null;const ids=r.rows.map(x=>x.player_id),i=validUid(uid)?ids.indexOf(uid):-1;
      if(i>=0)me={rank:i+1,score:r.rows[i].score};
      else if(validUid(uid)){const m=await pool.query(rankSql,[MODE,play,uid]);if(m.rows[0])me={rank:+m.rows[0].rank,score:m.rows[0].score}}
      lastGood[play]={at:Date.now(),list:r.rows.map(x=>({id:x.player_id,name:x.name,score:x.score}))};
      st.ok=true;st.lastError='';st.lastOkAt=Date.now();
      return{rows:r.rows.map((x,k)=>({rank:k+1,name:x.name,score:x.score,me:x.player_id===uid?1:0})),me};
    }catch(e){
      st.ok=false;st.lastError=e.message;log.error('[leaderboard] read failed:',e.message);
      const g=lastGood[play]; // last REAL list we had - never fabricated, clearly flagged as stale
      if(g)return{rows:g.list.map((x,k)=>({rank:k+1,name:x.name,score:x.score,me:x.id===uid?1:0})),me:null,stale:true,error:'unavailable'};
      return{rows:[],me:null,error:'unavailable'};
    }
  }

  // ---- accounts: profile (unlock progress + purchases), guest -> account merge, delete ---------------------------------
  const EMPTY=()=>({name:'',done:0,skins:[],scenery:[]});
  const idList=a=>(Array.isArray(a)?a:[]).filter(x=>typeof x==='string'&&x.length<24);
  async function ensurePlayer(c,uid,name){await c.query('INSERT INTO lb_players (player_id,name) VALUES ($1,$2) ON CONFLICT (player_id) DO NOTHING',[uid,cleanName(name)||'Player'])}
  async function profile(uid){ // never throws: a database problem just means "nothing known yet"
    if(!pool||!validUid(uid))return EMPTY();
    try{const r=await pool.query('SELECT p.name,f.done_level,f.owned_skins,f.owned_scenery FROM lb_players p LEFT JOIN lb_profiles f USING (player_id) WHERE p.player_id=$1',[uid]);
      const x=r.rows[0];return x?{name:x.name==='Player'?'':x.name,done:x.done_level||0,skins:x.owned_skins||[],scenery:x.owned_scenery||[]}:EMPTY()}
    catch(e){log.error('[leaderboard] profile read failed:',e.message);return EMPTY()}}
  async function progress(uid,done){ // highest solo level completed - only ever goes up
    done=Math.floor(+done);if(!pool||!validUid(uid)||!(done>=1)||done>MAX_LEVEL)return false;
    const c=await pool.connect().catch(()=>null);if(!c)return false;
    try{await ensurePlayer(c,uid);
      await c.query(`INSERT INTO lb_profiles (player_id,done_level) VALUES ($1,$2)
        ON CONFLICT (player_id) DO UPDATE SET done_level=GREATEST(lb_profiles.done_level,EXCLUDED.done_level),updated_at=now()`,[uid,done]);return true}
    catch(e){log.error('[leaderboard] progress save failed:',e.message);return false}finally{c.release()}}
  // Moves everything a guest earned into the account: best scores (higher wins, earlier date wins ties), unlock progress, purchases.
  // Atomic, safe to repeat, and a guest id can only ever be claimed by ONE account.
  async function merge(guest,account){
    if(!pool)return{ok:false,err:'unavailable'};
    if(!validUid(guest)||!validUid(account)||guest===account)return{ok:false,err:'bad_request'};
    try{await flush()}catch(e){} // make sure scores recorded a moment ago are in the database before they are moved
    let c;try{c=await pool.connect()}catch(e){return{ok:false,err:'unavailable'}}
    try{
      await c.query('BEGIN');
      const lk=await c.query('SELECT account_id FROM lb_links WHERE guest_id=$1',[guest]);
      const out={ok:true,moved:{solo:0,mp:0,done:0,skins:[],scenery:[]}};
      if(lk.rows[0]&&lk.rows[0].account_id!==account){await c.query('ROLLBACK');return{ok:false,err:'claimed'}}
      if(!lk.rows[0]){
        const gs=await c.query("SELECT play_type,score FROM lb_scores WHERE player_id=$1 AND game_mode=$2",[guest,MODE]);
        for(const r of gs.rows)out.moved[r.play_type==='solo'?'solo':'mp']=r.score;
        const gp=await c.query('SELECT done_level,owned_skins,owned_scenery FROM lb_profiles WHERE player_id=$1',[guest]);
        if(gp.rows[0]){out.moved.done=gp.rows[0].done_level;out.moved.skins=gp.rows[0].owned_skins;out.moved.scenery=gp.rows[0].owned_scenery}
        await c.query(`INSERT INTO lb_players (player_id,name) VALUES ($2,COALESCE((SELECT name FROM lb_players WHERE player_id=$1),'Player'))
                       ON CONFLICT (player_id) DO NOTHING`,[guest,account]);
        await c.query(`INSERT INTO lb_scores (player_id,game_mode,play_type,score,achieved_at)
                         SELECT $2,game_mode,play_type,score,achieved_at FROM lb_scores WHERE player_id=$1
                       ON CONFLICT (player_id,game_mode,play_type) DO UPDATE SET
                         achieved_at=CASE WHEN EXCLUDED.score>lb_scores.score THEN EXCLUDED.achieved_at
                                          WHEN EXCLUDED.score=lb_scores.score THEN LEAST(lb_scores.achieved_at,EXCLUDED.achieved_at)
                                          ELSE lb_scores.achieved_at END,
                         score=GREATEST(lb_scores.score,EXCLUDED.score),updated_at=now()`,[guest,account]);
        await c.query(`INSERT INTO lb_profiles (player_id,done_level,owned_skins,owned_scenery)
                         SELECT $2,done_level,owned_skins,owned_scenery FROM lb_profiles WHERE player_id=$1
                       ON CONFLICT (player_id) DO UPDATE SET
                         done_level=GREATEST(lb_profiles.done_level,EXCLUDED.done_level),
                         owned_skins=ARRAY(SELECT DISTINCT unnest(lb_profiles.owned_skins||EXCLUDED.owned_skins)),
                         owned_scenery=ARRAY(SELECT DISTINCT unnest(lb_profiles.owned_scenery||EXCLUDED.owned_scenery)),updated_at=now()`,[guest,account]);
        await c.query('INSERT INTO lb_links (guest_id,account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[guest,account]);
        await c.query('DELETE FROM lb_players WHERE player_id=$1',[guest]); // cascades to the guest's scores + profile
      }
      const sc=await c.query('SELECT play_type,score FROM lb_scores WHERE player_id=$1 AND game_mode=$2',[account,MODE]);
      await c.query('COMMIT');
      out.best={solo:0,mp:0};for(const r of sc.rows)out.best[r.play_type==='solo'?'solo':'mp']=r.score;
      for(const k of['solo','mp'])if(out.best[k])best.set(account+'|'+k,Math.max(best.get(account+'|'+k)||0,out.best[k]));
      for(const k of['solo','mp']){best.delete(guest+'|'+k);pending.delete(guest+'|'+k)}
      out.profile=await profile(account);return out;
    }catch(e){try{await c.query('ROLLBACK')}catch(_){}log.error('[leaderboard] merge failed:',e.message);return{ok:false,err:'unavailable'}}
    finally{c.release()}}
  async function remove(uid){ // deletes ALL stored data of one player (account or guest id)
    if(!pool||!validUid(uid))return false;
    for(const k of['solo','mp']){best.delete(uid+'|'+k);pending.delete(uid+'|'+k)}pendingNames.delete(uid);
    for(let i=0;i<3;i++){
      try{await pool.query('DELETE FROM lb_players WHERE player_id=$1',[uid]);await pool.query('DELETE FROM lb_links WHERE account_id=$1 OR guest_id=$1',[uid]);return true}
      catch(e){log.error('[leaderboard] delete failed (try '+(i+1)+'):',e.message);await new Promise(r=>setTimeout(r,500*(i+1)))}}
    return false}

  // ---- ops --------------------------------------------------------------------------------------------------------
  async function init(){ // startup self-check (does not block the game server from starting)
    if(!pool)return false;
    try{
      const r=await pool.query("SELECT to_regclass('public.lb_scores') AS s, to_regclass('public.lb_players') AS p");
      if(!r.rows[0].s||!r.rows[0].p){st.ok=false;st.lastError='tables missing';log.error('[leaderboard] connected, but the tables do not exist. Run supabase/migrations/001_leaderboard.sql in the Supabase SQL editor.');return false}
      st.ok=true;st.lastOkAt=Date.now();log.log('[leaderboard] PostgreSQL connected, tables found.');
      const a=await pool.query("SELECT to_regclass('public.lb_profiles') AS f, to_regclass('public.lb_links') AS l");
      if(!a.rows[0].f||!a.rows[0].l)log.error('[leaderboard] account tables are missing: run supabase/migrations/002_accounts.sql in the Supabase SQL editor (sign-in progress sync needs it).');
      return true;
    }catch(e){st.ok=false;st.lastError=e.message;log.error('[leaderboard] cannot reach PostgreSQL:',e.message);return false}
  }
  async function clear(){ // developer-only (see /admin/clear-leaderboard in server.js)
    if(!pool)return false;
    try{await pool.query('TRUNCATE lb_scores'); /* scores only: accounts, names and unlocks (lb_profiles) are kept */pending.clear();pendingNames.clear();best.clear();for(const k of Object.keys(lastGood))delete lastGood[k];return true}
    catch(e){log.error('[leaderboard] clear failed:',e.message);return false}
  }
  const status=()=>({db:!st.configured?'not_configured':st.ok?'ok':'down',queued:pending.size});
  async function close(){ // flush on shutdown/redeploy so queued scores are not lost
    if(timer){clearTimeout(timer);timer=null}nextTry=0;
    try{await Promise.race([flush(),new Promise(r=>setTimeout(r,4000))])}catch(e){}
    try{if(pool)await pool.end()}catch(e){}
  }
  return{record,rename,top,init,clear,status,close,validUid,cleanName,profile,progress,merge,remove,idList};
}
module.exports={create,validUid,cleanName};
