'use strict';
// Verifies Supabase Auth sessions for the game server (no extra npm package: plain fetch, Node >= 18).
// Env (server only):  SUPABASE_URL, SUPABASE_ANON_KEY  -> sign-in checking.   SUPABASE_SERVICE_ROLE_KEY -> "Delete account" only.
// If SUPABASE_URL / SUPABASE_ANON_KEY are missing the game still runs: everyone is simply a guest.
// A signed-in player's leaderboard id = Supabase user id without dashes (32 hex chars) - fits leaderboard.js validUid().
const URL_=(process.env.SUPABASE_URL||'').replace(/\/+$/,''),ANON=process.env.SUPABASE_ANON_KEY||'',SVC=process.env.SUPABASE_SERVICE_ROLE_KEY||'';

function create(log=console){
  const configured=!!(URL_&&ANON),canDelete=!!(URL_&&SVC),cache=new Map();
  if(!configured)log.warn('[auth] SUPABASE_URL / SUPABASE_ANON_KEY not set -> sign-in is DISABLED (everyone plays as a guest).');
  // -> {id,uid,email,provider} | null (token is invalid/expired).  THROWS when Supabase cannot be reached, so a network blip never logs anyone out.
  async function verify(token,fresh){
    if(!configured||typeof token!=='string'||token.length<20||token.length>4096)return null;
    const hit=cache.get(token);if(hit&&!fresh&&hit.exp>Date.now())return hit.u;
    const r=await fetch(URL_+'/auth/v1/user',{headers:{apikey:ANON,Authorization:'Bearer '+token},signal:AbortSignal.timeout(6000)});
    if(r.status===401||r.status===403)return null;
    if(!r.ok)throw new Error('auth service answered '+r.status);
    const j=await r.json();if(!j||typeof j.id!=='string'||!/^[0-9a-f-]{32,36}$/i.test(j.id))return null;
    const u={id:j.id,uid:j.id.replace(/-/g,'').toLowerCase(),email:j.email||'',provider:(j.app_metadata&&j.app_metadata.provider)||'email'};
    cache.set(token,{u,exp:Date.now()+60000});if(cache.size>2000)cache.delete(cache.keys().next().value);
    return u}
  async function deleteUser(id){ // permanently removes the login (needs the service-role key, which never leaves the server)
    if(!canDelete)throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    const h={apikey:SVC};if(!SVC.startsWith('sb_secret_'))h.Authorization='Bearer '+SVC; // legacy service_role keys are JWTs, new secret keys go in apikey only
    const r=await fetch(URL_+'/auth/v1/admin/users/'+encodeURIComponent(id),{method:'DELETE',headers:h,signal:AbortSignal.timeout(8000)});
    if(!r.ok&&r.status!==404)throw new Error('could not delete the login ('+r.status+')');
    for(const[k,v]of cache)if(v.u.id===id)cache.delete(k)}
  return{verify,deleteUser,configured,canDelete,status:()=>({configured,canDelete})};
}
module.exports={create};
