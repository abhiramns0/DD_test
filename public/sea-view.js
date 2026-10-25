'use strict';
// Open Sea RENDERER. Draws the snapshot from sea.js > view(). No rules, no networking.
(function(){
  const COL={
    deep:'#0d4a6a',mid:'#1a7a9a',lite:'#3a9ec4',foam:'#c8eef8',
    home:'#7ccf6e',homeSand:'#f2dfa5',islet:'#6aba5c',isletSand:'#e8d9a0',
    boat:'#c89a62',boatDark:'#8a6236',boatLite:'#e0b888',
    player:'#e8b84a',playerDark:'#b88820',playerLite:'#ffe08a',
    wreck:'#5a4a3a',ink:'#27405a',sail:'#fff8e8',sailStripe:'#e8d4b0'
  };

  let cam={x:0,y:0}, _keys={};

  function metrics(canvas){
    let w=canvas.clientWidth|0, h=canvas.clientHeight|0;
    if(!w||!h){
      const r=canvas.getBoundingClientRect();
      w=Math.round(r.width)||0; h=Math.round(r.height)||0;
    }
    if(!w||!h){w=window.innerWidth||320;h=window.innerHeight||480}
    const A=Math.max(0.35, Math.min(w,h)/520);
    return{A,ox:w/2,oy:h/2,w,h};
  }

  function S(x,y,m,c){
    return[m.ox+(x-c.x)*m.A, m.oy+(y-c.y)*m.A];
  }

  function draw(canvas,snap,opts){
    try{
      opts=opts||{};
      if(!canvas||!snap)return;
      const m=metrics(canvas);
      const dpr=Math.min(2,window.devicePixelRatio||1);
      const bw=Math.max(1,Math.round(m.w*dpr)), bh=Math.max(1,Math.round(m.h*dpr));
      if(canvas.width!==bw||canvas.height!==bh){canvas.width=bw;canvas.height=bh}
      const g=canvas.getContext('2d');
      if(!g)return;
      g.setTransform(dpr,0,0,dpr,0,0);
      g.clearRect(0,0,m.w,m.h);

      if(snap.player){cam.x=snap.player.x;cam.y=snap.player.y}

      const grd=g.createRadialGradient(m.ox,m.oy,0,m.ox,m.oy,Math.max(m.w,m.h)*0.75);
      grd.addColorStop(0,COL.lite);grd.addColorStop(0.5,COL.mid);grd.addColorStop(1,COL.deep);
      g.fillStyle=grd;g.fillRect(0,0,m.w,m.h);

      const t=performance.now();
      g.globalAlpha=0.14;
      for(let i=0;i<6;i++){
        const k=((t/4500+i/6)%1);
        g.strokeStyle=COL.foam;g.lineWidth=2;
        g.beginPath();g.ellipse(m.ox,m.oy,(120+k*380)*m.A,(60+k*190)*m.A,0,0,6.283);g.stroke();
      }
      g.globalAlpha=1;

      if(snap.cfg){
        const[bx,by]=S(0,0,m,cam);
        g.strokeStyle='rgba(255,255,255,.18)';g.lineWidth=2;g.setLineDash([12,10]);
        g.beginPath();g.arc(bx,by,(snap.cfg.worldR||3200)*m.A,0,6.283);g.stroke();g.setLineDash([]);
      }

      {
        const[hx,hy]=S(0,0,m,cam);
        const hr=(snap.cfg&&snap.cfg.homeR||180)*m.A;
        g.fillStyle=COL.homeSand;
        g.beginPath();g.ellipse(hx,hy,hr*1.05,hr*0.72,0,0,6.283);g.fill();
        g.fillStyle=COL.home;
        g.beginPath();g.ellipse(hx,hy,hr*0.88,hr*0.58,0,0,6.283);g.fill();
        g.font=Math.round(28*Math.max(0.9,m.A))+'px sans-serif';
        g.textAlign='center';g.textBaseline='middle';
        g.fillText('🏝️',hx,hy);
      }

      for(const it of(snap.islets||[])){
        const[x,y]=S(it.x,it.y,m,cam);
        const r=(it.r||50)*m.A;
        g.fillStyle=COL.isletSand;
        g.beginPath();g.ellipse(x,y,r*1.05,r*0.7,0,0,6.283);g.fill();
        g.fillStyle=COL.islet;
        g.beginPath();g.ellipse(x,y,r*0.85,r*0.55,0,0,6.283);g.fill();
        if(it.explored){
          g.font=Math.round(12*m.A)+'px system-ui';g.fillStyle='#fff';g.textAlign='center';
          g.fillText(it.name||'',x,y+r*0.9);
        }
      }

      for(const tr of(snap.treasures||[])){
        const[x,y]=S(tr.x,tr.y,m,cam);
        const bob=Math.sin(t/300+(tr.x||0))*3;
        g.font=Math.round(26*Math.max(0.9,m.A))+'px sans-serif';
        g.textAlign='center';g.textBaseline='middle';
        g.shadowColor='rgba(0,0,0,.35)';g.shadowBlur=6;
        g.fillText(tr.kind==='chest'?'💎':'📦',x,y+bob);g.shadowBlur=0;
      }

      for(const w of(snap.wrecks||[])){
        const[x,y]=S(w.x,w.y,m,cam);
        g.fillStyle=COL.wreck;g.globalAlpha=0.75;
        g.beginPath();g.ellipse(x,y,22*m.A,12*m.A,0.3,0,6.283);g.fill();
        g.globalAlpha=1;
        if(w.loot>0){g.font=Math.round(16*m.A)+'px sans-serif';g.textAlign='center';g.fillText('✨',x,y-16*m.A)}
      }

      for(const w of(snap.wildlife||[])){
        const[x,y]=S(w.x,w.y,m,cam);
        g.font=Math.round(28*Math.max(0.9,m.A))+'px sans-serif';
        g.textAlign='center';g.textBaseline='middle';
        g.fillText(w.kind==='croc'?'🐊':'🐦',x,y);
      }

      for(const n of(snap.npcs||[])){
        drawDetailedBoat(g,S(n.x,n.y,m,cam),n.facing,m.A,false);
      }

      for(const o of(snap.others||[])){
        drawDetailedBoat(g,S(o.x,o.y,m,cam),o.facing,m.A*0.95,false);
        const[ox,oy]=S(o.x,o.y,m,cam);
        g.font='bold '+Math.round(11*Math.max(0.85,m.A))+'px system-ui';
        g.textAlign='center';g.textBaseline='bottom';
        g.fillStyle='rgba(39,64,90,.75)';
        const label=o.name||'Sailor';
        const tw=g.measureText(label).width+10;
        g.fillRect(ox-tw/2,oy-52*m.A,tw,16);
        g.fillStyle='#fff';g.fillText(label,ox,oy-38*m.A);
        const pct=(o.hp||0)/Math.max(1,o.maxHp||100);
        g.fillStyle='rgba(0,0,0,.35)';g.fillRect(ox-22*m.A,oy-34*m.A,44*m.A,5*m.A);
        g.fillStyle=pct>0.4?'#5fcf70':'#e5484d';g.fillRect(ox-22*m.A,oy-34*m.A,44*m.A*pct,5*m.A);
        if(o.emoji&&o.emoji.id){
          g.font=Math.round(22*Math.max(0.9,m.A))+'px sans-serif';
          g.textAlign='center';g.textBaseline='middle';
          g.fillText(o.emoji.id,ox,oy-68*m.A);
        }
      }

      if(snap.player&&snap.player.alive!==false){
        drawDetailedBoat(g,S(snap.player.x,snap.player.y,m,cam),snap.player.facing,m.A,true);
        const[px,py]=S(snap.player.x,snap.player.y,m,cam);
        const pct=(snap.player.hp||0)/Math.max(1,snap.player.maxHp||100);
        g.fillStyle='rgba(0,0,0,.4)';g.fillRect(px-28*m.A,py-48*m.A,56*m.A,7*m.A);
        g.fillStyle=pct>0.4?'#5fcf70':'#e5484d';g.fillRect(px-28*m.A,py-48*m.A,56*m.A*pct,7*m.A);
      }

      if(snap.player&&!snap.nearHome){
        drawHomeAnchor(g,m,cam,snap.player);
      }
    }catch(err){
      try{console.error('[SeaView.draw]',err)}catch(e){}
    }
  }

  function drawDetailedBoat(g,pos,facing,A,isPlayer){
    const x=pos[0], y=pos[1];
    const s=Math.max(8,A*1.15);
    g.save();
    g.translate(x,y);
    g.rotate(facing||0);

    g.globalAlpha=0.25;
    g.fillStyle='#0a3040';
    g.beginPath();g.ellipse(-s*6,s*2,s*18,s*7,0,0,6.283);g.fill();
    g.globalAlpha=1;

    const hull=isPlayer?COL.player:COL.boat;
    const hullD=isPlayer?COL.playerDark:COL.boatDark;
    const hullL=isPlayer?COL.playerLite:COL.boatLite;

    g.fillStyle=hullD;
    g.beginPath();
    g.moveTo(-s*22,0);g.quadraticCurveTo(-s*10,s*12,s*16,s*8);
    g.quadraticCurveTo(s*28,s*2,s*28,0);
    g.quadraticCurveTo(s*28,-s*2,s*16,-s*8);
    g.quadraticCurveTo(-s*10,-s*12,-s*22,0);
    g.closePath();g.fill();

    g.fillStyle=hull;
    g.beginPath();
    g.moveTo(-s*20,0);g.quadraticCurveTo(-s*8,s*9,s*14,s*6);
    g.quadraticCurveTo(s*24,s*1,s*24,0);
    g.quadraticCurveTo(s*24,-s*1,s*14,-s*6);
    g.quadraticCurveTo(-s*8,-s*9,-s*20,0);
    g.closePath();g.fill();

    g.fillStyle=hullL;
    g.beginPath();g.ellipse(s*2,0,s*12,s*4.5,0,0,6.283);g.fill();

    g.fillStyle=hullD;
    g.fillRect(-s*6,-s*7,s*10,s*6);
    g.fillStyle='#7ec8e8';
    g.fillRect(-s*4,-s*5,s*6,s*3);

    g.strokeStyle='#5a4030';g.lineWidth=Math.max(1.5,s*0.35);
    g.beginPath();g.moveTo(s*2.5,0);g.lineTo(s*2.5,-s*36);g.stroke();
    g.fillStyle=COL.sail;
    g.beginPath();
    g.moveTo(s*2.5,-s*36);
    g.quadraticCurveTo(s*28,-s*22,s*22,-s*6);
    g.lineTo(s*2.5,-s*4);
    g.closePath();g.fill();
    g.strokeStyle=COL.sailStripe;g.lineWidth=1.2;
    g.beginPath();g.moveTo(s*6,-s*30);g.quadraticCurveTo(s*20,-s*20,s*16,-s*10);g.stroke();

    g.fillStyle=isPlayer?'#ff6b4a':'#4a8cff';
    g.beginPath();g.moveTo(s*22,-s*4);g.lineTo(s*32,-s*1);g.lineTo(s*22,s*2);g.closePath();g.fill();

    g.restore();
  }

  function drawHomeAnchor(g,m,cam,player){
    const dx=-player.x, dy=-player.y;
    const dist=Math.hypot(dx,dy)||1;
    const ang=Math.atan2(dy,dx);
    const edge=Math.min(m.w,m.h)*0.38;
    const ix=m.ox+Math.cos(ang)*edge;
    const iy=m.oy+Math.sin(ang)*edge;
    g.save();
    g.translate(ix,iy);
    g.rotate(ang+Math.PI/2);
    g.globalAlpha=0.55;
    g.fillStyle='rgba(255,255,255,.2)';
    g.beginPath();g.arc(0,0,22,0,6.283);g.fill();
    g.strokeStyle='rgba(255,255,255,.45)';g.lineWidth=2;
    g.beginPath();g.arc(0,0,22,0,6.283);g.stroke();
    g.strokeStyle='#fff';g.fillStyle='#fff';g.lineWidth=2.4;g.lineCap='round';g.lineJoin='round';
    g.beginPath();g.arc(0,-12,4.5,0,6.283);g.stroke();
    g.beginPath();g.moveTo(0,-7);g.lineTo(0,10);g.stroke();
    g.beginPath();g.moveTo(-10,4);g.quadraticCurveTo(-12,12,0,12);g.quadraticCurveTo(12,12,10,4);g.stroke();
    g.beginPath();g.moveTo(-5,14);g.lineTo(0,20);g.lineTo(5,14);g.stroke();
    g.globalAlpha=0.7;
    g.font='11px system-ui';g.textAlign='center';g.textBaseline='top';
    g.fillStyle='#fff';
    g.rotate(-(ang+Math.PI/2));
    g.fillText(Math.round(dist)+' u',0,26);
    g.restore();
  }

  function bindKeys(onChange){
    const fire=()=>{
      let mx=0,my=0;
      if(_keys['w']||_keys['arrowup'])my-=1;
      if(_keys['s']||_keys['arrowdown'])my+=1;
      if(_keys['a']||_keys['arrowleft'])mx-=1;
      if(_keys['d']||_keys['arrowright'])mx+=1;
      onChange(mx,my);
    };
    window.addEventListener('keydown',e=>{
      const k=e.key.toLowerCase();_keys[k]=true;
      if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(k)){e.preventDefault();fire()}
    });
    window.addEventListener('keyup',e=>{_keys[e.key.toLowerCase()]=false;fire()});
  }

  window.SeaView={draw,bindKeys,metrics};
})();
