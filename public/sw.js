// Drowning Dash service worker: caches the static game shell only.
// It NEVER touches /socket.io/ (live multiplayer), non-GET requests or other origins (analytics, ads, socket.io client CDN).
// Bump VERSION whenever the shell changes so phones drop the old cache and pick up the new game.
const VERSION='dd-v14',SHELL=['/','/index.html','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/apple-touch-icon.png'];

self.addEventListener('install',e=>{
  // one missing file must never stop the service worker (and so the install option) from activating
  e.waitUntil(
    caches.open(VERSION)
      .then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{}))))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin)return;                                        // other origins / writes: straight to the network
  if(u.pathname.startsWith('/socket.io')||u.pathname==='/health'||u.pathname.startsWith('/health/')||u.pathname.startsWith('/admin/')||u.pathname==='/sw.js')return; // live game traffic: never cached
  if(r.mode==='navigate'){ // always try the network first so players get new versions; fall back to the cached shell offline
    e.respondWith(
      fetch(r).then(res=>{
        if(res.ok){const c=res.clone();caches.open(VERSION).then(ch=>ch.put('/index.html',c))}
        return res;
      }).catch(()=>caches.match('/index.html').then(hit=>hit||caches.match('/')))
    );
    return;
  }
  e.respondWith(
    caches.match(r).then(hit=>{
      const net=fetch(r).then(res=>{
        if(res.ok){const c=res.clone();caches.open(VERSION).then(ch=>ch.put(r,c))}
        return res;
      }).catch(()=>hit);
      return hit||net;
    })
  );
});
