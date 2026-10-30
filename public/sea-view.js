'use strict';
// Open Sea RENDERER — isometric 3D view matching the island / main-game projection (2:1 iso).
// Canvas stays INSIDE #sea (position:absolute). Never use position:fixed here —
// fixed + low z-index draws UNDER the #sea overlay (plain blue screen).
//
// Smoothness: the network only supplies snapshots (setState). Drawing runs on its own
// requestAnimationFrame loop (start/stop) and eases every entity toward its newest snapshot,
// so the picture never freezes between packets or when one packet is late.
(function(){
  const COL={
    deep:'#0d4a6a',mid:'#1a7a9a',lite:'#3a9ec4',foam:'rgba(200,238,248,.55)',
    home:'#7ccf6e',homeDark:'#5a9e4e',homeSand:'#f2dfa5',homeSandDark:'#d9c07e',
    islet:'#6aba5c',isletDark:'#4f9244',isletSand:'#e8d9a0',isletSandDark:'#cdb978',
    boat:'#c89a62',boatDark:'#8a6236',boatDeck:'#e0b982',
    player:'#e8b84a',playerDark:'#b88820',playerDeck:'#f4d27a',
    sail:'#fff8e8',sailShade:'#e6dcc2',mast:'#5a4030'
  };
  const SQ2=Math.SQRT2;
  const BOAT_LEN=56;            // world units — small relative to the sea (old boats were ~400px long)
  const HULL=[[-0.5,-0.15],[0.2,-0.19],[0.5,0],[0.2,0.19],[-0.5,0.15]]; // unit hull outline, +x = bow

  const cam={x:0,y:0,init:false};
  let target=null;                        // newest snapshot from the server
  let disp={player:null,ents:new Map()};  // eased (drawn) positions
  let raf=0,lastT=0,canvasRef=null,onFrame=null,lastStateAt=0;
  let _keys={};
  let selfEmo=null;                       // {id,at,ttl}: the emoji bubble on MY boat (set locally the moment it is sent)
  let aiming=false;                       // attack button held: show the cannon guide line
  let fxPulse=0;                          // performance.now() of the last attack pulse
  let popups=[];                          // floating '+1 💎' texts: {x,y,txt,t0}
  let homeScr=null;
  let chestScr=null;                      // where the openable island chest is on screen right now (for the floating chest button)                       // where the home island is on screen right now (for the floating DOCK button)
  const trails=new Map();                 // key -> [{x,y,t}] boat wake trails
  let qual=2,ftEma=16.7,qualGood=0,qualBad=0;   // adaptive quality 2=full 1=reduced resolution 0=lite: slow phones drop detail instead of stuttering
  let resync=false;                             // set after a long stall: snap everything to the newest snapshot instead of gliding across the screen
  // Snapshot interpolation: other boats / NPCs are drawn slightly in the PAST, between two real snapshots, so uneven packet
  // arrival (Wi-Fi bursts, jitter) never shows up as stutter. The delay adapts to how regular the packets are.
  const hist=new Map();                   // key -> [{t,x,y,vx,vy,f}] newest last
  let lastArr=0,ivlEma=70,jitEma=10,interpDelay=140;
  const TRAIL_MAX=48;
  const TRAIL_MS=2400;

  // ---------- projection ----------
  function metrics(canvas){
    const parent=canvas&&canvas.parentElement;
    let w=0,h=0;
    if(parent){w=parent.clientWidth|0;h=parent.clientHeight|0}
    if(!w||!h){w=Math.max(320,window.innerWidth||320);h=Math.max(480,window.innerHeight||480)}
    const A=Math.max(0.45,Math.min(w,h)/520);
    return{A,c:A*0.9,ox:w/2,oy:h*0.52,w,h};   // c = screen px per world unit along an axis
  }
  // world -> screen: sx=(dx-dy)*c , sy=(dx+dy)*c/2
  function P(x,y,m){const dx=x-cam.x,dy=y-cam.y;return[m.ox+(dx-dy)*m.c,m.oy+(dx+dy)*m.c*0.5]}
  // screen direction -> world direction (inverse of P), normalised. Used for drag + WASD.
  function dirToWorld(sx,sy){
    const a=sx,b=2*sy;                    // a = dx-dy , b = dx+dy
    const wx=(a+b)/2,wy=(b-a)/2,l=Math.hypot(wx,wy)||1;
    return{mx:wx/l,my:wy/l};
  }
  const ER=(r,m)=>[r*m.c*SQ2,r*m.c*SQ2*0.5];   // world circle -> screen ellipse radii

  // ---------- easing ----------
  const angDiff=(a,b)=>{let d=(b-a)%(Math.PI*2);if(d>Math.PI)d-=Math.PI*2;if(d<-Math.PI)d+=Math.PI*2;return d};
  function ease(e,tx,ty,tf,k,snapD){
    if(!e.init||Math.hypot(tx-e.x,ty-e.y)>snapD){e.x=tx;e.y=ty;e.f=tf||0;e.init=true;return e}
    e.x+=(tx-e.x)*k;e.y+=(ty-e.y)*k;
    if(tf!=null)e.f+=angDiff(e.f,tf)*Math.min(1,k*0.8);
    return e;
  }

  // Local intent for the player's boat (set by the page when the joystick moves).
  // We simulate the boat every frame so steering feels instant; server snaps only correct gently.
  let localIntent={mx:0,my:0};
  let localSpeed=165; // matches Sea.CFG.speed
  function setLocalIntent(mx,my){localIntent={mx:mx||0,my:my||0}}
  function setLocalSpeed(sp){if(typeof sp==='number'&&sp>0)localSpeed=sp}

  // ---------- state intake ----------
  function setState(snap){
    if(!snap)return;
    // slim pushes leave out the static world: keep the last copy
    if(target){if(!snap.islets&&target.islets)snap.islets=target.islets;if(!snap.cfg&&target.cfg)snap.cfg=target.cfg;if(!snap.mp&&target.mp)snap.mp=target.mp}
    target=snap;lastStateAt=performance.now();
    {const now=lastStateAt;
      if(lastArr){const iv=Math.min(600,now-lastArr);jitEma+=(Math.abs(iv-ivlEma)-jitEma)*0.1;ivlEma+=(iv-ivlEma)*0.1;
        const want=Math.max(90,Math.min(330,ivlEma*1.6+jitEma*2.5));interpDelay+=(want-interpDelay)*0.08}
      lastArr=now;
      const seenK=new Set();
      const add=(arr,kind,idf)=>{for(const it of(arr||[])){const k=kind+':'+idf(it);seenK.add(k);let a=hist.get(k);if(!a){a=[];hist.set(k,a)}
        a.push({t:now,x:it.x,y:it.y,vx:it.vx||0,vy:it.vy||0,f:it.facing||0});if(a.length>8)a.shift()}};
      add(snap.npcs,'npc',n=>n.id);add(snap.others,'other',o=>o.uid);add(snap.wildlife,'wild',w=>w.id);
      for(const k of[...hist.keys()])if(!seenK.has(k))hist.delete(k)}
    if(snap.cfg&&typeof snap.cfg.speed==='number')localSpeed=snap.cfg.speed;
  }
  function sampleAt(key,rt){
    const a=hist.get(key);if(!a||!a.length)return null;
    const last=a[a.length-1];
    if(rt>=last.t){const ex=Math.min(0.2,(rt-last.t)/1000);return{x:last.x+last.vx*ex,y:last.y+last.vy*ex,f:last.f}}
    if(rt<=a[0].t)return a[0];
    for(let i=a.length-1;i>0;i--){const A=a[i-1],B=a[i];
      if(A.t<=rt){const k=(rt-A.t)/((B.t-A.t)||1);return{x:A.x+(B.x-A.x)*k,y:A.y+(B.y-A.y)*k,f:A.f+angDiff(A.f,B.f)*k}}}
    return last}
  function reset(){aiming=false;hist.clear();lastArr=0;resync=false;target=null;disp={player:null,ents:new Map()};cam.init=false;lastStateAt=0;selfEmo=null;fxPulse=0;popups=[];homeScr=null;chestScr=null;trails.clear();localIntent={mx:0,my:0}}
  function showSelfEmoji(id,ttl){selfEmo={id,at:performance.now(),ttl:ttl||2500}}
  function clearSelfEmoji(){selfEmo=null}
  function pulse(){fxPulse=performance.now()}
  function setAim(on){aiming=!!on}
  function popup(txt){const p=disp.player||(target&&target.player);if(!p)return;popups.push({x:p.x,y:p.y,txt,t0:performance.now()});if(popups.length>8)popups.shift()}
  function getHome(){return homeScr}
  function getChest(){return chestScr}
  function stateAge(){return lastStateAt?performance.now()-lastStateAt:Infinity}

  function stepEntities(dt){
    const s=target;if(!s)return;
    const kEnt=1-Math.exp(-dt*16),kEntSm=1-Math.exp(-dt*28); // others / NPCs (the interpolated path needs only a light touch of smoothing)
    const age=Math.max(0,(performance.now()-lastStateAt)/1000);
    const ex=Math.min(0.12,age);

    // --- PLAYER: local prediction driven by joystick (seamless) ---
    if(s.player){
      if(!disp.player){
        disp.player={x:s.player.x||0,y:s.player.y||0,f:s.player.facing||0,vx:s.player.vx||0,vy:s.player.vy||0,init:true};
      }
      const p=disp.player;
      const imx=localIntent.mx,imy=localIntent.my;
      if(imx||imy){
        // same accel curve as server steerNpc (dt*5.5)
        const spd=localSpeed;
        const wx=imx*spd,wy=imy*spd;
        const ak=Math.min(1,dt*5.5);
        p.vx=(p.vx||0)+(wx-(p.vx||0))*ak;
        p.vy=(p.vy||0)+(wy-(p.vy||0))*ak;
        p.x+=p.vx*dt;p.y+=p.vy*dt;
        if(Math.hypot(p.vx,p.vy)>4)p.f=Math.atan2(p.vy,p.vx);
      }else{
        // coast / friction like server
        p.vx=(p.vx||0)*Math.max(0,1-dt*1.8);
        p.vy=(p.vy||0)*Math.max(0,1-dt*1.8);
        p.x+=p.vx*dt;p.y+=p.vy*dt;
      }
      // Soft reconciliation toward authoritative server position (never hard-snap unless huge error)
      const sx=(s.player.x||0)+(s.player.vx||0)*ex;
      const sy=(s.player.y||0)+(s.player.vy||0)*ex;
      const err=Math.hypot(sx-p.x,sy-p.y);
      if(err>280){p.x=sx;p.y=sy;p.vx=s.player.vx||0;p.vy=s.player.vy||0;p.f=s.player.facing||0}
      else if(err>2){
        // blend harder when far, almost ignore when close so local feel wins
        const corr=err>80?0.18:err>30?0.08:0.03;
        p.x+=(sx-p.x)*corr;p.y+=(sy-p.y)*corr;
        // gently align velocity too
        p.vx+=( (s.player.vx||0)-p.vx )*corr*0.5;
        p.vy+=( (s.player.vy||0)-p.vy )*corr*0.5;
      }
      if(s.player.facing!=null&&!(imx||imy))p.f+=angDiff(p.f,s.player.facing)*Math.min(1,dt*8);
      p.init=true;
    }
    if(resync){resync=false;for(const e of disp.ents.values())e.init=false;if(disp.player&&s.player){disp.player.x=s.player.x||0;disp.player.y=s.player.y||0;disp.player.vx=s.player.vx||0;disp.player.vy=s.player.vy||0}cam.init=false;trails.clear()}
    const seen=new Set();
    const feed=(arr,kind,idf)=>{
      for(const it of(arr||[])){
        const key=kind+':'+idf(it);seen.add(key);
        let e=disp.ents.get(key);if(!e){e={};disp.ents.set(key,e)}
        const smp=sampleAt(key,performance.now()-interpDelay);
        if(smp)ease(e,smp.x,smp.y,smp.f,kEntSm,500);else ease(e,it.x+(it.vx||0)*ex,it.y+(it.vy||0)*ex,it.facing||0,kEnt,400);
        if(kind==='other'){const em=it.emoji&&it.emoji.id?it.emoji:null; // restart the pop-in when a new emoji appears
          if(em){if(e.emoId!==em.id||e.emoUntil!==em.until){e.emoId=em.id;e.emoUntil=em.until;e.emoAt=performance.now()}}else e.emoId=null}
        e.src=it;e.kind=kind;
      }
    };
    feed(s.npcs,'npc',n=>n.id);
    feed(s.others,'other',o=>o.uid);
    feed(s.wildlife,'wild',w=>w.id);
    for(const key of[...disp.ents.keys()])if(!seen.has(key))disp.ents.delete(key);
    if(disp.player){
      if(!cam.init){cam.x=disp.player.x;cam.y=disp.player.y;cam.init=true}
      else{const kc=1-Math.exp(-dt*20);cam.x+=(disp.player.x-cam.x)*kc;cam.y+=(disp.player.y-cam.y)*kc}
    }
    // boat wake trails (wider, denser, more realistic foam)
    const nowT=performance.now();
    const pushTrail=(key,x,y,vx,vy)=>{
      const spd=Math.hypot(vx||0,vy||0);
      if(spd<8)return;
      let arr=trails.get(key);if(!arr){arr=[];trails.set(key,arr)}
      const last=arr[arr.length-1];
      if(last&&Math.hypot(x-last.x,y-last.y)<6)return;
      arr.push({x,y,t:nowT,spd});
      while(arr.length>TRAIL_MAX||(arr.length&&nowT-arr[0].t>TRAIL_MS))arr.shift();
    };
    if(disp.player)pushTrail('self',disp.player.x,disp.player.y,disp.player.vx,disp.player.vy);
    for(const [key,e] of disp.ents){
      if(e.kind==='npc'||e.kind==='other')pushTrail(key,e.x,e.y,e.src&&e.src.vx,e.src&&e.src.vy);
    }
    for(const [key,arr] of trails){
      while(arr.length&&nowT-arr[0].t>TRAIL_MS)arr.shift();
      if(!arr.length)trails.delete(key);
    }
  }

  // ---------- drawing ----------
  function ellipse(g,x,y,rx,ry,fill){g.fillStyle=fill;g.beginPath();g.ellipse(x,y,rx,ry,0,0,6.283);g.fill()}
  function slab(g,x,y,rx,ry,th,top,side){      // thick island disc: underside + wall + top
    ellipse(g,x,y+th,rx,ry,side);
    g.fillStyle=side;g.fillRect(x-rx,y,rx*2,th);
    ellipse(g,x,y,rx,ry,top);
  }

  function drawBoat(g,m,e,isPlayer){
    const f=e.f||0,cf=Math.cos(f),sf=Math.sin(f),L=BOAT_LEN;
    const pt=(ux,uy,z)=>{                       // boat-local unit coords (+height in world units) -> screen
      const p=P(e.x+(ux*cf-uy*sf)*L,e.y+(ux*sf+uy*cf)*L,m);
      return[p[0],p[1]-(z||0)*m.c*1.2];
    };
    const top=HULL.map(h=>pt(h[0],h[1],0));
    const c0=pt(0,0,0);
    const dz=0.11*L*m.c;                        // hull depth in px
    // soft shadow
    g.globalAlpha=0.25;g.fillStyle='#062030';
    g.beginPath();g.ellipse(c0[0]+1,c0[1]+dz*1.3,L*m.c*0.62,L*m.c*0.24,0,0,6.283);g.fill();g.globalAlpha=1;
    const side=isPlayer?COL.playerDark:COL.boatDark,rim=isPlayer?COL.player:COL.boat,deck=isPlayer?COL.playerDeck:COL.boatDeck;
    // side wall = each hull edge extruded downward, plus the bottom outline
    g.fillStyle=side;g.strokeStyle=side;g.lineWidth=1;g.lineJoin='round';
    g.beginPath();top.forEach((p,i)=>i?g.lineTo(p[0],p[1]+dz):g.moveTo(p[0],p[1]+dz));g.closePath();g.fill();
    for(let i=0;i<top.length;i++){
      const a=top[i],b=top[(i+1)%top.length];
      g.beginPath();g.moveTo(a[0],a[1]);g.lineTo(b[0],b[1]);g.lineTo(b[0],b[1]+dz);g.lineTo(a[0],a[1]+dz);g.closePath();g.fill();g.stroke();
    }
    g.fillStyle=rim;g.beginPath();top.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();g.fill();
    const inner=HULL.map(h=>pt(h[0]*0.78,h[1]*0.68,0));
    g.fillStyle=deck;g.beginPath();inner.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();g.fill();
    // mast, two-tone sail in the vertical plane along the keel, pennant
    const mb=pt(0.02,0,0),mt=pt(0.02,0,L*0.62);
    g.strokeStyle=COL.mast;g.lineWidth=Math.max(1.5,m.c*1.6);g.lineCap='round';
    g.beginPath();g.moveTo(mb[0],mb[1]);g.lineTo(mt[0],mt[1]);g.stroke();
    const s1=pt(-0.2,0,L*0.12),s2=pt(0.3,0,L*0.12),s3=pt(0.02,0,L*0.6),s4=pt(0.2,0,L*0.26);
    g.fillStyle=COL.sail;g.beginPath();g.moveTo(s1[0],s1[1]);g.lineTo(s3[0],s3[1]);g.lineTo(s2[0],s2[1]);g.closePath();g.fill();
    g.fillStyle=COL.sailShade;g.beginPath();g.moveTo(s3[0],s3[1]);g.lineTo(s2[0],s2[1]);g.lineTo(s4[0],s4[1]);g.closePath();g.fill();
    const f1=pt(0.02,0,L*0.62),f2=pt(-0.16,0,L*0.58),f3=pt(0.02,0,L*0.54);
    g.fillStyle=isPlayer?'#ff6b4a':'#4a8cff';g.beginPath();g.moveTo(f1[0],f1[1]);g.lineTo(f2[0],f2[1]);g.lineTo(f3[0],f3[1]);g.closePath();g.fill();
    // bow cannon: carriage + dark barrel pointing straight ahead (+x in boat space), with a bright muzzle ring
    const cb0=pt(0.2,0,L*0.05),cb1=pt(0.38,0,L*0.07),cw=pt(0.2,0.0,L*0.02);
    g.fillStyle='#6b4a28';g.beginPath();g.ellipse(cw[0],cw[1],L*m.c*0.055,L*m.c*0.036,0,0,6.283);g.fill();
    g.strokeStyle='#23272e';g.lineWidth=Math.max(2.4,L*m.c*0.06);g.lineCap='round';g.beginPath();g.moveTo(cb0[0],cb0[1]);g.lineTo(cb1[0],cb1[1]);g.stroke();
    g.strokeStyle='#4a515c';g.lineWidth=Math.max(1,L*m.c*0.022);g.beginPath();g.moveTo(cb0[0],cb0[1]-L*m.c*0.016);g.lineTo(cb1[0],cb1[1]-L*m.c*0.016);g.stroke();
    g.fillStyle='#8c95a1';g.beginPath();g.arc(cb1[0],cb1[1],Math.max(1.3,L*m.c*0.026),0,6.283);g.fill();
    g.lineCap='butt';
    return{x:c0[0],y:c0[1],top:mt[1],muzzle:cb1};
  }

  function mineShape(g,x,y,k,alpha,bright){ // spiky sea mine
    g.save();g.globalAlpha=alpha;
    const body=bright?'#2b3038':'#2f86ab',spike=bright?'#555e69':'#3b97bd',light=bright?'#ff5a3c':'#5bb5d6';
    g.strokeStyle=spike;g.lineWidth=2*k;g.lineCap='round';
    for(let i=0;i<8;i++){const a=i*Math.PI/4;g.beginPath();g.moveTo(x+Math.cos(a)*7*k,y+Math.sin(a)*4.2*k);g.lineTo(x+Math.cos(a)*11.5*k,y+Math.sin(a)*7*k);g.stroke()}
    g.fillStyle=body;g.beginPath();g.ellipse(x,y,8*k,5.4*k,0,0,6.283);g.fill();
    g.fillStyle=light;g.beginPath();g.arc(x,y-1*k,1.8*k,0,6.283);g.fill();
    g.restore()}
  function hpBar(g,x,y,hp,max,col){
    if(hp==null)return;const pct=Math.max(0,Math.min(1,hp/Math.max(1,max||100)));
    g.fillStyle='rgba(0,0,0,.5)';g.fillRect(x-20,y,40,5);g.fillStyle=pct>0.4?(col==='#e5484d'?'#e5a23a':col):'#e5484d';g.fillRect(x-20,y,40*pct,5);
    g.strokeStyle='rgba(255,255,255,.55)';g.lineWidth=1;g.strokeRect(x-20.5,y-0.5,41,6)}
  function label(g,txt,x,y,size,color){
    g.font='bold '+size+'px system-ui';g.textAlign='center';g.textBaseline='alphabetic';
    g.lineWidth=3;g.strokeStyle='rgba(6,32,48,.65)';g.lineJoin='round';g.strokeText(txt,x,y);
    g.fillStyle=color||'#fff';g.fillText(txt,x,y);
  }

  function bubble(g,m,x,y,txt,age,ttl){ // emoji speech bubble above a boat: pops in, bobs, fades out
    const a=Math.min(1,age/160),sc=0.35+0.65*(1+2.70158*Math.pow(a-1,3)+1.70158*Math.pow(a-1,2)); // ease-out-back
    const fade=age>ttl-450?Math.max(0,(ttl-age)/450):1;
    if(fade<=0)return;
    const size=Math.round(26*Math.max(.9,m.A)),r=size*0.82,bob=Math.sin(age/260)*2;
    g.save();g.globalAlpha=fade;g.translate(x,y+bob);g.scale(sc,sc);
    g.fillStyle='rgba(255,255,255,.97)';g.strokeStyle='rgba(39,64,90,.4)';g.lineWidth=2;
    g.beginPath();g.arc(0,-r-6,r,0,6.283);g.fill();g.stroke();
    g.beginPath();g.moveTo(-7,-r*0.25);g.lineTo(0,5);g.lineTo(7,-r*0.25);g.closePath();g.fill();
    g.font=size+'px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillStyle='#000';g.fillText(txt,0,-r-4);
    g.restore();
  }

  function water(g,m,t){
    const grd=g.createRadialGradient(m.ox,m.oy,0,m.ox,m.oy,Math.max(m.w,m.h)*0.85);
    grd.addColorStop(0,COL.lite);grd.addColorStop(0.55,COL.mid);grd.addColorStop(1,COL.deep);
    g.fillStyle=grd;g.fillRect(0,0,m.w,m.h);
    // wave dashes anchored to WORLD coordinates: they slide past as you sail, so motion is
    // visible even over empty water, and they bob with time so the sea is never a still frame.
    const step=qual>=1?140:210,span=Math.min(qual>=1?14:8,Math.ceil(Math.max(m.w,m.h)/(m.c*step))+2);
    const gx=Math.floor(cam.x/step),gy=Math.floor(cam.y/step);
    g.strokeStyle=COL.foam;g.lineWidth=Math.max(1,m.c*1.4);g.lineCap='round';
    for(let i=-span;i<=span;i++)for(let j=-span;j<=span;j++){
      const hsh=Math.sin((gx+i)*12.9898+(gy+j)*78.233)*43758.5453,r=hsh-Math.floor(hsh);
      const p=P((gx+i)*step+r*step*0.8,(gy+j)*step+((r*7.7)%1)*step*0.8,m);
      if(p[0]<-60||p[0]>m.w+60||p[1]<-20||p[1]>m.h+20)continue;
      const bob=Math.sin(t*1.6+r*6.283)*m.c*2,len=m.c*(14+r*14);
      g.globalAlpha=0.3+0.25*Math.sin(t*1.2+r*9);
      g.beginPath();g.moveTo(p[0]-len,p[1]+bob);g.quadraticCurveTo(p[0],p[1]+bob-m.c*4,p[0]+len,p[1]+bob);g.stroke();
    }
    g.globalAlpha=1;g.lineCap='butt';
  }

  function render(canvas,t,dt){
    try{
      const snap=target;if(!canvas||!snap)return;
      const m=metrics(canvas);
      const st=canvas.style;
      st.position='absolute';st.left='0';st.top='0';st.right='0';st.bottom='0';
      st.width='100%';st.height='100%';st.zIndex='1';st.display='block';st.pointerEvents='none';
      const dpr=Math.min(qual>=2?2:qual===1?1.25:1,window.devicePixelRatio||1);
      const bw=Math.max(1,Math.round(m.w*dpr)),bh=Math.max(1,Math.round(m.h*dpr));
      if(canvas.width!==bw||canvas.height!==bh){canvas.width=bw;canvas.height=bh}
      const g=canvas.getContext('2d');if(!g)return;
      g.setTransform(dpr,0,0,dpr,0,0);
      stepEntities(dt);
      g.clearRect(0,0,m.w,m.h);
      water(g,m,t);

      // boat wake trails (behind everything else in the water) — wider layered foam
      {const nowT=performance.now();
        g.lineCap='round';g.lineJoin='round';
        for(const arr of trails.values()){
          if(arr.length<2)continue;
          for(let i=1;i<arr.length;i++){
            const a=arr[i-1],b=arr[i],age=(nowT-b.t)/TRAIL_MS;
            if(age>=1)continue;
            const pa=P(a.x,a.y,m),pb=P(b.x,b.y,m);
            const fade=1-age;
            // outer soft foam
            g.strokeStyle='rgba(220,245,255,'+(0.22*fade).toFixed(3)+')';
            g.lineWidth=Math.max(4,m.c*(14-age*9));
            g.beginPath();g.moveTo(pa[0],pa[1]);g.lineTo(pb[0],pb[1]);g.stroke();
            if(qual<1)continue;
            // inner brighter core
            g.strokeStyle='rgba(255,255,255,'+(0.38*fade).toFixed(3)+')';
            g.lineWidth=Math.max(2,m.c*(7-age*4.5));
            g.beginPath();g.moveTo(pa[0],pa[1]);g.lineTo(pb[0],pb[1]);g.stroke();
          }
        }
        g.lineCap='butt';g.lineJoin='miter'}

      // ground layer: home island + islets as thick iso slabs
      const hp=P(0,0,m),hr=(snap.cfg&&snap.cfg.homeR)||180,[hrx,hry]=ER(hr,m);
      slab(g,hp[0],hp[1],hrx*1.1,hry*1.1,m.c*10,COL.homeSand,COL.homeSandDark);
      slab(g,hp[0],hp[1]-m.c*3,hrx*0.9,hry*0.9,m.c*5,COL.home,COL.homeDark);
      chestScr=null;
      const chestMap=new Map((snap.chests||[]).map(c=>[c.id,c]));
      for(const it of(snap.islets||[])){
        const p=P(it.x,it.y,m),[rx,ry]=ER(it.r||50,m);
        if(p[0]<-rx*2||p[0]>m.w+rx*2||p[1]<-ry*3||p[1]>m.h+ry*3)continue;
        slab(g,p[0],p[1],rx*1.05,ry*1.05,m.c*7,COL.isletSand,COL.isletSandDark);
        slab(g,p[0],p[1]-m.c*2,rx*0.85,ry*0.85,m.c*4,COL.islet,COL.isletDark);
        // every island has a treasure chest: bright when ready, faded while it rests
        const ch=chestMap.get(it.id),ready=!ch||ch.ready;
        g.globalAlpha=ready?1:0.35;g.font=Math.round(24*m.c)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';
        g.fillText('🧰',p[0],p[1]-m.c*8);g.globalAlpha=1;
        if(ch&&ch.inRange&&ch.ready)chestScr={x:p[0],y:p[1]-m.c*26,w:m.w,h:m.h,id:it.id};
      }
      g.textAlign='center';g.textBaseline='middle';
      g.font=Math.round(34*m.c)+'px sans-serif';g.fillStyle='#000';g.fillText('🏝️',hp[0],hp[1]-m.c*14);
      label(g,'HOME',hp[0],hp[1]+hry*0.35,Math.round(13*m.A),'#fff');
      homeScr={x:hp[0],y:hp[1]-m.c*38,w:m.w,h:m.h};

      // racing events: glowing pulsating circle + race flag
      const racing=!!snap.raceProgress;   // while I am racing (incl. the 3-2-1 countdown) the join circle is hidden so only the checkpoints remain
      for(const race of(snap.races||[])){
        if(racing&&snap.raceProgress.raceId!==race.id)continue;
        const rp=P(race.x,race.y,m),[rrx,rry]=ER(race.r||200,m);
        const pulse=0.55+0.45*Math.sin(t*3.2);
        g.save();
        if(!racing){
        g.strokeStyle='rgba(255,210,60,'+(0.35+0.4*pulse).toFixed(3)+')';
        g.lineWidth=Math.max(3,m.c*4);
        g.setLineDash([m.c*12,m.c*8]);
        g.beginPath();g.ellipse(rp[0],rp[1],rrx,rry,0,0,6.283);g.stroke();
        g.setLineDash([]);
        // inner glow ring
        g.strokeStyle='rgba(255,255,255,'+(0.15+0.25*pulse).toFixed(3)+')';
        g.lineWidth=Math.max(2,m.c*2);
        g.beginPath();g.ellipse(rp[0],rp[1],rrx*0.92,rry*0.92,0,0,6.283);g.stroke();
        // soft fill
        g.fillStyle='rgba(255,200,40,'+(0.06+0.05*pulse).toFixed(3)+')';
        g.beginPath();g.ellipse(rp[0],rp[1],rrx,rry,0,0,6.283);g.fill();
        // race flag in center
        g.font=Math.round(36*m.c)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';
        g.globalAlpha=0.9;g.fillText('🏁',rp[0],rp[1]-m.c*6);g.globalAlpha=1;
        label(g,race.name||'RACE',rp[0],rp[1]+m.c*18,Math.round(12*m.A),'#ffe9a0');
        }
        // checkpoints for active race
        const prog=snap.raceProgress;
        if(prog&&prog.raceId===race.id){
          (race.checkpoints||[]).forEach((cp,i)=>{
            const cpP=P(cp.x,cp.y,m),[cx,cy]=ER(cp.r||60,m);
            const done=i<prog.nextCp,next=i===prog.nextCp;
            g.strokeStyle=done?'rgba(80,220,120,.55)':(next?'rgba(255,220,60,.9)':'rgba(255,255,255,.25)');
            g.lineWidth=next?Math.max(2.5,m.c*2.5):Math.max(1.5,m.c*1.5);
            g.beginPath();g.ellipse(cpP[0],cpP[1],cx,cy,0,0,6.283);g.stroke();
            g.textAlign='center';g.textBaseline='middle';
            if(next){g.font=Math.round(18*m.c)+'px sans-serif';g.fillText(cp.finish?'🏁':String(i+1),cpP[0],cpP[1])}
          });
        }
        g.restore();
      }

      // entities, painter-sorted back to front (iso depth = x+y)
      const list=[],bubbles=[],nowMs=performance.now(),fs=Math.round(12*Math.max(.9,m.A));
      for(const tr of(snap.treasures||[]))list.push({d:tr.x+tr.y,f:()=>{
        const p=P(tr.x,tr.y,m);g.font=Math.round(24*m.c)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';
        g.fillText(tr.kind==='chest'?'💎':'📦',p[0],p[1]+Math.sin(t*2+tr.x)*m.c*2)}});
      for(const wk of(snap.wrecks||[]))list.push({d:wk.x+wk.y,f:()=>{
        // time left comes from the server as a relative value, so it never depends on the phone's clock
        const life=(wk.left!=null?wk.left:10000)-(nowMs-lastStateAt);
        if(life<=0)return;
        const fade=life<1500?Math.max(0,life/1500):1;
        const p=P(wk.x,wk.y,m);
        g.globalAlpha=0.85*fade;g.font=Math.round(28*m.c)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';
        g.fillText('💀',p[0],p[1]);
        g.font=Math.round(16*m.c)+'px sans-serif';
        if(wk.gems||(wk.loot&&wk.gold==null))g.fillText('💎',p[0]+12*m.c,p[1]-14*m.c);
        if(wk.gold)g.fillText('🪙',p[0]-12*m.c,p[1]-14*m.c);
        g.globalAlpha=1}});
      for(const e of disp.ents.values()){
        const src=e.src;
        if(e.kind==='wild')list.push({d:e.x+e.y,f:()=>{
          const p=P(e.x,e.y,m);g.font=Math.round(26*m.c)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';
          g.fillText(src.kind==='croc'?'🐊':'🐦',p[0],p[1])}});
        else if(e.kind==='npc')list.push({d:e.x+e.y,f:()=>{const r=drawBoat(g,m,e,false);hpBar(g,r.x,r.top-8,src.hp,src.maxHp,'#e5484d')}});
        else list.push({d:e.x+e.y,f:()=>{
          const r=drawBoat(g,m,e,false);
          const mate=!!src.team;
          hpBar(g,r.x,r.top-10,src.hp,src.maxHp,mate?'#5fcf70':'#e5484d');
          label(g,src.name||'Sailor',r.x,r.top-16,fs,mate?'#b9ffc6':'#fff');
          if(mate){g.fillStyle='#2fd25b';g.strokeStyle='#0a5a22';g.lineWidth=1.5;g.beginPath();g.arc(r.x,r.top-16-fs-4,4.2,0,6.283);g.fill();g.stroke()} // green dot above a teammate's name
          if(e.emoId)bubbles.push({x:r.x,y:r.top-24,id:e.emoId,age:nowMs-(e.emoAt||nowMs),ttl:2500})}});
      }
      if(disp.player&&snap.player)list.push({d:disp.player.x+disp.player.y+0.01,f:()=>{
        if(aiming){ // cannon guide: faint white line straight ahead of the bow, same thickness as the cannon, shorter than the range
          const f=disp.player.f||0,cf=Math.cos(f),sf=Math.sin(f),R0=BOAT_LEN*0.38,R1=Math.min(340,((snap.cfg&&snap.cfg.cannonRange)||430)*0.78);
          const a=P(disp.player.x+cf*R0,disp.player.y+sf*R0,m),b=P(disp.player.x+cf*R1,disp.player.y+sf*R1,m);
          g.strokeStyle='rgba(255,255,255,.3)';g.lineWidth=Math.max(2.4,BOAT_LEN*m.c*0.06);g.lineCap='round';g.beginPath();g.moveTo(a[0],a[1]);g.lineTo(b[0],b[1]);g.stroke();g.lineCap='butt'}
        const r=drawBoat(g,m,disp.player,true);
        label(g,'YOU',r.x,r.top-14,fs,'#ffe9a0');
        if(fxPulse&&r.muzzle){const pa=(nowMs-fxPulse)/260;if(pa<1){ // muzzle flash + smoke puff at the cannon
          const[mx,my]=r.muzzle,k=m.c;g.globalAlpha=1-pa;g.fillStyle='#ffd34d';g.beginPath();g.arc(mx,my,(5+14*pa)*k,0,6.283);g.fill();
          g.fillStyle='#fff6c8';g.beginPath();g.arc(mx,my,(3+6*pa)*k,0,6.283);g.fill();
          g.globalAlpha=0.55*(1-pa);g.fillStyle='#cfd6de';g.beginPath();g.arc(mx+pa*10*k,my-pa*14*k,(7+16*pa)*k,0,6.283);g.fill();g.globalAlpha=1}}
        if(selfEmo){const age=nowMs-selfEmo.at;if(age<selfEmo.ttl)bubbles.push({x:r.x,y:r.top-44,id:selfEmo.id,age,ttl:selfEmo.ttl});else selfEmo=null}
        const pct=Math.max(0,Math.min(1,(snap.player.hp||100)/Math.max(1,snap.player.maxHp||100)));
        g.fillStyle='rgba(0,0,0,.45)';g.fillRect(r.x-22,r.top-10,44,5);
        g.fillStyle=pct>0.4?'#5fcf70':'#e5484d';g.fillRect(r.x-22,r.top-10,44*pct,5)}});
      for(const mp of(snap.minePacks||[]))list.push({d:mp.x+mp.y,f:()=>{ // mine pick-ups: a floating mine with a glowing ring
        const p=P(mp.x,mp.y,m),k=m.c,bob=Math.sin(t*2.2+mp.x)*2*k;
        g.globalAlpha=0.35+0.2*Math.sin(t*3+mp.y);g.strokeStyle='#ffd34d';g.lineWidth=2*k;const[rx,ry]=ER(22,m);g.beginPath();g.ellipse(p[0],p[1],rx,ry,0,0,6.283);g.stroke();g.globalAlpha=1;
        mineShape(g,p[0],p[1]-6*k+bob,k,1,true)}});
      for(const mn of(snap.mines||[]))list.push({d:mn.x+mn.y,f:()=>{ // dropped mines are sea-coloured: easy to miss, which is the point
        const p=P(mn.x,mn.y,m),k=m.c,age=mn.age+(nowMs-lastStateAt),fresh=Math.max(0,1-age/1400);
        const left=30000-age;if(left<=0)return;
        const blink=left<4000?(Math.sin(age/90)>0?0.2:0):0;
        mineShape(g,p[0],p[1]+Math.sin(t*1.6+mn.x)*1.2*k,k,Math.min(1,(mn.mine?0.5:0.34)+fresh*0.6+blink),false)}});
      const age0=(nowMs-lastStateAt)/1000;
      for(const sh of(snap.shots||[]))list.push({d:sh.x+sh.y+(sh.vx+sh.vy)*age0+0.5,f:()=>{ // cannonballs fly in a straight line: extrapolate between snapshots
        const x=sh.x+sh.vx*age0,y=sh.y+sh.vy*age0,p=P(x,y,m),k=m.c,lift=14*k;
        g.fillStyle='rgba(6,32,48,.28)';g.beginPath();g.ellipse(p[0],p[1],5*k,2.4*k,0,0,6.283);g.fill();     // shadow on the water
        for(let i=3;i>=1;i--){const q=P(x-sh.vx*0.012*i,y-sh.vy*0.012*i,m);g.globalAlpha=0.16*(4-i);g.fillStyle='#eef2f6';g.beginPath();g.arc(q[0],q[1]-lift,(4.2-i*0.6)*k,0,6.283);g.fill()}
        g.globalAlpha=1;g.fillStyle=sh.npc?'#5a2a2a':'#20242b';g.beginPath();g.arc(p[0],p[1]-lift,4.8*k,0,6.283);g.fill();
        g.fillStyle='rgba(255,255,255,.55)';g.beginPath();g.arc(p[0]-1.4*k,p[1]-lift-1.6*k,1.5*k,0,6.283);g.fill()}});
      for(const f of(snap.fx||[])){const a=(f.age+(nowMs-lastStateAt))/900;if(a>=1)continue;list.push({d:f.x+f.y+2,f:()=>{
        const p=P(f.x,f.y,m),k=m.c;g.globalAlpha=1-a;
        if(f.k==='boom'){const r0=(14+70*a)*k;g.fillStyle='#ff8a1f';g.beginPath();g.ellipse(p[0],p[1]-10*k,r0,r0*0.7,0,0,6.283);g.fill();g.fillStyle='#fff1b0';g.beginPath();g.ellipse(p[0],p[1]-10*k,r0*0.55,r0*0.38,0,0,6.283);g.fill();g.strokeStyle='rgba(255,255,255,.8)';g.lineWidth=3*k*(1-a);const[bx,by]=ER(20+90*a,m);g.beginPath();g.ellipse(p[0],p[1],bx,by,0,0,6.283);g.stroke()}
        else if(f.k==='hit'){g.fillStyle='#ffb02e';g.beginPath();g.arc(p[0],p[1]-12*k,(8+26*a)*k,0,6.283);g.fill();g.fillStyle='#fff3b0';g.beginPath();g.arc(p[0],p[1]-12*k,(4+12*a)*k,0,6.283);g.fill();
          g.strokeStyle='#6b4a28';g.lineWidth=2*k;for(let i=0;i<6;i++){const an=i*1.05+0.4,r0=(10+30*a)*k;g.beginPath();g.moveTo(p[0]+Math.cos(an)*r0*0.6,p[1]-12*k+Math.sin(an)*r0*0.4);g.lineTo(p[0]+Math.cos(an)*r0,p[1]-12*k+Math.sin(an)*r0*0.6);g.stroke()}} // flying splinters
        else{g.strokeStyle='#ffffff';g.lineWidth=2.4*k*(1-a);const[rx,ry]=ER(12+40*a,m);g.beginPath();g.ellipse(p[0],p[1],rx,ry,0,0,6.283);g.stroke()}
        g.globalAlpha=1}})}
      list.sort((a,b)=>a.d-b.d);
      for(const it of list)it.f();
      for(const b of bubbles)bubble(g,m,b.x,b.y,b.id,b.age,b.ttl);          // bubbles above every boat
      popups=popups.filter(pp=>nowMs-pp.t0<1000);                           // floating pickup texts
      for(const pp of popups){const a=(nowMs-pp.t0)/1000,p=P(pp.x,pp.y,m);
        g.globalAlpha=1-a*a;label(g,pp.txt,p[0],p[1]-30*m.c-a*46,Math.round(17*Math.max(.9,m.A)),'#fff3b0');g.globalAlpha=1}

      // ---- edge pointers: ⚓ toward the home island, 🏁 toward nearby race circles (or the next checkpoint while racing) ----
      // Off-screen targets get a light marker on a ray from the screen centre. The distance label sits well clear of the
      // emoji (no overlap) and is a plain number (no unit).
      if(snap.player&&disp.player){
        const placed=[];
        const pointer=(tx,ty,kind,wdist,txt)=>{
          if(tx>40&&tx<m.w-40&&ty>40&&ty<m.h-40)return;               // target already visible: no pointer needed
          const ang=Math.atan2(ty-m.oy,tx-m.ox);
          let edge=Math.min(m.w,m.h)*0.36;
          for(const q of placed){let d=Math.abs(angDiff(ang,q));if(d<0.42){edge*=0.72;break}} // two markers in the same direction: stagger them
          placed.push(ang);
          const ix=m.ox+Math.cos(ang)*edge,iy=m.oy+Math.sin(ang)*edge,fs2=Math.round(30*Math.max(0.9,m.A)),gap=fs2*0.5+24;
          g.save();g.textAlign='center';g.textBaseline='middle';g.font=fs2+'px sans-serif';
          if(kind==='home'){
            g.translate(ix,iy);g.rotate(ang-Math.PI/2);       // flukes (bottom of the glyph) point toward home
            g.globalAlpha=0.55;g.fillText('⚓',0,0);
          }else if(kind==='mate'){                              // teammate: boat with a green dot and a green arrow, no distance
            g.globalAlpha=0.9;g.fillText('⛵',ix,iy);
            g.fillStyle='#2fd25b';g.strokeStyle='#0a5a22';g.lineWidth=1.5;g.beginPath();g.arc(ix+fs2*0.38,iy-fs2*0.4,5,0,6.283);g.fill();g.stroke();
            const ax=ix+Math.cos(ang)*(fs2*0.5+9),ay=iy+Math.sin(ang)*(fs2*0.5+9),sz=7;
            g.translate(ax,ay);g.rotate(ang);g.fillStyle='rgba(60,225,110,.95)';
            g.beginPath();g.moveTo(sz,0);g.lineTo(-sz*0.6,-sz*0.8);g.lineTo(-sz*0.6,sz*0.8);g.closePath();g.fill();
          }else{
            g.globalAlpha=0.7;g.fillText('🏁',ix,iy);
            const ax=ix+Math.cos(ang)*(fs2*0.5+9),ay=iy+Math.sin(ang)*(fs2*0.5+9),sz=7; // small arrow head toward the race
            g.translate(ax,ay);g.rotate(ang);g.fillStyle='rgba(255,226,120,.9)';
            g.beginPath();g.moveTo(sz,0);g.lineTo(-sz*0.6,-sz*0.8);g.lineTo(-sz*0.6,sz*0.8);g.closePath();g.fill();
          }
          g.restore();
          if(kind==='mate')return;
          // label on the side away from the arrow tip for 🏁 (inward), beyond the flukes for ⚓ (outward) - always clear of the glyph
          const dir=kind==='home'?1:-1,lx=ix+Math.cos(ang)*gap*dir,ly=iy+Math.sin(ang)*gap*dir;
          g.globalAlpha=0.8;label(g,String(Math.round(wdist)),lx,ly,Math.round(12*Math.max(0.9,m.A)),kind==='home'?'#e8f6ff':'#ffe9a0');g.globalAlpha=1;
        };
        if(!snap.nearHome)pointer(hp[0],hp[1],'home',Math.hypot(disp.player.x,disp.player.y),'');
        for(const o of(snap.others||[])){            // a pointer to every teammate who is off-screen (no distance number)
          if(!o.team)continue;const en=disp.ents.get('other:'+o.uid);if(!en)continue;
          const q=P(en.x,en.y,m);pointer(q[0],q[1],'mate',0,'')}
        const prog=snap.raceProgress;
        if(prog){
          const race=(snap.races||[]).find(r=>r.id===prog.raceId),cp=race&&(race.checkpoints||[])[prog.nextCp];
          if(cp){const cpP=P(cp.x,cp.y,m);pointer(cpP[0],cpP[1],'race',Math.hypot(cp.x-disp.player.x,cp.y-disp.player.y),'')}
        }else{
          for(const race of(snap.races||[])){const rp=P(race.x,race.y,m);pointer(rp[0],rp[1],'race',Math.hypot(race.x-disp.player.x,race.y-disp.player.y),'')}
        }
      }
    }catch(e){try{console.error('[SeaView]',e)}catch(x){}}
  }

  // ---------- render loop: independent of the network ----------
  function start(canvas,cb){
    stop();canvasRef=canvas;onFrame=cb||null;lastT=0;
    const loop=ts=>{
      raf=requestAnimationFrame(loop);
      const raw=lastT?(ts-lastT):16.7,dt=lastT?Math.min(0.1,raw/1000):0.016;lastT=ts;
      if(raw>300)resync=true;                       // the device hung (tab switch, GC, slow load): jump to the current picture
      else{                                         // adaptive quality from the smoothed frame time
        ftEma+=(Math.min(raw,100)-ftEma)*0.08;
        if(ftEma>30){qualBad+=raw;qualGood=0;if(qualBad>1500&&qual>0){qual--;qualBad=0;ftEma=22}}
        else if(ftEma<19){qualGood+=raw;qualBad=0;if(qualGood>8000&&qual<2){qual++;qualGood=0}}
        else{qualBad=0;qualGood=0}
      }
      render(canvasRef,ts/1000,dt);
      if(onFrame){try{onFrame(dt)}catch(e){}}
    };
    raf=requestAnimationFrame(loop);
  }
  function stop(){if(raf)cancelAnimationFrame(raf);raf=0;canvasRef=null;onFrame=null}
  function draw(canvas,snap){if(snap)setState(snap);if(!raf)render(canvas,performance.now()/1000,0.016)}

  // ---------- input (screen-relative: W = up the screen) ----------
  function bindKeys(onChange){
    const fire=()=>{
      let sx=0,sy=0;
      if(_keys.w||_keys.arrowup)sy-=1;
      if(_keys.s||_keys.arrowdown)sy+=1;
      if(_keys.a||_keys.arrowleft)sx-=1;
      if(_keys.d||_keys.arrowright)sx+=1;
      if(!sx&&!sy)return onChange(0,0);
      const d=dirToWorld(sx,sy);onChange(d.mx,d.my);
    };
    const MOVE=['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'];
    window.addEventListener('keydown',e=>{
      const k=e.key.toLowerCase();
      const t=e.target,typing=t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable);
      if(typing)return; // never steal keystrokes (W A S D ...) from a text field
      if(MOVE.includes(k)){if(!_keys[k]){_keys[k]=true;fire()}e.preventDefault()}
    });
    window.addEventListener('keyup',e=>{const k=e.key.toLowerCase();if(MOVE.includes(k)){_keys[k]=false;fire()}});
    window.addEventListener('blur',()=>{_keys={};fire()});
  }

  window.SeaView={draw,start,stop,setState,reset,stateAge,bindKeys,metrics,dirToWorld,showSelfEmoji,clearSelfEmoji,pulse,popup,getHome,getChest,setAim,setLocalIntent,setLocalSpeed};
})();
