'use strict';
// Saves / loads islands. Knows about storage only (no rules - those are in island.js) and nothing about sockets.
// Backends: PostgreSQL (table lb_islands, survives restarts/redeploys) when a pool is given; otherwise an in-memory Map that is
// clearly reported as NOT persistent. If PostgreSQL is configured but unreachable we answer 'unavailable' - we never quietly
// fall back to memory (that would hand out an island that later conflicts with the stored one).
// Ownership: every method takes the owner id ALREADY VERIFIED by the server (see server.js 'ident'); a client can never name another owner.
const I=require('./island');
const ID_RE=/^[a-f0-9]{16,32}$/,validUid=u=>typeof u==='string'&&ID_RE.test(u);

function create({pool=null,log=console,mem=new Map()}={}){
  const st={ok:null,lastError:''};
  const fail=(e,what)=>{st.ok=false;st.lastError=e.message;log.error('[island] '+what+' failed:',e.message);return{ok:false,err:'unavailable'}};

  // ---- raw row access: {rev,data} | null
  async function read(uid){
    if(!pool){const r=mem.get(uid);return r?{rev:r.rev,data:JSON.parse(r.data)}:null}
    const r=await pool.query('SELECT rev,data FROM lb_islands WHERE player_id=$1',[uid]);return r.rows[0]||null}
  async function insert(uid,doc){ // false when the row already exists (another tab / device created it first)
    if(!pool){if(mem.has(uid))return false;mem.set(uid,{rev:1,data:JSON.stringify(doc)});return true}
    await pool.query("INSERT INTO lb_players (player_id,name) VALUES ($1,'Player') ON CONFLICT (player_id) DO NOTHING",[uid]); // the island hangs off the player row
    const r=await pool.query('INSERT INTO lb_islands (player_id,schema_v,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (player_id) DO NOTHING',[uid,I.SCHEMA,JSON.stringify(doc)]);
    return r.rowCount===1}
  async function write(uid,doc,rev){ // compare-and-swap on rev -> new rev | 0 when someone else saved first
    if(!pool){const r=mem.get(uid);if(!r||r.rev!==rev)return 0;r.rev++;r.data=JSON.stringify(doc);return r.rev}
    const r=await pool.query('UPDATE lb_islands SET data=$2::jsonb,schema_v=$3,rev=rev+1,updated_at=now() WHERE player_id=$1 AND rev=$4 RETURNING rev',[uid,JSON.stringify(doc),I.SCHEMA,rev]);
    return r.rows[0]?r.rows[0].rev:0}

  const pack=(row)=>{const n=I.normalize(row.data);
    if(!n.ok){log.error('[island] stored island rejected:',n.err);return{ok:false,err:n.err}}
    if(n.dropped)log.warn('[island] ignored',n.dropped,'invalid structure(s) in a stored island (kept in the database until the next save)');
    return{ok:true,doc:n.doc,rev:row.rev}};

  // load = get the player's island, creating the default one the first time. Safe to call from several devices at once.
  async function load(uid){
    if(!validUid(uid))return{ok:false,err:'bad_id'};
    try{
      let row=await read(uid),created=false;
      if(!row){created=await insert(uid,I.createDefault());row=await read(uid)}
      if(!row)return{ok:false,err:'unavailable'};
      const p=pack(row);if(!p.ok)return p;st.ok=true;st.lastError='';
      // If normalize unlocked extra zones (XP catch-up) or repaired structures, persist the repaired doc.
      if(JSON.stringify(p.doc)!==JSON.stringify(row.data)){
        const rev=await write(uid,p.doc,p.rev);
        if(rev)return{ok:true,created,persistent:!!pool,island:I.view(p.doc,rev)}
      }
      return{ok:true,created,persistent:!!pool,island:I.view(p.doc,p.rev)}
    }catch(e){return fail(e,'load')}}

  // act = validate + apply one player action and save it. expectRev = the revision the client was looking at.
  async function act(uid,action,expectRev){
    if(!validUid(uid))return{ok:false,err:'bad_id'};
    try{
      const row=await read(uid);if(!row)return{ok:false,err:'no_island'};
      const p=pack(row);if(!p.ok)return p;
      if(expectRev!==p.rev)return{ok:false,err:'stale',island:I.view(p.doc,p.rev)};            // client was out of date: send the truth back
      const r=I.apply(p.doc,action);if(!r.ok)return{ok:false,err:r.err,island:I.view(p.doc,p.rev)};
      const rev=await write(uid,r.doc,p.rev);
      if(!rev){const again=await read(uid),q=again&&pack(again);return{ok:false,err:'stale',island:q&&q.ok?I.view(q.doc,q.rev):undefined}} // lost a race with another device
      st.ok=true;return{ok:true,island:I.view(r.doc,rev)}
    }catch(e){return fail(e,'save')}}

  // grantXp = server-only XP award. amount/key come from the game server, never from a client payload.
  // Retries once on a lost CAS race so concurrent stage-complete events still land.
  async function grantXp(uid,amount,key){
    if(!validUid(uid))return{ok:false,err:'bad_id'};
    try{
      for(let attempt=0;attempt<3;attempt++){
        let row=await read(uid);
        if(!row){await insert(uid,I.createDefault());row=await read(uid)}
        if(!row)return{ok:false,err:'unavailable'};
        const p=pack(row);if(!p.ok)return p;
        const r=I.awardXp(p.doc,amount,key);
        if(!r.ok){
          // duplicate is not a failure for the caller — the event was already counted
          if(r.err==='duplicate')return{ok:true,duplicate:true,island:I.view(p.doc,p.rev),gained:0,unlocked:[],levelUp:false};
          return{ok:false,err:r.err,island:I.view(p.doc,p.rev)}}
        const rev=await write(uid,r.doc,p.rev);
        if(rev){st.ok=true;return{ok:true,island:I.view(r.doc,rev),gained:r.gained,unlocked:r.unlocked,levelUp:r.levelUp}}
      }
      return{ok:false,err:'stale'}
    }catch(e){return fail(e,'xp')}}

  async function remove(uid){ // data deletion (account/guest delete). In PostgreSQL the row also vanishes with lb_players (ON DELETE CASCADE).
    if(!validUid(uid))return false;
    try{if(!pool)mem.delete(uid);else await pool.query('DELETE FROM lb_islands WHERE player_id=$1',[uid]);return true}
    catch(e){log.error('[island] delete failed:',e.message);return false}}

  async function init(){ // startup self-check; never blocks the game server
    if(!pool)return log.warn('[island] no DATABASE_URL -> islands are kept in MEMORY only and are lost on restart.');
    try{const r=await pool.query("SELECT to_regclass('public.lb_islands') AS t");
      if(!r.rows[0].t){st.ok=false;st.lastError='table missing';log.error('[island] table lb_islands is missing. Run supabase/migrations/003_islands.sql in the Supabase SQL editor.')}
      else{st.ok=true;log.log('[island] lb_islands found.')}}
    catch(e){fail(e,'startup check')}}
  const status=()=>({store:pool?'postgres':'memory',persistent:!!pool,ok:pool?st.ok:true,error:st.lastError});
  return{load,act,grantXp,remove,init,status};
}
module.exports={create};
