'use strict';
// Open Sea RENDERER. Draws the snapshot from sea.js > view(). No rules, no networking.
(function(){
  const COL={
    deep:'#1a6a8a',mid:'#2a8ab0',lite:'#4eb3d4',foam:'#c8eef8',
    home:'#7ccf6e',homeSand:'#f2dfa5',islet:'#6aba5c',isletSand:'#e8d9a0',
    boat:'#c89a62',boatDark:'#8a6236',player:'#ffd34d',
    wreck:'#5a4a3a',chest:'#e0b070',crate:'#b8895a',ink:'#27405a'
  };

  let cam={x:0,y:0}, _canvas=null, _drag=null, _keys={};

  function metrics(canvas){
    const r=canvas.getBoundingClientRect();
    const A=Math.min(r.width,r.height)/900;
    return{A,ox:r.width/2,oy:r.height/2,w:r.width,h:r.height}}

  function S(x,y,m,c){
    return[m.ox+(x-c.x)*m.A, m.oy+(y-c.y)*m.A]}

  function draw(canvas,snap,opts){
    opts=opts||{};
    if(!canvas||!snap)return;
    _canvas=canvas;
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const r=canvas.getBoundingClientRect();
    if(!r.width||!r.height)return;
    if(canvas.width!==Math.round(r.width*dpr)||canvas.height!==Math.round(r.height*dpr)){
      canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr)}
    const g=canvas.getContext('2d'),m=metrics(canvas);
    g.setTransform(dpr,0,0,dpr,0,0);
    g.clearRect(0,0,m.w,m.h);

    // Camera follows player
    if(snap.player){cam.x=snap.player.x;cam.y=snap.player.y}

    // Ocean
    const grd=g.createRadialGradient(m.ox,m.oy,0,m.ox,m.oy,Math.max(m.w,m.h)*0.7);
    grd.addColorStop(0,COL.lite);grd.addColorStop(0.55,COL.mid);grd.addColorStop(1,COL.deep);
    g.fillStyle=grd;g.fillRect(0,0,m.w,m.h);

    // Soft wave rings
    const t=performance.now();
    g.globalAlpha=0.18;
    for(let i=0;i<5;i++){
      const k=((t/4000+i/5)%1);
      g.strokeStyle=COL.foam;g.lineWidth=2;
      const[cx,cy]=S(cam.x,cam.y,m,cam);
      g.beginPath();g.ellipse(cx,cy,(180+k*420)*m.A,(90+k*210)*m.A,0,0,6.283);g.stroke()}
    g.globalAlpha=1;

    // World boundary ring
    if(snap.cfg){
      const[bx,by]=S(0,0,m,cam);
      g.strokeStyle='rgba(255,255,255,.2)';g.lineWidth=2;g.setLineDash([12,10]);
      g.beginPath();g.arc(bx,by,snap.cfg.worldR*m.A,0,6.283);g.stroke();g.setLineDash([])}

    // Home island
    {
      const[hx,hy]=S(0,0,m,cam);
      const hr=(snap.cfg&&snap.cfg.homeR||180)*m.A;
      g.fillStyle=COL.homeSand;
      g.beginPath();g.ellipse(hx,hy,hr*1.05,hr*0.72,0,0,6.283);g.fill();
      g.fillStyle=COL.home;
      g.beginPath();g.ellipse(hx,hy,hr*0.88,hr*0.6,0,0,6.283);g.fill();
      g.fillStyle=COL.ink;g.font=Math.round(14*Math.max(0.8,m.A*1.2))+'px system-ui';
      g.textAlign='center';g.textBaseline='middle';g.fillText('🏠 HOME',hx,hy);
      if(snap.nearHome){
        g.strokeStyle='#ffd34d';g.lineWidth=3;g.globalAlpha=0.7+0.3*Math.sin(t/200);
        g.beginPath();g.ellipse(hx,hy,hr*1.2,hr*0.82,0,0,6.283);g.stroke();g.globalAlpha=1}
    }

    // Islets
    for(const it of(snap.islets||[])){
      const[x,y]=S(it.x,it.y,m,cam);
      const r=it.r*m.A;
      g.fillStyle=COL.isletSand;g.beginPath();g.ellipse(x,y,r*1.1,r*0.75,0,0,6.283);g.fill();
      g.fillStyle=it.explored?COL.islet:'#5a9e4e';
      g.beginPath();g.ellipse(x,y,r*0.9,r*0.62,0,0,6.283);g.fill();
      g.font=Math.round(11*Math.max(0.8,m.A))+'px system-ui';g.fillStyle=COL.ink;
      g.textAlign='center';g.fillText(it.explored?'✓ '+it.name:it.name,x,y+r*0.9+10)}

    // Treasures
    for(const tr of(snap.treasures||[])){
      const[x,y]=S(tr.x,tr.y,m,cam);
      g.font=Math.round(18*Math.max(0.85,m.A))+'px sans-serif';
      g.textAlign='center';g.textBaseline='middle';
      g.fillText(tr.kind==='chest'?'💎':'📦',x,y)}

    // Wrecks
    for(const w of(snap.wrecks||[])){
      const[x,y]=S(w.x,w.y,m,cam);
      g.fillStyle=COL.wreck;g.globalAlpha=0.7;
      g.beginPath();g.ellipse(x,y,14*m.A,8*m.A,0,0,6.283);g.fill();
      g.globalAlpha=1;
      if(w.loot>0){g.font=Math.round(12*m.A)+'px sans-serif';g.fillText('✨',x,y-12*m.A)}}

    // Wildlife
    for(const w of(snap.wildlife||[])){
      const[x,y]=S(w.x,w.y,m,cam);
      g.font=Math.round(16*Math.max(0.85,m.A))+'px sans-serif';
      g.textAlign='center';g.textBaseline='middle';
      g.fillText(w.kind==='croc'?'🐊':'🐦',x,y)}

    // NPC boats
    for(const n of(snap.npcs||[])){
      drawBoat(g,S(n.x,n.y,m,cam),n.facing,m.A,COL.boat,false)}

        // Other human vessels (multiplayer)
    for(const o of(snap.others||[])){
      drawDetailedBoat(g,S(o.x,o.y,m,cam),o.facing,m.A*0.95,false);
      const[ox,oy]=S(o.x,o.y,m,cam);
      // name plate
      g.font='bold '+Math.round(11*Math.max(0.85,m.A))+'px system-ui';
      g.textAlign='center';g.textBaseline='bottom';
      g.fillStyle='rgba(39,64,90,.75)';
      const label=o.name||'Sailor';
      const tw=g.measureText(label).width+10;
      g.fillRect(ox-tw/2,oy-52*m.A,tw,16);
      g.fillStyle='#fff';g.fillText(label,ox,oy-38*m.A);
      // hp
      const pct=(o.hp||0)/Math.max(1,o.maxHp||100);
      g.fillStyle='rgba(0,0,0,.35)';g.fillRect(ox-22*m.A,oy-34*m.A,44*m.A,5*m.A);
      g.fillStyle=pct>0.4?'#5fcf70':'#e5484d';g.fillRect(ox-22*m.A,oy-34*m.A,44*m.A*pct,5*m.A);
      // emoji bubble
      if(o.emoji&&o.emoji.id){
        g.font=Math.round(22*Math.max(0.9,m.A))+'px sans-serif';
        g.textAlign='center';g.textBaseline='middle';
        g.fillText(o.emoji.id,ox,oy-68*m.A);
      }
    }

    // Player vessel
    if(snap.player&&snap.player.alive){
      drawBoat(g,S(snap.player.x,snap.player.y,m,cam),snap.player.facing,m.A,COL.player,true);
      // HP bar
      const[px,py]=S(snap.player.x,snap.player.y,m,cam);
      const pct=snap.player.hp/Math.max(1,snap.player.maxHp);
      g.fillStyle='rgba(0,0,0,.35)';g.fillRect(px-18*m.A,py-28*m.A,36*m.A,5*m.A);
      g.fillStyle=pct>0.4?'#5fcf70':'#e5484d';g.fillRect(px-18*m.A,py-28*m.A,36*m.A*pct,5*m.A)}

    // HUD hint
    g.fillStyle='rgba(39,64,90,.75)';
    g.font=Math.round(12*Math.max(0.9,m.A))+'px system-ui';
    g.textAlign='center';
    if(snap.nearHome)g.fillText('🏠 Near home — press Dock / RETURN',m.ox,m.h-18);
    else g.fillText('Drag or WASD to sail · Tap boat to attack · Collect 💎 📦',m.ox,m.h-18);
  }

  function drawBoat(g,pos,facing,A,col,isPlayer){
    const[x,y]=pos;
    g.save();g.translate(x,y);g.rotate(facing||0);
    g.fillStyle=col;
    g.beginPath();
    g.moveTo(16*A,0);g.lineTo(-12*A,9*A);g.lineTo(-8*A,0);g.lineTo(-12*A,-9*A);g.closePath();
    g.fill();
    if(isPlayer){g.fillStyle='#fff';g.beginPath();g.moveTo(4*A,-2*A);g.lineTo(-4*A,-2*A);g.lineTo(-4*A,-14*A);g.lineTo(4*A,-2*A);g.fill()}
    g.restore()}

  // Input helpers for the client
  function bindKeys(onChange){
    const fire=()=>{
      let mx=0,my=0;
      if(_keys['w']||_keys['arrowup'])my-=1;
      if(_keys['s']||_keys['arrowdown'])my+=1;
      if(_keys['a']||_keys['arrowleft'])mx-=1;
      if(_keys['d']||_keys['arrowright'])mx+=1;
      onChange(mx,my)};
    window.addEventListener('keydown',e=>{
      const k=e.key.toLowerCase();_keys[k]=true;
      if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(k)){e.preventDefault();fire()}});
    window.addEventListener('keyup',e=>{_keys[e.key.toLowerCase()]=false;fire()})}

  window.SeaView={draw,bindKeys,metrics};
})();
