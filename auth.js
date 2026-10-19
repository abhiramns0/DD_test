'use strict';
// Verifies Supabase Auth sessions for the game server (no extra npm package: plain fetch, Node >= 18).
// Env (server only):  SUPABASE_URL, SUPABASE_ANON_KEY  -> sign-in checking.   SUPABASE_SERVICE_ROLE_KEY -> "Delete account" only.
// If SUPABASE_URL / SUPABASE_ANON_KEY are missing the game still runs: everyone is simply a guest.
// A signed-in player's leaderboard id = Supabase user id without dashes (32 hex chars) - fits leaderboard.js validUid().
const clean=v=>String(v||'').trim().replace(/^["']+|["']+$/g,'').trim();            // Render values pasted with quotes / spaces / newlines
const fixUrl=v=>{v=clean(v);if(!v)return'';if(/^[a-z][a-z0-9+.-]*:\/\//i.test(v)&&!/^https?:\/\//i.test(v))return'';  // postgresql://, etc. is NOT a project URL -> rejected (never sent to browsers)
  if(!/^https?:\/\//i.test(v))v='https://'+v;return v.replace(/\/(rest|auth)\/v1.*$/i,'').replace(/\/+$/,'')}; // adds a missing https://, drops a trailing /rest/v1 or slash
const URL_=fixUrl(process.env.SUPABASE_URL),ANON=clean(process.env.SUPABASE_ANON_KEY).replace(/^Bearer\s+/i,''),SVC=clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
// SAFETY: the anon key goes into the page for everyone. If someone pasted the secret / service_role key there by mistake, never publish it.
const jwtRole=k=>{try{return JSON.parse(Buffer.from(k.split('.')[1],'base64').toString('utf8')).role||''}catch(e){return''}};
const keyIsSecret=k=>/^sb_secret_/.test(k)||jwtRole(k)==='service_role';
const keyShape=k=>!k?'missing':keyIsSecret(k)?'SECRET_KEY_IN_ANON_SLOT':/^sb_publishable_/.test(k)?'publishable':k.split('.').length===3?'jwt':'unknown';

function create(log=console){
  const configured=!!(URL_&&ANON),canDelete=!!(URL_&&SVC),cache=new Map();
  if(process.env.SUPABASE_URL&&!URL_)log.error('[auth] SUPABASE_URL is not a web address (it must look like https://<project-ref>.supabase.co). Ignored.');
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
  const pubKey=keyIsSecret(ANON)?'':ANON;                                   // what the browser may receive
  if(ANON&&!pubKey)log.error('[auth] SUPABASE_ANON_KEY contains a SECRET key. It was NOT sent to browsers. Put the anon / publishable key there instead.');
  const clientOk=!!(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(URL_)&&pubKey);   // plain host only: no credentials, no path
  return{verify,deleteUser,configured,canDelete,publicUrl:URL_,publicKey:pubKey,clientOk,
    status:()=>({configured,canDelete,urlOk:/^https:\/\/[a-z0-9-]+\.supabase\.(co|in|net)$/i.test(URL_),keyShape:keyShape(ANON),clientOk})};
}
module.exports={create};
