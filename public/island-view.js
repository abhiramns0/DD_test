'use strict';
// Island RENDERER — isometric 3D view matching the main game projection.
// Draws the view model from island.js > view(). Handles pan (clamped to unlocked
// land) and covers locked zones with soft realistic cloud cover.
// Camera frames the unlocked region so the playable island fills the screen.
(function(){
  const COL={
    water:'#58b9dc',waterDeep:'#3a9ec4',waterLite:'#7ad0ea',
    grass:'#7ccf6e',grass2:'#6aba5c',grassDark:'#5a9e4e',
    sand:'#f2dfa5',sandDark:'#e0c88a',
    ink:'#27405a',wood:'#b9794a',woodDark:'#8a4f2c',woodLite:'#d4a06a',
    roof:'#8a4f2c',roofDark:'#5a3418',
    jetty:'#c89a62',jettyDark:'#8a6236',jettyPost:'#6b4a28',
    boat:'#d4a06a',boatSail:'#fff8e8',
    select:'#ffffff',cloud:'#f5f8fc',cloudShade:'#d0d8e4',cloudEdge:'#e8eef6'
  };
  const ICON={palm:'🌴',rock:'🪨',flag:'🚩',crate:'📦'};
  const INFO={
    workshop:'Workshop — crafting is coming soon.',
    jetty:'Boat Jetty — your raft is ready. Sail Out to explore the Open Sea.'
  };

  let cam={x:10,y:10}, _drag=null, _view=null, _canvas=null;

  function unlockedBounds(view){
    let minX=view.grid.w, minY=view.grid.h, maxX=0, maxY=0, any=false;
    for(const z of view.zones){
      if(!z.unlocked)continue;
      any=true;
      minX=Math.min(minX,z.x); minY=Math.min(minY,z.y);
      maxX=Math.max(maxX,z.x+z.w); maxY=Math.max(maxY,z.y+z.h);
    }
    if(!any)return{minX:0,minY:0,maxX:view.grid.w,maxY:view.grid.h};
    return{minX:minX-1.5,minY:minY-1.5,maxX:maxX+1.5,maxY:maxY+1.5};
  }

  function tileMetrics(canvas,view){
    const r=canvas.getBoundingClientRect();
    const b=unlockedBounds(view);
    const uw=Math.max(4,b.maxX-b.minX), uh=Math.max(4,b.maxY-b.minY);
    const spanX=uw+uh, spanY=(uw+uh)/2;
    const fitW=r.width*0.9, fitH=r.height*0.88;
    const A=Math.max(8,Math.min(fitW/spanX, fitH/spanY));
    return{A, ox:r.width/2, oy:r.height*0.5, w:r.width, h:r.height, b};
  }

  function clampCam(view){
    const b=unlockedBounds(view);
    cam.x=Math.max(b.minX,Math.min(b.maxX-0.01,cam.x));
    cam.y=Math.max(b.minY,Math.min(b.maxY-0.01,cam.y));
  }

  function centreOnUnlocked(view){
    const b=unlockedBounds(view);
    cam.x=(b.minX+b.maxX)/2;
    cam.y=(b.minY+b.maxY)/2;
    clampCam(view);
  }

  let mOx=0, mOy=0, mA=1;

  function screen(tx,ty,tz){
    const dx=tx-cam.x, dy=ty-cam.y;
    return[mOx+(dx-dy)*mA, mOy+(dx+dy)*mA*0.5 - tz*mA];
  }

  function drawTilePrism(g,tx,ty,topCol,sideL,sideR,h){
    const t0=screen(tx,ty,h), t1=screen(tx+1,ty,h), t2=screen(tx+1,ty+1,h), t3=screen(tx,ty+1,h);
    const b0=screen(tx,ty,0), b1=screen(tx+1,ty,0), b2=screen(tx+1,ty+1,0), b3=screen(tx,ty+1,0);
    g.beginPath();g.moveTo(t1[0],t1[1]);g.lineTo(t2[0],t2[1]);g.lineTo(b2[0],b2[1]);g.lineTo(b1[0],b1[1]);g.closePath();
    g.fillStyle=sideR;g.fill();
    g.beginPath();g.moveTo(t0[0],t0[1]);g.lineTo(t3[0],t3[1]);g.lineTo(b3[0],b3[1]);g.lineTo(b0[0],b0[1]);g.closePath();
    g.fillStyle=sideL;g.fill();
    g.beginPath();g.moveTo(t0[0],t0[1]);g.lineTo(t1[0],t1[1]);g.lineTo(t2[0],t2[1]);g.lineTo(t3[0],t3[1]);g.closePath();
    g.fillStyle=topCol;g.fill();
  }

  function drawWater(g,view){
    const b=unlockedBounds(view);
    const pad=3;
    const x0=Math.floor(b.minX)-pad, x1=Math.ceil(b.maxX)+pad;
    const y0=Math.floor(b.minY)-pad, y1=Math.ceil(b.maxY)+pad;
    for(let y=y0;y<y1;y++){
      for(let x=x0;x<x1;x++){
        const onMap=x>=0&&y>=0&&x<view.grid.w&&y<view.grid.h;
        const isW=!onMap||view.tiles[y][x]==='w';
        if(!isW)continue;
        const[sx,sy]=screen(x+0.5,y+0.5,0);
        const deep=(x+y)%2===0;
        g.fillStyle=deep?COL.waterDeep:COL.water;
        g.beginPath();
        g.moveTo(sx,sy-mA*0.5);g.lineTo(sx+mA,sy);g.lineTo(sx,sy+mA*0.5);g.lineTo(sx-mA,sy);g.closePath();
        g.fill();
      }
    }
  }

  function drawLand(g,view){
    const cells=[];
    for(let y=0;y<view.grid.h;y++)for(let x=0;x<view.grid.w;x++){
      const c=view.tiles[y][x];if(c==='w')continue;
      cells.push({x,y,c});
    }
    cells.sort((a,b)=>(a.x+a.y)-(b.x+b.y));
    for(const t of cells){
      const h=0.12;
      const top=t.c==='s'?COL.sand:((t.x+t.y)%2?COL.grass2:COL.grass);
      const sideL=t.c==='s'?COL.sandDark:COL.grassDark;
      const sideR=t.c==='s'?'#cbb87a':COL.grassDark;
      drawTilePrism(g,t.x,t.y,top,sideL,sideR,h);
    }
  }

  function drawWorkshop(g,s){
    const x=s.x, y=s.y, w=s.w, h=s.h;
    const baseH=0.15, wallH=1.1, roofH=0.55;
    function poly(pts,col){
      g.beginPath();
      pts.forEach((p,i)=>{const[sx,sy]=screen(p[0],p[1],p[2]||0);i?g.lineTo(sx,sy):g.moveTo(sx,sy)});
      g.closePath();g.fillStyle=col;g.fill();
    }
    poly([[x,y,baseH],[x+w,y,baseH],[x+w,y+h,baseH],[x,y+h,baseH]],COL.woodLite);
    poly([[x,y,baseH],[x,y+h,baseH],[x,y+h,baseH+wallH],[x,y,baseH+wallH]],'#9a6a3a');
    poly([[x,y+h,baseH],[x+w,y+h,baseH],[x+w,y+h,baseH+wallH],[x,y+h,baseH+wallH]],COL.wood);
    poly([[x,y,baseH],[x+w,y,baseH],[x+w,y,baseH+wallH],[x,y,baseH+wallH]],COL.woodDark);
    const midX=x+w/2, midY=y+h/2, peakH=baseH+wallH+roofH;
    poly([[x,y+h,baseH+wallH],[x+w,y+h,baseH+wallH],[midX,midY,peakH]],COL.roof);
    poly([[x,y,baseH+wallH],[x+w,y,baseH+wallH],[midX,midY,peakH]],COL.roofDark);
    poly([[x,y,baseH+wallH],[x,y+h,baseH+wallH],[midX,midY,peakH]],'#7a4524');
    poly([[x+w,y,baseH+wallH],[x+w,y+h,baseH+wallH],[midX,midY,peakH]],'#a05a30');
    const dx=x+w*0.35, dy=y+h-0.02, dw=w*0.3, dh=0.55;
    poly([[dx,dy,baseH],[dx+dw,dy,baseH],[dx+dw,dy,baseH+dh],[dx,dy,baseH+dh]],COL.roofDark);
    const[sx,sy]=screen(x+w/2,y+h*0.55,baseH+wallH*0.55);
    g.font=Math.round(mA*1.4)+'px sans-serif';
    g.textAlign='center';g.textBaseline='middle';
    g.fillStyle=COL.ink;g.fillText('🔨',sx,sy);
  }

  function drawJetty(g,s){
    const x=s.x, y=s.y, w=s.w, h=s.h;
    for(let j=0;j<h;j++){
      const yy=y+j, top=0.18;
      const p0=screen(x,yy,top), p1=screen(x+w,yy,top), p2=screen(x+w,yy+1,top), p3=screen(x,yy+1,top);
      g.beginPath();g.moveTo(p0[0],p0[1]);g.lineTo(p1[0],p1[1]);g.lineTo(p2[0],p2[1]);g.lineTo(p3[0],p3[1]);g.closePath();
      g.fillStyle=j%2?COL.jetty:COL.woodLite;g.fill();
      const b0=screen(x,yy,0), b1=screen(x+w,yy,0);
      g.beginPath();g.moveTo(p0[0],p0[1]);g.lineTo(p1[0],p1[1]);g.lineTo(b1[0],b1[1]);g.lineTo(b0[0],b0[1]);g.closePath();
      g.fillStyle=COL.jettyDark;g.fill();
    }
    for(let j=0;j<=h;j+=2){
      for(const side of [0,w]){
        const[px,py]=screen(x+side,y+j,0.35);
        g.fillStyle=COL.jettyPost;
        g.fillRect(px-mA*0.08,py-mA*0.5,mA*0.16,mA*0.55);
      }
    }
    drawDockedBoat(g, x+w*0.5, y+h+0.6);
  }

  function drawDockedBoat(g,tx,ty){
    const[sx,sy]=screen(tx,ty,0.25);
    const A=mA;
    g.save();g.translate(sx,sy);
    g.fillStyle=COL.boat;
    g.beginPath();g.moveTo(0,-A*0.55);g.lineTo(A*0.9,A*0.15);g.lineTo(A*0.55,A*0.45);g.lineTo(-A*0.55,A*0.45);g.lineTo(-A*0.9,A*0.15);g.closePath();g.fill();
    g.fillStyle=COL.jettyDark;
    g.beginPath();g.moveTo(0,-A*0.55);g.lineTo(A*0.9,A*0.15);g.lineTo(A*0.55,A*0.45);g.lineTo(-A*0.55,A*0.45);g.lineTo(-A*0.9,A*0.15);g.closePath();g.lineWidth=1.5;g.stroke();
    g.strokeStyle=COL.ink;g.lineWidth=2;g.beginPath();g.moveTo(0,A*0.1);g.lineTo(0,-A*1.1);g.stroke();
    g.fillStyle=COL.boatSail;
    g.beginPath();g.moveTo(0,-A*1.05);g.lineTo(A*0.7,-A*0.35);g.lineTo(0,-A*0.2);g.closePath();g.fill();
    g.restore();
  }

  function drawDecor(g,s){
    const[sx,sy]=screen(s.x+0.5,s.y+0.5,0.2);
    g.font=Math.round(mA*1.6)+'px sans-serif';
    g.textAlign='center';g.textBaseline='middle';
    g.fillStyle='rgba(39,64,90,.18)';
    g.beginPath();g.ellipse(sx,sy+mA*0.15,mA*0.45,mA*0.22,0,0,6.283);g.fill();
    g.fillStyle=COL.ink;
    g.fillText(ICON[s.type]||'⬜',sx,sy-mA*0.15);
  }

  function drawStructure(g,s,selected){
    if(s.type==='workshop')drawWorkshop(g,s);
    else if(s.type==='jetty')drawJetty(g,s);
    else if(ICON[s.type])drawDecor(g,s);
    else drawTilePrism(g,s.x,s.y,'#c0c8d0','#a0a8b0','#9098a0',0.6);
    if(selected){
      const pts=[[s.x,s.y],[s.x+s.w,s.y],[s.x+s.w,s.y+s.h],[s.x,s.y+s.h]];
      g.beginPath();
      pts.forEach((p,i)=>{const[sx,sy]=screen(p[0],p[1],0.25);i?g.lineTo(sx,sy):g.moveTo(sx,sy)});
      g.closePath();
      g.strokeStyle=COL.select;g.lineWidth=3;g.stroke();
    }
  }

  function drawClouds(g,view){
    for(const z of view.zones){
      if(z.unlocked)continue;
      const cx=z.x+z.w/2, cy=z.y+z.h/2;
      const blobs=[
        {ox:-0.8,oy:-0.4,rx:z.w*0.55,ry:z.h*0.45,a:0.92},
        {ox:0.6,oy:0.3,rx:z.w*0.5,ry:z.h*0.4,a:0.88},
        {ox:0.1,oy:-0.6,rx:z.w*0.45,ry:z.h*0.38,a:0.85},
        {ox:-0.3,oy:0.5,rx:z.w*0.48,ry:z.h*0.42,a:0.9},
        {ox:0.9,oy:-0.2,rx:z.w*0.4,ry:z.h*0.35,a:0.8},
        {ox:-1.0,oy:0.1,rx:z.w*0.42,ry:z.h*0.36,a:0.82}
      ];
      for(const b of blobs){
        const[sx,sy]=screen(cx+b.ox,cy+b.oy,1.2);
        const rx=b.rx*mA*1.35, ry=b.ry*mA*0.75;
        g.globalAlpha=b.a*0.35;g.fillStyle=COL.cloudEdge;
        g.beginPath();g.ellipse(sx,sy,rx*1.25,ry*1.25,0,0,6.283);g.fill();
        g.globalAlpha=b.a*0.7;g.fillStyle=COL.cloud;
        g.beginPath();g.ellipse(sx,sy,rx,ry,0,0,6.283);g.fill();
        g.globalAlpha=b.a*0.55;g.fillStyle='#ffffff';
        g.beginPath();g.ellipse(sx-rx*0.15,sy-ry*0.25,rx*0.55,ry*0.45,0,0,6.283);g.fill();
        g.globalAlpha=b.a*0.4;g.fillStyle=COL.cloudShade;
        g.beginPath();g.ellipse(sx+rx*0.1,sy+ry*0.3,rx*0.7,ry*0.4,0,0,6.283);g.fill();
      }
      g.globalAlpha=1;
      const[lx,ly]=screen(cx,cy,1.8);
      g.font=Math.round(mA*1.8)+'px sans-serif';
      g.textAlign='center';g.textBaseline='middle';
      g.globalAlpha=0.9;g.fillText('🔒',lx,ly);g.globalAlpha=1;
    }
  }

  function draw(canvas,view,opts){
    opts=opts||{};
    if(!canvas||!view)return;
    _canvas=canvas;_view=view;
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const r=canvas.getBoundingClientRect();
    if(!r.width||!r.height)return;
    if(canvas.width!==Math.round(r.width*dpr)||canvas.height!==Math.round(r.height*dpr)){
      canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);
    }
    const g=canvas.getContext('2d');
    const m=tileMetrics(canvas,view);
    mOx=m.ox;mOy=m.oy;mA=m.A;
    g.setTransform(dpr,0,0,dpr,0,0);
    g.clearRect(0,0,m.w,m.h);

    const grd=g.createLinearGradient(0,0,0,m.h);
    grd.addColorStop(0,'#87ceeb');grd.addColorStop(0.55,'#b8e0f0');grd.addColorStop(1,'#58b9dc');
    g.fillStyle=grd;g.fillRect(0,0,m.w,m.h);

    clampCam(view);
    drawWater(g,view);
    drawLand(g,view);

    const structs=view.structures.slice().sort((a,b)=>(a.x+a.y+a.w/2+a.h/2)-(b.x+b.y+b.w/2+b.h/2));
    for(const s of structs)drawStructure(g,s,opts.selectedId===s.id);

    drawClouds(g,view);
  }

  function hit(canvas,view,cx,cy){
    if(!canvas||!view)return null;
    const r=canvas.getBoundingClientRect();
    const m=tileMetrics(canvas,view);
    mOx=m.ox;mOy=m.oy;mA=m.A;
    const mx=cx-r.left, my=cy-r.top;
    const u=(mx-m.ox)/m.A, v=2*(my-m.oy)/m.A;
    const dx=(u+v)/2, dy=(v-u)/2;
    const tx=cam.x+dx, ty=cam.y+dy;
    const list=view.structures.slice().reverse();
    for(const s of list){
      if(tx>=s.x&&tx<s.x+s.w&&ty>=s.y&&ty<s.y+s.h)return s;
    }
    return null;
  }

  const info=s=>s?(INFO[s.type]||s.label):'Drag to look around · Sail Out from the jetty anytime.';

  function onPointerDown(e){
    if(!_canvas||!_view)return;
    _drag={id:e.pointerId,x:e.clientX,y:e.clientY,cx:cam.x,cy:cam.y,moved:false};
    try{_canvas.setPointerCapture(e.pointerId)}catch(_){}
  }
  function onPointerMove(e){
    if(!_drag||_drag.id!==e.pointerId||!_view)return;
    const m=tileMetrics(_canvas,_view);
    const dx=e.clientX-_drag.x, dy=e.clientY-_drag.y;
    if(Math.hypot(dx,dy)>4)_drag.moved=true;
    const ddx=dx/(2*m.A)+dy/m.A;
    const ddy=-dx/(2*m.A)+dy/m.A;
    cam.x=_drag.cx-ddx;
    cam.y=_drag.cy-ddy;
    clampCam(_view);
    draw(_canvas,_view,{selectedId:window.__islSel||''});
  }
  function onPointerUp(e){
    if(!_drag||_drag.id!==e.pointerId)return;
    _drag=null;
  }

  function bind(canvas){
    if(!canvas||canvas.__islBound)return;
    canvas.__islBound=true;
    canvas.style.touchAction='none';
    canvas.addEventListener('pointerdown',onPointerDown);
    canvas.addEventListener('pointermove',onPointerMove);
    canvas.addEventListener('pointerup',onPointerUp);
    canvas.addEventListener('pointercancel',onPointerUp);
  }

  function drawAndBind(canvas,view,opts){
    if(view&&(!_view||_view.rev!==view.rev)){
      centreOnUnlocked(view);
    }
    bind(canvas);
    if(opts&&opts.selectedId!==undefined)window.__islSel=opts.selectedId;
    draw(canvas,view,opts);
  }

  window.IslandView={draw:drawAndBind,hit,info,centreOnUnlocked};
})();
