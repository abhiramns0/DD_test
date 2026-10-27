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
  let fxPulse=0;                          // performance.now() of the last attack pulse
  let popups=[];                          // floating '+1 💎' texts: {x,y,txt,t0}
  let homeScr=null;                       // where the home island is on screen right now (for the floating DOCK button)

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

  // ---------- state intake ----------
  function setState(snap){
    if(!snap)return;
    // slim pushes leave out the static world: keep the last copy
    if(target){if(!snap.islets&&target.islets)snap.islets=target.islets;if(!snap.cfg&&target.cfg)snap.cfg=target.cfg;if(!snap.mp&&target.mp)snap.mp=target.mp}
    target=snap;lastStateAt=performance.now()}
  function reset(){target=null;disp={player:null,ents:new Map()};cam.init=false;lastStateAt=0;selfEmo=null;fxPulse=0;popups=[];homeScr=null}
  function showSelfEmoji(id,ttl){selfEmo={id,at:performance.now(),ttl:ttl||2500}}
  function clearSelfEmoji(){selfEmo=null}
  function pulse(){fxPulse=performance.now()}
  function popup(txt){const p=disp.player||(target&&target.player);if(!p)return;popups.push({x:p.x,y:p.y,txt,t0:performance.now()});if(popups.length>8)popups.shift()}
  function getHome(){return homeScr}
  function stateAge(){return lastStateAt?performance.now()-lastStateAt:Infinity}

  function stepEntities(dt){
    const s=target;if(!s)return;
    const k=1-Math.exp(-dt*14);
    const ex=Math.min(0.25,Math.max(0,(performance.now()-lastStateAt)/1000)); // seconds since this snapshot arrived
    if(s.player){
      if(!disp.player)disp.player={};
      ease(disp.player,(s.player.x||0)+(s.player.vx||0)*ex,(s.player.y||0)+(s.player.vy||0)*ex,s.player.facing||0,k,400);
    }
    const seen=new Set();
    const feed=(arr,kind,idf)=>{
      for(const it of(arr||[])){
        const key=kind+':'+idf(it);seen.add(key);
        let e=disp.ents.get(key);if(!e){e={};disp.ents.set(key,e)}
        ease(e,it.x+(it.vx||0)*ex,it.y+(it.vy||0)*ex,it.facing||0,k,400);
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
    g.lineCap='butt';
    return{x:c0[0],y:c0[1],top:mt[1]};
  }

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
    const step=140,span=Math.min(14,Math.ceil(Math.max(m.w,m.h)/(m.c*step))+2);
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
      const dpr=Math.min(2,window.devicePixelRatio||1);
      const bw=Math.max(1,Math.round(m.w*dpr)),bh=Math.max(1,Math.round(m.h*dpr));
      if(canvas.width!==bw||canvas.height!==bh){canvas.width=bw;canvas.height=bh}
      const g=canvas.getContext('2d');if(!g)return;
      g.setTransform(dpr,0,0,dpr,0,0);
      stepEntities(dt);
      g.clearRect(0,0,m.w,m.h);
      water(g,m,t);

      // ground layer: home island + islets as thick iso slabs
      const hp=P(0,0,m),hr=(snap.cfg&&snap.cfg.homeR)||180,[hrx,hry]=ER(hr,m);
      slab(g,hp[0],hp[1],hrx*1.1,hry*1.1,m.c*10,COL.homeSand,COL.homeSandDark);
      slab(g,hp[0],hp[1]-m.c*3,hrx*0.9,hry*0.9,m.c*5,COL.home,COL.homeDark);
      for(const it of(snap.islets||[])){
        const p=P(it.x,it.y,m),[rx,ry]=ER(it.r||50,m);
        if(p[0]<-rx*2||p[0]>m.w+rx*2||p[1]<-ry*3||p[1]>m.h+ry*3)continue;
        slab(g,p[0],p[1],rx*1.05,ry*1.05,m.c*7,COL.isletSand,COL.isletSandDark);
        slab(g,p[0],p[1]-m.c*2,rx*0.85,ry*0.85,m.c*4,COL.islet,COL.isletDark);
      }
      g.textAlign='center';g.textBaseline='middle';
      g.font=Math.round(34*m.c)+'px sans-serif';g.fillStyle='#000';g.fillText('🏝️',hp[0],hp[1]-m.c*14);
      label(g,'HOME',hp[0],hp[1]+hry*0.35,Math.round(13*m.A),'#fff');
      homeScr={x:hp[0],y:hp[1]-m.c*38,w:m.w,h:m.h};

      // entities, painter-sorted back to front (iso depth = x+y)
      const list=[],bubbles=[],nowMs=performance.now(),fs=Math.round(12*Math.max(.9,m.A));
      for(const tr of(snap.treasures||[]))list.push({d:tr.x+tr.y,f:()=>{
        const p=P(tr.x,tr.y,m);g.font=Math.round(24*m.c)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';
        g.fillText(tr.kind==='chest'?'💎':'📦',p[0],p[1]+Math.sin(t*2+tr.x)*m.c*2)}});
      for(const e of disp.ents.values()){
        const src=e.src;
        if(e.kind==='wild')list.push({d:e.x+e.y,f:()=>{
          const p=P(e.x,e.y,m);g.font=Math.round(26*m.c)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';
          g.fillText(src.kind==='croc'?'🐊':'🐦',p[0],p[1])}});
        else if(e.kind==='npc')list.push({d:e.x+e.y,f:()=>{drawBoat(g,m,e,false)}});
        else list.push({d:e.x+e.y,f:()=>{
          const r=drawBoat(g,m,e,false);
          label(g,src.name||'Sailor',r.x,r.top-8,fs,'#fff');
          if(e.emoId)bubbles.push({x:r.x,y:r.top-24,id:e.emoId,age:nowMs-(e.emoAt||nowMs),ttl:2500})}});
      }
      if(disp.player&&snap.player)list.push({d:disp.player.x+disp.player.y+0.01,f:()=>{
        const r=drawBoat(g,m,disp.player,true);
        label(g,'YOU',r.x,r.top-14,fs,'#ffe9a0');
        if(fxPulse){const pa=(nowMs-fxPulse)/280;if(pa<1){const rr=((snap.cfg&&snap.cfg.attackRange)||70)*pa,[prx,pry]=ER(rr,m);
          g.strokeStyle='rgba(255,255,255,'+(0.85*(1-pa)).toFixed(2)+')';g.lineWidth=Math.max(2,m.c*3*(1-pa));g.beginPath();g.ellipse(r.x,r.y,prx,pry,0,0,6.283);g.stroke()}}
        if(selfEmo){const age=nowMs-selfEmo.at;if(age<selfEmo.ttl)bubbles.push({x:r.x,y:r.top-44,id:selfEmo.id,age,ttl:selfEmo.ttl});else selfEmo=null}
        const pct=Math.max(0,Math.min(1,(snap.player.hp||100)/Math.max(1,snap.player.maxHp||100)));
        g.fillStyle='rgba(0,0,0,.45)';g.fillRect(r.x-22,r.top-10,44,5);
        g.fillStyle=pct>0.4?'#5fcf70':'#e5484d';g.fillRect(r.x-22,r.top-10,44*pct,5)}});
      list.sort((a,b)=>a.d-b.d);
      for(const it of list)it.f();
      for(const b of bubbles)bubble(g,m,b.x,b.y,b.id,b.age,b.ttl);          // bubbles above every boat
      popups=popups.filter(pp=>nowMs-pp.t0<1000);                           // floating pickup texts
      for(const pp of popups){const a=(nowMs-pp.t0)/1000,p=P(pp.x,pp.y,m);
        g.globalAlpha=1-a*a;label(g,pp.txt,p[0],p[1]-30*m.c-a*46,Math.round(17*Math.max(.9,m.A)),'#fff3b0');g.globalAlpha=1}

      // arrow pointing home when it is off screen
      if(snap.player&&!snap.nearHome&&disp.player){
        const dist=Math.hypot(disp.player.x,disp.player.y)||1;
        const ang=Math.atan2(hp[1]-m.oy,hp[0]-m.ox);
        const onScreen=hp[0]>40&&hp[0]<m.w-40&&hp[1]>40&&hp[1]<m.h-40;
        if(!onScreen){
          const edge=Math.min(m.w,m.h)*0.36,ix=m.ox+Math.cos(ang)*edge,iy=m.oy+Math.sin(ang)*edge;
          g.save();g.translate(ix,iy);g.rotate(ang);g.fillStyle='rgba(255,255,255,.7)';
          g.beginPath();g.moveTo(16,0);g.lineTo(-10,-11);g.lineTo(-10,11);g.closePath();g.fill();g.restore();
          label(g,'HOME '+Math.round(dist),ix,iy+26,11,'#fff');
        }
      }
    }catch(e){try{console.error('[SeaView]',e)}catch(x){}}
  }

  // ---------- render loop: independent of the network ----------
  function start(canvas,cb){
    stop();canvasRef=canvas;onFrame=cb||null;lastT=0;
    const loop=ts=>{
      raf=requestAnimationFrame(loop);
      const dt=lastT?Math.min(0.1,(ts-lastT)/1000):0.016;lastT=ts;
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
      if(MOVE.includes(k)){if(!_keys[k]){_keys[k]=true;fire()}e.preventDefault()}
    });
    window.addEventListener('keyup',e=>{const k=e.key.toLowerCase();if(MOVE.includes(k)){_keys[k]=false;fire()}});
    window.addEventListener('blur',()=>{_keys={};fire()});
  }

  window.SeaView={draw,start,stop,setState,reset,stateAge,bindKeys,metrics,dirToWorld,showSelfEmoji,clearSelfEmoji,pulse,popup,getHome};
})();
