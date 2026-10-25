'use strict';
(function(){
  const COL={
    deep:'#0d4a6a',mid:'#1a7a9a',lite:'#3a9ec4',foam:'#c8eef8',
    home:'#7ccf6e',homeSand:'#f2dfa5',islet:'#6aba5c',isletSand:'#e8d9a0',
    boat:'#c89a62',boatDark:'#8a6236',player:'#e8b84a',playerDark:'#b88820',
    wreck:'#5a4a3a',sail:'#fff8e8'
  };
  let cam={x:0,y:0},_keys={};

  function metrics(){
    const w=Math.max(320,window.innerWidth||320);
    const h=Math.max(480,window.innerHeight||480);
    const A=Math.max(0.4,Math.min(w,h)/520);
    return{A,ox:w/2,oy:h/2,w,h};
  }
  function S(x,y,m,c){return[m.ox+(x-c.x)*m.A,m.oy+(y-c.y)*m.A]}

  function drawBoat(g,pos,facing,A,isPlayer){
    const x=pos[0],y=pos[1],s=Math.max(10,A*1.2);
    g.save();g.translate(x,y);g.rotate(facing||0);
    g.globalAlpha=0.28;g.fillStyle='#062030';
    g.beginPath();g.ellipse(0,s*3,s*16,s*6,0,0,6.283);g.fill();g.globalAlpha=1;
    g.fillStyle=isPlayer?COL.playerDark:COL.boatDark;
    g.beginPath();g.moveTo(-s*20,0);g.quadraticCurveTo(0,s*10,s*22,0);g.quadraticCurveTo(0,-s*10,-s*20,0);g.closePath();g.fill();
    g.fillStyle=isPlayer?COL.player:COL.boat;
    g.beginPath();g.moveTo(-s*16,0);g.quadraticCurveTo(0,s*7,s*18,0);g.quadraticCurveTo(0,-s*7,-s*16,0);g.closePath();g.fill();
    g.strokeStyle='#5a4030';g.lineWidth=Math.max(2,s*0.3);
    g.beginPath();g.moveTo(0,0);g.lineTo(0,-s*28);g.stroke();
    g.fillStyle=COL.sail;
    g.beginPath();g.moveTo(0,-s*28);g.lineTo(s*18,-s*14);g.lineTo(0,-s*4);g.closePath();g.fill();
    g.fillStyle=isPlayer?'#ff6b4a':'#4a8cff';
    g.beginPath();g.moveTo(s*16,-s*2);g.lineTo(s*24,0);g.lineTo(s*16,s*2);g.closePath();g.fill();
    g.restore();
  }

  function draw(canvas,snap){
    try{
      if(!canvas||!snap)return;
      const m=metrics();
      canvas.style.position='fixed';
      canvas.style.left='0';canvas.style.top='0';
      canvas.style.width=m.w+'px';canvas.style.height=m.h+'px';
      canvas.style.zIndex='1';canvas.style.display='block';
      const dpr=Math.min(2,window.devicePixelRatio||1);
      const bw=Math.round(m.w*dpr),bh=Math.round(m.h*dpr);
      if(canvas.width!==bw||canvas.height!==bh){canvas.width=bw;canvas.height=bh}
      const g=canvas.getContext('2d');if(!g)return;
      g.setTransform(dpr,0,0,dpr,0,0);
      g.clearRect(0,0,m.w,m.h);
      if(snap.player){cam.x=snap.player.x||0;cam.y=snap.player.y||0}

      const grd=g.createRadialGradient(m.ox,m.oy,0,m.ox,m.oy,Math.max(m.w,m.h)*0.8);
      grd.addColorStop(0,COL.lite);grd.addColorStop(0.55,COL.mid);grd.addColorStop(1,COL.deep);
      g.fillStyle=grd;g.fillRect(0,0,m.w,m.h);

      // Home
      const[hx,hy]=S(0,0,m,cam);
      const hr=(snap.cfg&&snap.cfg.homeR||180)*m.A;
      g.fillStyle=COL.homeSand;g.beginPath();g.ellipse(hx,hy,hr*1.1,hr*0.75,0,0,6.283);g.fill();
      g.fillStyle=COL.home;g.beginPath();g.ellipse(hx,hy,hr*0.9,hr*0.6,0,0,6.283);g.fill();
      g.font=Math.round(32*m.A)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';
      g.fillText('🏝️',hx,hy);

      for(const it of(snap.islets||[])){
        const[x,y]=S(it.x,it.y,m,cam);const r=(it.r||50)*m.A;
        g.fillStyle=COL.isletSand;g.beginPath();g.ellipse(x,y,r*1.05,r*0.7,0,0,6.283);g.fill();
        g.fillStyle=COL.islet;g.beginPath();g.ellipse(x,y,r*0.85,r*0.55,0,0,6.283);g.fill();
      }
      for(const tr of(snap.treasures||[])){
        const[x,y]=S(tr.x,tr.y,m,cam);
        g.font=Math.round(28*m.A)+'px sans-serif';g.textAlign='center';
        g.fillText(tr.kind==='chest'?'💎':'📦',x,y);
      }
      for(const w of(snap.wildlife||[])){
        const[x,y]=S(w.x,w.y,m,cam);
        g.font=Math.round(30*m.A)+'px sans-serif';g.textAlign='center';
        g.fillText(w.kind==='croc'?'🐊':'🐦',x,y);
      }
      for(const n of(snap.npcs||[])) drawBoat(g,S(n.x,n.y,m,cam),n.facing,m.A,false);
      for(const o of(snap.others||[])){
        drawBoat(g,S(o.x,o.y,m,cam),o.facing,m.A*0.95,false);
        const[ox,oy]=S(o.x,o.y,m,cam);
        g.font='bold 12px system-ui';g.textAlign='center';g.fillStyle='#fff';
        g.fillText(o.name||'Sailor',ox,oy-40*m.A);
        if(o.emoji&&o.emoji.id)g.fillText(o.emoji.id,ox,oy-60*m.A);
      }
      if(snap.player){
        drawBoat(g,S(snap.player.x,snap.player.y,m,cam),snap.player.facing,m.A,true);
        const[px,py]=S(snap.player.x,snap.player.y,m,cam);
        g.font='bold 12px system-ui';g.fillStyle='#fff';g.textAlign='center';
        g.fillText('YOU',px,py-50*m.A);
      }
    }catch(e){try{console.error('[SeaView]',e)}catch(x){}}
  }

  function bindKeys(onChange){
    const fire=()=>{
      let mx=0,my=0;
      if(_keys.w||_keys.arrowup)my-=1;
      if(_keys.s||_keys.arrowdown)my+=1;
      if(_keys.a||_keys.arrowleft)mx-=1;
      if(_keys.d||_keys.arrowright)mx+=1;
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
