'use strict';
// Island RENDERER — isometric 3D view matching the main game projection.
// Draws the view model from island.js > view(). Handles pan (clamped to unlocked
// land) and covers locked zones with soft realistic cloud cover.
(function(){
  const COL={
    water:'#58b9dc',waterDeep:'#3a9ec4',waterLite:'#7ad0ea',
    grass:'#7ccf6e',grass2:'#6aba5c',grassDark:'#5a9e4e',
    sand:'#f2dfa5',sandDark:'#e0c88a',
    ink:'#27405a',wood:'#b9794a',woodDark:'#8a4f2c',woodLite:'#d4a06a',
    roof:'#8a4f2c',roofDark:'#5a3418',
    jetty:'#c89a62',jettyDark:'#8a6236',jettyPost:'#6b4a28',
    select:'#ffffff',cloud:'#f5f8fc',cloudShade:'#d0d8e4',cloudEdge:'#e8eef6'
  };
  const ICON={palm:'🌴',rock:'🪨',flag:'🚩',crate:'📦'};
  const INFO={
    workshop:'Workshop — crafting is coming soon.',
    jetty:'Boat Jetty — sailing is coming soon.'
  };

  // Persistent pan state (tile-space camera centre)
  let cam={x:10,y:10}, _drag=null, _view=null, _canvas=null;

  // Isometric helpers — same ratios as the main game (x-y, (x+y)/2)
  function tileMetrics(canvas,view){
    const r=canvas.getBoundingClientRect();
    const gw=view.grid.w, gh=view.grid.h;
    // Fit the full island with a little margin; scale is based on the longer diagonal
    const fitW=r.width*0.92, fitH=r.height*0.82;
    // One tile: width = 2*A, height = A  (iso diamond)
    // Full map span: (gw+gh)*A in X, (gw+gh)*A/2 in Y
    const spanX=gw+gh, spanY=(gw+gh)/2;
    const A=Math.min(fitW/spanX, fitH/spanY);
    return{A, ox:r.width/2, oy:r.height*0.48, w:r.width, h:r.height, gw, gh};
  }

  // Bounding box of unlocked land in tile space (for pan clamp)
  function unlockedBounds(view){
    let minX=view.grid.w, minY=view.grid.h, maxX=0, maxY=0, any=false;
    for(const z of view.zones){
      if(!z.unlocked)continue;
      any=true;
      minX=Math.min(minX,z.x); minY=Math.min(minY,z.y);
      maxX=Math.max(maxX,z.x+z.w); maxY=Math.max(maxY,z.y+z.h);
    }
    if(!any)return{minX:0,minY:0,maxX:view.grid.w,maxY:view.grid.h};
    // Pad a little so edges stay visible
    return{minX:minX-0.5,minY:minY-0.5,maxX:maxX+0.5,maxY:maxY+0.5};
  }

  function clampCam(view){
    const b=unlockedBounds(view);
    // Keep camera inside the unlocked rectangle
    cam.x=Math.max(b.minX,Math.min(b.maxX-0.01,cam.x));
    cam.y=Math.max(b.minY,Math.min(b.maxY-0.01,cam.y));
  }

  function centreOnUnlocked(view){
    const b=unlockedBounds(view);
    cam.x=(b.minX+b.maxX)/2;
    cam.y=(b.minY+b.maxY)/2;
    clampCam(view);
  }

  // Use module-level temps set by draw()
  let mOx=0, mOy=0, mA=1;

  function screen(tx,ty,tz){
    const dx=tx-cam.x, dy=ty-cam.y;
    return[mOx+(dx-dy)*mA, mOy+(dx+dy)*mA*0.5 - tz*mA];
  }

  function drawTilePrism(g,tx,ty,topCol,sideL,sideR,h){
    // Single 1×1 tile with vertical height h
    const t0=screen(tx,ty,h), t1=screen(tx+1,ty,h), t2=screen(tx+1,ty+1,h), t3=screen(tx,ty+1,h);
    const b0=screen(tx,ty,0), b1=screen(tx+1,ty,0), b2=screen(tx+1,ty+1,0), b3=screen(tx,ty+1,0);
    // Right face
    g.beginPath();g.moveTo(t1[0],t1[1]);g.lineTo(t2[0],t2[1]);g.lineTo(b2[0],b2[1]);g.lineTo(b1[0],b1[1]);g.closePath();
    g.fillStyle=sideR;g.fill();
    // Left face
    g.beginPath();g.moveTo(t0[0],t0[1]);g.lineTo(t3[0],t3[1]);g.lineTo(b3[0],b3[1]);g.lineTo(b0[0],b0[1]);g.closePath();
    g.fillStyle=sideL;g.fill();
    // Top
    g.beginPath();g.moveTo(t0[0],t0[1]);g.lineTo(t1[0],t1[1]);g.lineTo(t2[0],t2[1]);g.lineTo(t3[0],t3[1]);g.closePath();
    g.fillStyle=topCol;g.fill();
  }

  function drawWater(g,view){
    // Soft ocean backdrop then individual water tiles with a subtle checker
    const pad=4;
    for(let y=-pad;y<view.grid.h+pad;y++){
      for(let x=-pad;x<view.grid.w+pad;x++){
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
    // Depth-sort tiles by (x+y) for correct overpaint
    const cells=[];
    for(let y=0;y<view.grid.h;y++)for(let x=0;x<view.grid.w;x++){
      const c=view.tiles[y][x];if(c==='w')continue;
      cells.push({x,y,c});
    }
    cells.sort((a,b)=>(a.x+a.y)-(b.x+b.y));
    for(const t of cells){
      const h=0.12; // slight elevation so land sits above water
      const top=t.c==='s'?COL.sand:((t.x+t.y)%2?COL.grass2:COL.grass);
      const sideL=t.c==='s'?COL.sandDark:COL.grassDark;
      const sideR=t.c==='s'?'#cbb87a':COL.grassDark;
      drawTilePrism(g,t.x,t.y,top,sideL,sideR,h);
    }
  }

  // ---- structures (3-D isometric) ----------------------------------------
  function drawWorkshop(g,s){
    const x=s.x, y=s.y, w=s.w, h=s.h;
    const baseH=0.15, wallH=1.1, roofH=0.55;
    function poly(pts,col){
      g.beginPath();
      pts.forEach((p,i)=>{const[sx,sy]=screen(p[0],p[1],p[2]||0);i?g.lineTo(sx,sy):g.moveTo(sx,sy)});
      g.closePath();g.fillStyle=col;g.fill();
    }
    // Base
    poly([[x,y,baseH],[x+w,y,baseH],[x+w,y+h,baseH],[x,y+h,baseH]],COL.woodLite);
    // Walls – left
    poly([[x,y,baseH],[x,y+h,baseH],[x,y+h,baseH+wallH],[x,y,baseH+wallH]],'#9a6a3a');
    // Walls – right (front-ish)
    poly([[x,y+h,baseH],[x+w,y+h,baseH],[x+w,y+h,baseH+wallH],[x,y+h,baseH+wallH]],COL.wood);
    // Walls – far
    poly([[x,y,baseH],[x+w,y,baseH],[x+w,y,baseH+wallH],[x,y,baseH+wallH]],COL.woodDark);
    // Roof – two slopes
    const midX=x+w/2, midY=y+h/2;
    const peakH=baseH+wallH+roofH;
    // Front roof face
    poly([[x,y+h,baseH+wallH],[x+w,y+h,baseH+wallH],[midX,midY,peakH]],COL.roof);
    // Back roof face
    poly([[x,y,baseH+wallH],[x+w,y,baseH+wallH],[midX,midY,peakH]],COL.roofDark);
    // Side roof edges
    poly([[x,y,baseH+wallH],[x,y+h,baseH+wallH],[midX,midY,peakH]],'#7a4524');
    poly([[x+w,y,baseH+wallH],[x+w,y+h,baseH+wallH],[midX,midY,peakH]],'#a05a30');
    // Door
    const dx=x+w*0.35, dy=y+h-0.02, dw=w*0.3, dh=0.55;
    poly([[dx,dy,baseH],[dx+dw,dy,baseH],[dx+dw,dy,baseH+dh],[dx,dy,baseH+dh]],COL.roofDark);
    // Hammer emoji on front
    const[sx,sy]=screen(x+w/2,y+h*0.55,baseH+wallH*0.55);
    g.font=Math.round(mA*1.4)+'px sans-serif';
    g.textAlign='center';g.textBaseline='middle';
    g.fillStyle=COL.ink;g.fillText('🔨',sx,sy);
  }

  function drawJetty(g,s){
    const x=s.x, y=s.y, w=s.w, h=s.h;
    // Planks along the length
    for(let j=0;j<h;j++){
      const yy=y+j;
      const top=0.18;
      // Top plank
      const p0=screen(x,yy,top), p1=screen(x+w,yy,top), p2=screen(x+w,yy+1,top), p3=screen(x,yy+1,top);
      g.beginPath();g.moveTo(p0[0],p0[1]);g.lineTo(p1[0],p1[1]);g.lineTo(p2[0],p2[1]);g.lineTo(p3[0],p3[1]);g.closePath();
      g.fillStyle=j%2?COL.jetty:COL.woodLite;g.fill();
      // Side edge
      const b0=screen(x,yy,0), b1=screen(x+w,yy,0);
      g.beginPath();g.moveTo(p0[0],p0[1]);g.lineTo(p1[0],p1[1]);g.lineTo(b1[0],b1[1]);g.lineTo(b0[0],b0[1]);g.closePath();
      g.fillStyle=COL.jettyDark;g.fill();
    }
    // Posts
    for(let j=0;j<=h;j+=2){
      for(const side of [0,w]){
        const[px,py]=screen(x+side,y+j,0.35);
        g.fillStyle=COL.jettyPost;
        g.fillRect(px-mA*0.08,py-mA*0.5,mA*0.16,mA*0.55);
      }
    }
  }

  function drawDecor(g,s){
    const[sx,sy]=screen(s.x+0.5,s.y+0.5,0.2);
    const size=Math.round(mA*1.6);
    g.font=size+'px sans-serif';
    g.textAlign='center';g.textBaseline='middle';
    // Soft ground shadow
    g.fillStyle='rgba(39,64,90,.18)';
    g.beginPath();g.ellipse(sx,sy+mA*0.15,mA*0.45,mA*0.22,0,0,6.283);g.fill();
    g.fillStyle=COL.ink;
    g.fillText(ICON[s.type]||'⬜',sx,sy-mA*0.15);
  }

  function drawStructure(g,s,selected){
    if(s.type==='workshop')drawWorkshop(g,s);
    else if(s.type==='jetty')drawJetty(g,s);
    else if(ICON[s.type])drawDecor(g,s);
    else{
      // Unknown → simple raised block
      drawTilePrism(g,s.x,s.y,'#c0c8d0','#a0a8b0','#9098a0',0.6);
    }
    if(selected){
      // Selection outline around footprint
      const pts=[[s.x,s.y],[s.x+s.w,s.y],[s.x+s.w,s.y+s.h],[s.x,s.y+s.h]];
      g.beginPath();
      pts.forEach((p,i)=>{const[sx,sy]=screen(p[0],p[1],0.25);i?g.lineTo(sx,sy):g.moveTo(sx,sy)});
      g.closePath();
      g.strokeStyle=COL.select;g.lineWidth=3;g.stroke();
    }
  }

  // ---- cloud cover for locked zones --------------------------------------
  function drawClouds(g,view){
    for(const z of view.zones){
      if(z.unlocked)continue;
      // Cover the whole zone rectangle with layered soft clouds
      const cx=z.x+z.w/2, cy=z.y+z.h/2;
      // Multiple overlapping blobs for a natural look
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
        // Soft radial-ish cloud using layered ellipses
        const rx=b.rx*mA*1.35, ry=b.ry*mA*0.75;
        // Outer soft edge
        g.globalAlpha=b.a*0.35;
        g.fillStyle=COL.cloudEdge;
        g.beginPath();g.ellipse(sx,sy,rx*1.25,ry*1.25,0,0,6.283);g.fill();
        // Mid body
        g.globalAlpha=b.a*0.7;
        g.fillStyle=COL.cloud;
        g.beginPath();g.ellipse(sx,sy,rx,ry,0,0,6.283);g.fill();
        // Highlight
        g.globalAlpha=b.a*0.55;
        g.fillStyle='#ffffff';
        g.beginPath();g.ellipse(sx-rx*0.15,sy-ry*0.25,rx*0.55,ry*0.45,0,0,6.283);g.fill();
        // Soft shadow underside
        g.globalAlpha=b.a*0.4;
        g.fillStyle=COL.cloudShade;
        g.beginPath();g.ellipse(sx+rx*0.1,sy+ry*0.3,rx*0.7,ry*0.4,0,0,6.283);g.fill();
      }
      g.globalAlpha=1;
      // Lock icon in the centre of the cloud bank
      const[lx,ly]=screen(cx,cy,1.8);
      g.font=Math.round(mA*1.8)+'px sans-serif';
      g.textAlign='center';g.textBaseline='middle';
      g.globalAlpha=0.9;
      g.fillText('🔒',lx,ly);
      g.globalAlpha=1;
    }
  }

  // ---- main draw ---------------------------------------------------------
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

    // Sky gradient background
    const grd=g.createLinearGradient(0,0,0,m.h);
    grd.addColorStop(0,'#87ceeb');grd.addColorStop(0.55,'#b8e0f0');grd.addColorStop(1,'#58b9dc');
    g.fillStyle=grd;g.fillRect(0,0,m.w,m.h);

    clampCam(view);

    // Water → land → structures (depth sorted) → clouds
    drawWater(g,view);
    drawLand(g,view);

    const structs=view.structures.slice().sort((a,b)=>(a.x+a.y+a.w/2+a.h/2)-(b.x+b.y+b.w/2+b.h/2));
    for(const s of structs)drawStructure(g,s,opts.selectedId===s.id);

    drawClouds(g,view);

    // Subtle vignette so the canvas edge feels finished
    const vig=g.createRadialGradient(m.w/2,m.h/2,m.w*0.35,m.w/2,m.h/2,m.w*0.75);
    vig.addColorStop(0,'rgba(0,0,0,0)');vig.addColorStop(1,'rgba(39,64,90,.12)');
    g.fillStyle=vig;g.fillRect(0,0,m.w,m.h);
  }

  // ---- hit test ----------------------------------------------------------
  function hit(canvas,view,cx,cy){
    if(!canvas||!view)return null;
    const r=canvas.getBoundingClientRect();
    const m=tileMetrics(canvas,view);
    mOx=m.ox;mOy=m.oy;mA=m.A;
    const mx=cx-r.left, my=cy-r.top;
    // Inverse iso: approximate tile under cursor
    // sx = ox + (dx-dy)*A    sy = oy + (dx+dy)*A/2
    // dx-dy = (sx-ox)/A      dx+dy = 2*(sy-oy)/A
    const u=(mx-m.ox)/m.A, v=2*(my-m.oy)/m.A;
    const dx=(u+v)/2, dy=(v-u)/2;
    const tx=cam.x+dx, ty=cam.y+dy;
    // Test structures from front to back
    const list=view.structures.slice().reverse();
    for(const s of list){
      if(tx>=s.x&&tx<s.x+s.w&&ty>=s.y&&ty<s.y+s.h)return s;
    }
    return null;
  }

  const info=s=>s?(INFO[s.type]||s.label):'Drag to look around · tap a building to inspect.';

  // ---- pan / scroll (clamped to unlocked area) ---------------------------
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
    // Convert screen delta → tile delta (inverse of iso)
    // We want the world to follow the finger, so camera moves opposite
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

  // Auto-centre when a new view arrives
  function drawAndBind(canvas,view,opts){
    if(view&&(!_view||_view.rev!==view.rev)){
      // First load or data changed → centre on unlocked region
      centreOnUnlocked(view);
    }
    bind(canvas);
    if(opts&&opts.selectedId!==undefined)window.__islSel=opts.selectedId;
    draw(canvas,view,opts);
  }

  window.IslandView={draw:drawAndBind,hit,info,centreOnUnlocked};
})();
