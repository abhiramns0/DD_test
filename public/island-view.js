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

  // ---- camera: pan (drag), zoom (pinch / wheel / buttons). Zoom multiplies a fixed tile size so a bigger island is simply a bigger map.
  let cam={x:10,y:10}, zoom=1, _drag=null, _view=null, _canvas=null;
  const pts=new Map();            // active pointers (for pinch)
  let pinch=null;
  const A0=15, ZMIN=0.5, ZMAX=2.6;

  function unlockedBounds(view){
    let minX=view.grid.w, minY=view.grid.h, maxX=0, maxY=0, any=false;
    for(const z of view.zones){
      if(!z.unlocked)continue;
      any=true;
      minX=Math.min(minX,z.x); minY=Math.min(minY,z.y);
      maxX=Math.max(maxX,z.x+z.w); maxY=Math.max(maxY,z.y+z.h);
    }
    if(!any)return{minX:0,minY:0,maxX:view.grid.w,maxY:view.grid.h};
    return{minX:minX-2,minY:minY-2,maxX:maxX+2,maxY:maxY+2};
  }
  function tileMetrics(canvas,view){
    const r=canvas.getBoundingClientRect();
    return{A:A0*zoom, ox:r.width/2, oy:r.height*0.5, w:r.width, h:r.height, b:unlockedBounds(view)};
  }
  function clampCam(view){
    const b=unlockedBounds(view);
    cam.x=Math.max(b.minX,Math.min(b.maxX-0.01,cam.x));
    cam.y=Math.max(b.minY,Math.min(b.maxY-0.01,cam.y));
  }
  function centreOnUnlocked(view){
    const b=unlockedBounds(view);
    cam.x=(b.minX+b.maxX)/2; cam.y=(b.minY+b.maxY)/2;
    clampCam(view);
  }
  const hash=(x,y,k)=>{let h=(Math.imul(x|0,73856093)^Math.imul(y|0,19349663)^Math.imul(k|0,83492791))>>>0;h^=h>>>13;h=Math.imul(h,1274126177)>>>0;return(h&0xffff)/65535};

  let mOx=0, mOy=0, mA=1, mW=0, mH=0;
  function screen(tx,ty,tz){
    const dx=tx-cam.x, dy=ty-cam.y;
    return[mOx+(dx-dy)*mA, mOy+(dx+dy)*mA*0.5 - tz*mA];
  }
  const onScreen=(p,pad)=>p[0]>-pad&&p[0]<mW+pad&&p[1]>-pad*1.5&&p[1]<mH+pad*1.5;

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
  // a small box centred on a tile position (used by crates, chimneys)
  function cube(g,cx,cy,sz,h,z0,top,left,right){
    const x0=cx-sz/2,y0=cy-sz/2,x1=cx+sz/2,y1=cy+sz/2;
    const P=(x,y,z)=>screen(x,y,z);
    const poly=(a,col)=>{g.beginPath();a.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();g.fillStyle=col;g.fill()};
    poly([P(x0,y1,z0),P(x1,y1,z0),P(x1,y1,z0+h),P(x0,y1,z0+h)],left);
    poly([P(x1,y0,z0),P(x1,y1,z0),P(x1,y1,z0+h),P(x1,y0,z0+h)],right);
    poly([P(x0,y0,z0+h),P(x1,y0,z0+h),P(x1,y1,z0+h),P(x0,y1,z0+h)],top);
  }
  const ell=(g,x,y,rx,ry,col)=>{g.fillStyle=col;g.beginPath();g.ellipse(x,y,rx,ry,0,0,6.283);g.fill()};
  const shadow=(g,x,y,rx)=>ell(g,x,y,rx,rx*0.45,'rgba(39,64,90,.20)');

  // ---- sea: flat water + world-anchored wave marks (no tile seams, covers any zoom)
  function drawSea(g,view){
    const grd=g.createLinearGradient(0,0,0,mH);
    grd.addColorStop(0,'#6cc6e6');grd.addColorStop(1,'#4fb2d8');
    g.fillStyle=grd;g.fillRect(0,0,mW,mH);
    const S=70, cpx=(cam.x-cam.y)*mA, cpy=(cam.x+cam.y)*mA*0.5;
    const i0=Math.floor((cpx-mOx)/S)-1, i1=Math.ceil((cpx-mOx+mW)/S)+1, j0=Math.floor((cpy-mOy)/S)-1, j1=Math.ceil((cpy-mOy+mH)/S)+1;
    g.lineCap='round';
    for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
      if(hash(i,j,5)>0.62)continue;
      const x=mOx+(i+hash(i,j,6))*S-cpx, y=mOy+(j+hash(i,j,7))*S-cpy, w=10+hash(i,j,8)*16;
      g.strokeStyle='rgba(255,255,255,'+(0.18+hash(i,j,9)*0.22).toFixed(2)+')';g.lineWidth=Math.max(1.5,mA*0.13);
      g.beginPath();g.moveTo(x-w,y);g.quadraticCurveTo(x-w*0.4,y-w*0.28,x,y);g.quadraticCurveTo(x+w*0.4,y+w*0.28,x+w,y);g.stroke();
    }
  }

  // ---- land: shallows ring, foam, tiles, grass tufts / flowers / shells (all deterministic from the tile position)
  function drawLand(g,view,occ,ambient){
    const cells=[];
    const T=view.tiles,GW=view.grid.w,GH=view.grid.h,w=(x,y)=>x<0||y<0||x>=GW||y>=GH||T[y][x]==='w';
    for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){
      const c=T[y][x];if(c==='w')continue;
      if(!onScreen(screen(x+0.5,y+0.5,0),mA*3))continue;
      cells.push({x,y,c});
    }
    // shallows (lighter water around the coast) + foam lines
    for(const t of cells){
      if(t.c!=='s')continue;
      const x=t.x,y=t.y,p=screen(x+0.5,y+0.5,0),k=1.9;
      g.globalAlpha=0.28;g.fillStyle='#9fe3f2';
      g.beginPath();g.moveTo(p[0],p[1]-mA*0.5*k);g.lineTo(p[0]+mA*k,p[1]);g.lineTo(p[0],p[1]+mA*0.5*k);g.lineTo(p[0]-mA*k,p[1]);g.closePath();g.fill();
      g.globalAlpha=1;
    }
    g.lineCap='round';
    for(const t of cells){
      const x=t.x,y=t.y,o=0.16;
      const edge=(ax,ay,bx,by)=>{const a=screen(ax,ay,0),b=screen(bx,by,0);g.beginPath();g.moveTo(a[0],a[1]);g.lineTo(b[0],b[1]);g.stroke()};
      g.strokeStyle='rgba(255,255,255,.75)';g.lineWidth=Math.max(1.5,mA*0.14);
      if(w(x,y-1))edge(x,y-o,x+1,y-o);
      if(w(x-1,y))edge(x-o,y,x-o,y+1);
      if(w(x,y+1))edge(x,y+1+o,x+1,y+1+o);
      if(w(x+1,y))edge(x+1+o,y,x+1+o,y+1);
    }
    cells.sort((a,b)=>(a.x+a.y)-(b.x+b.y));
    const detail=mA>=9;
    for(const t of cells){
      const h=0.12,x=t.x,y=t.y;
      const alt=(x+y)%2;
      const top=t.c==='s'?(alt?'#f3e1a8':COL.sand):(alt?COL.grass2:COL.grass);
      const sideL=t.c==='s'?COL.sandDark:COL.grassDark;
      const sideR=t.c==='s'?'#cbb87a':COL.grassDark;
      drawTilePrism(g,x,y,top,sideL,sideR,h);
      if(!detail||occ.has(x+','+y))continue;
      const r=hash(x,y,1);
      if(t.c==='g'){
        const n=1+((hash(x,y,2)*3)|0);
        g.lineWidth=Math.max(1,mA*0.07);g.strokeStyle='#4f9444';g.lineCap='round';
        for(let i=0;i<n;i++){
          const p=screen(x+0.15+hash(x,y,10+i)*0.7,y+0.15+hash(x,y,20+i)*0.7,h);
          g.beginPath();g.moveTo(p[0]-mA*0.1,p[1]);g.lineTo(p[0],p[1]-mA*0.22);g.lineTo(p[0]+mA*0.1,p[1]);g.stroke();
        }
        if(r<0.17){ // wild flower
          const p=screen(x+0.3+hash(x,y,3)*0.4,y+0.3+hash(x,y,4)*0.4,h),cols=['#fff6d8','#ffd34d','#ff9fb8','#ff7b6b','#c9a6ff'];
          ell(g,p[0],p[1]-mA*0.12,mA*0.09,mA*0.07,cols[(hash(x,y,5)*5)|0]);ell(g,p[0],p[1]-mA*0.12,mA*0.03,mA*0.03,'#e8a820');
        }
      }else{
        if(r<0.28){ // sand specks / shells
          const p=screen(x+0.2+hash(x,y,3)*0.6,y+0.2+hash(x,y,4)*0.6,h);
          if(r<0.07){ell(g,p[0],p[1],mA*0.13,mA*0.08,'#fff4e6');g.strokeStyle='#e6c7b0';g.lineWidth=1;g.beginPath();g.moveTo(p[0],p[1]-mA*0.07);g.lineTo(p[0],p[1]+mA*0.07);g.stroke()}
          else ell(g,p[0],p[1],mA*0.05,mA*0.03,'#d8c283');
        }
      }
      if(ambient&&t.c==='g'){ // loose scenery that is not part of the saved island: scattered bushes, grass clumps, small stones
        const a=hash(x,y,40);
        if(a<0.045)ambient.push({d:x+y+0.5,f:()=>drawBush(g,x,y,true)});
        else if(a<0.075)ambient.push({d:x+y+0.5,f:()=>drawTallGrass(g,x,y)});
        else if(a<0.09)ambient.push({d:x+y+0.5,f:()=>drawPebbles(g,x,y)});
      }
    }
  }

  // ---- props ----
  function drawPalm(g,s){
    const A=mA,[bx,by]=screen(s.x+0.5,s.y+0.5,0.12),r=hash(s.x,s.y,1),lean=(r-0.5)*A*1.0,hg=A*2.4;
    shadow(g,bx+A*0.2,by+A*0.05,A*0.75);
    const tx=bx+lean,ty=by-hg;
    g.lineCap='round';
    g.strokeStyle='#7a4a24';g.lineWidth=Math.max(2.5,A*0.26);
    g.beginPath();g.moveTo(bx,by);g.quadraticCurveTo(bx-lean*0.2-A*0.12,by-hg*0.55,tx,ty);g.stroke();
    g.strokeStyle='#b98250';g.lineWidth=Math.max(1,A*0.1);
    g.beginPath();g.moveTo(bx+A*0.05,by);g.quadraticCurveTo(bx-lean*0.2-A*0.05,by-hg*0.55,tx+A*0.04,ty+A*0.05);g.stroke();
    g.strokeStyle='rgba(60,35,15,.45)';g.lineWidth=1;
    for(let i=1;i<6;i++){const f=i/6,px=bx+(tx-bx)*f-(lean*0.2+A*0.12)*Math.sin(f*3.14)*0.5,py=by-hg*f;g.beginPath();g.moveTo(px-A*0.1,py);g.lineTo(px+A*0.1,py);g.stroke()}
    const n=8;
    for(let i=0;i<n;i++){
      const a=i/n*6.283+r*3, len=A*(1.25+hash(s.x,s.y,30+i)*0.35), cs=Math.cos(a), sn=Math.sin(a);
      const ex=tx+cs*len, ey=ty+sn*len*0.5+A*0.3;
      g.fillStyle=i%2?'#3a9650':'#57b95e';
      g.beginPath();g.moveTo(tx,ty);
      g.quadraticCurveTo(tx+cs*len*0.5,ty+sn*len*0.3-A*0.6,ex,ey);
      g.quadraticCurveTo(tx+cs*len*0.5+sn*A*0.2,ty+sn*len*0.3-A*0.05,tx,ty);g.fill();
    }
    ell(g,tx-A*0.12,ty+A*0.16,A*0.12,A*0.12,'#6b4423');ell(g,tx+A*0.12,ty+A*0.2,A*0.12,A*0.12,'#7d5230');ell(g,tx,ty+A*0.3,A*0.11,A*0.11,'#5e3a1c');
  }
  function drawRock(g,s){
    const A=mA,[bx,by]=screen(s.x+0.5,s.y+0.5,0.12);
    shadow(g,bx,by+A*0.08,A*0.6);
    const blob=(ox,oy,rw,rh,seed,col,lit)=>{
      const pts=[];for(let i=0;i<7;i++){const a=i/7*6.283,j=0.8+hash(s.x,s.y,seed+i)*0.4;pts.push([bx+ox+Math.cos(a)*rw*j,by+oy+Math.sin(a)*rh*j-rh*0.4])}
      g.beginPath();pts.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();g.fillStyle=col;g.fill();
      g.beginPath();g.moveTo(pts[3][0],pts[3][1]);g.lineTo(pts[4][0],pts[4][1]);g.lineTo(pts[5][0],pts[5][1]);g.lineTo(pts[6][0],pts[6][1]);g.lineTo(bx+ox,by+oy);g.closePath();g.fillStyle='rgba(30,40,55,.22)';g.fill();
      ell(g,bx+ox-rw*0.25,by+oy-rh*0.95,rw*0.35,rh*0.2,lit);
    };
    blob(-A*0.28,A*0.05,A*0.42,A*0.5,50,'#9aa4ad','rgba(255,255,255,.35)');
    blob(A*0.22,A*0.12,A*0.34,A*0.38,60,'#8a949d','rgba(255,255,255,.3)');
    ell(g,bx-A*0.05,by-A*0.02,A*0.22,A*0.07,'rgba(88,160,84,.8)'); // moss
  }
  function drawFlag(g,s){
    const A=mA,[bx,by]=screen(s.x+0.5,s.y+0.5,0.12),hg=A*2.2;
    shadow(g,bx,by,A*0.4);
    ell(g,bx,by,A*0.2,A*0.1,'#8b949c');
    g.strokeStyle='#6b4a28';g.lineWidth=Math.max(2,A*0.13);g.lineCap='round';g.beginPath();g.moveTo(bx,by);g.lineTo(bx,by-hg);g.stroke();
    const w=A*1.1,hh=A*0.7,y0=by-hg;
    g.fillStyle='#e5484d';g.beginPath();g.moveTo(bx,y0);g.bezierCurveTo(bx+w*0.3,y0-hh*0.2,bx+w*0.6,y0+hh*0.25,bx+w,y0+hh*0.05);g.lineTo(bx+w*0.95,y0+hh*0.75);g.bezierCurveTo(bx+w*0.6,y0+hh*1.0,bx+w*0.3,y0+hh*0.55,bx,y0+hh*0.7);g.closePath();g.fill();
    g.fillStyle='rgba(255,255,255,.9)';g.beginPath();g.moveTo(bx+w*0.15,y0+hh*0.1);g.lineTo(bx+w*0.5,y0+hh*0.18);g.lineTo(bx+w*0.5,y0+hh*0.5);g.lineTo(bx+w*0.15,y0+hh*0.42);g.closePath();g.fill();
    ell(g,bx,y0,A*0.09,A*0.09,'#ffd34d');
  }
  function drawCrate(g,s){
    const A=mA,cx=s.x+0.5,cy=s.y+0.5;
    const[bx,by]=screen(cx,cy,0.12);shadow(g,bx,by+A*0.1,A*0.55);
    cube(g,cx,cy,0.74,0.62,0.12,'#d9a972','#b57d49','#9a6a3a');
    // plank lines + corner straps on the visible faces
    const a=screen(cx-0.37,cy+0.37,0.12+0.31),b=screen(cx+0.37,cy+0.37,0.12+0.31);
    g.strokeStyle='rgba(70,40,15,.55)';g.lineWidth=Math.max(1,A*0.06);
    g.beginPath();g.moveTo(a[0],a[1]);g.lineTo(b[0],b[1]);g.stroke();
    const c=screen(cx+0.37,cy-0.37,0.12+0.31),d=screen(cx+0.37,cy+0.37,0.12+0.31);
    g.beginPath();g.moveTo(c[0],c[1]);g.lineTo(d[0],d[1]);g.stroke();
    const t0=screen(cx-0.37,cy-0.37,0.74),t1=screen(cx+0.37,cy+0.37,0.74);g.beginPath();g.moveTo(t0[0],t0[1]);g.lineTo(t1[0],t1[1]);g.stroke();
  }
  function drawBush(g,tx,ty,small){
    const A=mA,[bx,by]=screen(tx+0.5,ty+0.5,0.12),k=small?0.7:1;
    shadow(g,bx,by+A*0.06,A*0.6*k);
    for(const[ox,oy,r,c]of[[-0.3,-0.2,0.42,'#3f9a4c'],[0.28,-0.18,0.4,'#4aa957'],[0,-0.45,0.46,'#58b963']]){ell(g,bx+ox*A*k,by+oy*A*k,r*A*k,r*A*k*0.9,c)}
    if(!small)for(let i=0;i<5;i++)ell(g,bx+(hash(tx,ty,70+i)-0.5)*A*0.8,by-A*0.25-hash(tx,ty,80+i)*A*0.5,A*0.07,A*0.07,'#e5484d');
  }
  function drawTallGrass(g,tx,ty){
    const A=mA,[bx,by]=screen(tx+0.5,ty+0.5,0.12);g.lineCap='round';g.lineWidth=Math.max(1.2,A*0.08);
    for(let i=-2;i<=2;i++){g.strokeStyle=i%2?'#4a9a44':'#5db553';g.beginPath();g.moveTo(bx+i*A*0.1,by);g.quadraticCurveTo(bx+i*A*0.14,by-A*0.3,bx+i*A*0.22,by-A*(0.5+hash(tx,ty,90+i)*0.25));g.stroke()}
  }
  function drawPebbles(g,tx,ty){
    const A=mA,[bx,by]=screen(tx+0.5,ty+0.5,0.12);
    ell(g,bx-A*0.12,by,A*0.12,A*0.08,'#9aa4ad');ell(g,bx+A*0.1,by+A*0.04,A*0.09,A*0.06,'#aab3bb');ell(g,bx,by-A*0.07,A*0.07,A*0.05,'#8a949d');
  }
  function drawFlowers(g,s){
    const A=mA,[bx,by]=screen(s.x+0.5,s.y+0.5,0.12),cols=['#ff7b9c','#ffd34d','#ffffff','#b58cff','#ff9a4d'];
    g.lineCap='round';
    for(let i=0;i<7;i++){
      const ox=(hash(s.x,s.y,100+i)-0.5)*A*1.0,oy=(hash(s.x,s.y,110+i)-0.5)*A*0.45,h=A*(0.3+hash(s.x,s.y,120+i)*0.3);
      g.strokeStyle='#3f8f48';g.lineWidth=Math.max(1,A*0.06);g.beginPath();g.moveTo(bx+ox,by+oy);g.lineTo(bx+ox,by+oy-h);g.stroke();
      ell(g,bx+ox-A*0.07,by+oy-h*0.5,A*0.08,A*0.04,'#4aa957');
      const c=cols[i%5];for(let p=0;p<5;p++){const a=p/5*6.283;ell(g,bx+ox+Math.cos(a)*A*0.07,by+oy-h+Math.sin(a)*A*0.05,A*0.06,A*0.05,c)}
      ell(g,bx+ox,by+oy-h,A*0.04,A*0.035,'#f2b51d');
    }
  }
  function drawBarrel(g,s){
    const A=mA,[bx,by]=screen(s.x+0.5,s.y+0.5,0.12),rw=A*0.4,hh=A*0.85;
    shadow(g,bx,by+A*0.05,A*0.55);
    g.fillStyle='#a66a35';g.beginPath();g.moveTo(bx-rw,by);g.quadraticCurveTo(bx-rw*1.2,by-hh*0.5,bx-rw,by-hh);g.lineTo(bx+rw,by-hh);g.quadraticCurveTo(bx+rw*1.2,by-hh*0.5,bx+rw,by);g.closePath();g.fill();
    g.fillStyle='rgba(0,0,0,.15)';g.fillRect(bx+rw*0.2,by-hh,rw*0.8,hh);
    ell(g,bx,by,rw,rw*0.42,'#8a5428');
    g.strokeStyle='#4a4f57';g.lineWidth=Math.max(1.5,A*0.09);
    for(const f of[0.22,0.75]){const y=by-hh*f;g.beginPath();g.ellipse(bx,y,rw*(f<0.5?1.04:1.04),rw*0.4,0,0,3.1416);g.stroke()}
    ell(g,bx,by-hh,rw,rw*0.42,'#c88a52');g.strokeStyle='#8a5428';g.lineWidth=1;g.beginPath();g.ellipse(bx,by-hh,rw*0.7,rw*0.28,0,0,6.283);g.stroke();
  }
  function drawLantern(g,s){
    const A=mA,[bx,by]=screen(s.x+0.5,s.y+0.5,0.12),hg=A*1.9;
    shadow(g,bx,by,A*0.35);
    g.strokeStyle='#4a3a2a';g.lineWidth=Math.max(2,A*0.12);g.lineCap='round';g.beginPath();g.moveTo(bx,by);g.lineTo(bx,by-hg);g.stroke();
    const gl=g.createRadialGradient(bx,by-hg-A*0.1,0,bx,by-hg-A*0.1,A*1.1);gl.addColorStop(0,'rgba(255,225,120,.75)');gl.addColorStop(1,'rgba(255,225,120,0)');
    g.fillStyle=gl;g.beginPath();g.arc(bx,by-hg-A*0.1,A*1.1,0,6.283);g.fill();
    g.fillStyle='#3a2e22';g.fillRect(bx-A*0.2,by-hg-A*0.38,A*0.4,A*0.08);g.fillRect(bx-A*0.2,by-hg+A*0.08,A*0.4,A*0.08);
    g.fillStyle='#ffd966';g.fillRect(bx-A*0.15,by-hg-A*0.3,A*0.3,A*0.38);
    g.fillStyle='rgba(255,255,255,.7)';g.fillRect(bx-A*0.09,by-hg-A*0.24,A*0.07,A*0.24);
  }

  // ---- buildings ----
  function drawWorkshop(g,s){
    const x=s.x, y=s.y, w=s.w, h=s.h;
    const baseH=0.15, wallH=1.1, roofH=0.55;
    function poly(pts,col){
      g.beginPath();
      pts.forEach((p,i)=>{const[sx,sy]=screen(p[0],p[1],p[2]||0);i?g.lineTo(sx,sy):g.moveTo(sx,sy)});
      g.closePath();g.fillStyle=col;g.fill();
    }
    function line(a,b,col,wd){const p=screen(a[0],a[1],a[2]),q=screen(b[0],b[1],b[2]);g.strokeStyle=col;g.lineWidth=wd;g.beginPath();g.moveTo(p[0],p[1]);g.lineTo(q[0],q[1]);g.stroke()}
    const[gx,gy]=screen(x+w/2,y+h/2,0);shadow(g,gx+mA*0.3,gy+mA*0.9,mA*w*1.05);
    poly([[x,y,baseH],[x+w,y,baseH],[x+w,y+h,baseH],[x,y+h,baseH]],COL.woodLite);
    poly([[x,y,baseH],[x,y+h,baseH],[x,y+h,baseH+wallH],[x,y,baseH+wallH]],'#9a6a3a');
    poly([[x,y+h,baseH],[x+w,y+h,baseH],[x+w,y+h,baseH+wallH],[x,y+h,baseH+wallH]],COL.wood);
    poly([[x,y,baseH],[x+w,y,baseH],[x+w,y,baseH+wallH],[x,y,baseH+wallH]],COL.woodDark);
    // plank lines on the front wall
    for(let i=1;i<7;i++)line([x+w*i/7,y+h,baseH],[x+w*i/7,y+h,baseH+wallH],'rgba(70,40,15,.28)',1);
    // corner posts
    line([x,y+h,baseH],[x,y+h,baseH+wallH],'#7a4a24',Math.max(2,mA*0.14));
    // windows (shutters + glass + cross bars)
    for(const[a,b]of[[0.1,0.3],[0.7,0.9]]){
      const wx0=x+w*a,wx1=x+w*b,z0=baseH+wallH*0.45,z1=baseH+wallH*0.85,yy=y+h+0.01;
      poly([[wx0-0.06,yy,z0-0.06],[wx1+0.06,yy,z0-0.06],[wx1+0.06,yy,z1+0.06],[wx0-0.06,yy,z1+0.06]],'#7a4a24');
      poly([[wx0,yy,z0],[wx1,yy,z0],[wx1,yy,z1],[wx0,yy,z1]],'#bfe8f5');
      line([(wx0+wx1)/2,yy,z0],[(wx0+wx1)/2,yy,z1],'#7a4a24',1.5);line([wx0,yy,(z0+z1)/2],[wx1,yy,(z0+z1)/2],'#7a4a24',1.5);
    }
    const midX=x+w/2, midY=y+h/2, peakH=baseH+wallH+roofH;
    poly([[x,y+h,baseH+wallH],[x+w,y+h,baseH+wallH],[midX,midY,peakH]],COL.roof);
    poly([[x,y,baseH+wallH],[x+w,y,baseH+wallH],[midX,midY,peakH]],COL.roofDark);
    poly([[x,y,baseH+wallH],[x,y+h,baseH+wallH],[midX,midY,peakH]],'#7a4524');
    poly([[x+w,y,baseH+wallH],[x+w,y+h,baseH+wallH],[midX,midY,peakH]],'#a05a30');
    // roof shingle rows
    for(let i=1;i<4;i++){const f=i/4;line([x+w*(f*0.5),y+h-h*f*0.5,baseH+wallH+roofH*f],[x+w-w*f*0.5,y+h-h*f*0.5,baseH+wallH+roofH*f],'rgba(40,20,8,.3)',1)}
    // chimney + smoke
    cube(g,x+w*0.74,y+h*0.42,0.42,0.8,baseH+wallH+0.1,'#6d6a68','#8c8784','#7b7673');
    const[cx,cy]=screen(x+w*0.74,y+h*0.42,baseH+wallH+0.95);
    for(let i=0;i<3;i++){g.globalAlpha=0.5-i*0.14;ell(g,cx+i*mA*0.2,cy-i*mA*0.45,mA*(0.2+i*0.1),mA*(0.16+i*0.08),'#eef2f6')}
    g.globalAlpha=1;
    // door
    const dx=x+w*0.35, dy=y+h-0.02, dw=w*0.3, dh=0.62;
    poly([[dx-0.05,dy,baseH],[dx+dw+0.05,dy,baseH],[dx+dw+0.05,dy,baseH+dh+0.05],[dx-0.05,dy,baseH+dh+0.05]],'#6a3f1e');
    poly([[dx,dy,baseH],[dx+dw,dy,baseH],[dx+dw,dy,baseH+dh],[dx,dy,baseH+dh]],COL.roofDark);
    line([dx+dw/2,dy,baseH],[dx+dw/2,dy,baseH+dh],'rgba(255,255,255,.12)',1);
    const[kx,ky]=screen(dx+dw*0.8,dy,baseH+dh*0.45);ell(g,kx,ky,mA*0.05,mA*0.05,'#ffd34d');
    // step
    poly([[dx-0.1,dy+0.22,baseH],[dx+dw+0.1,dy+0.22,baseH],[dx+dw+0.1,dy+0.22,baseH+0.07],[dx-0.1,dy+0.22,baseH+0.07]],'#a38b6a');
    // hanging sign
    const[sx,sy]=screen(x+w/2,y+h*0.55,baseH+wallH*0.55+0.55);
    g.font=Math.round(mA*1.3)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillStyle=COL.ink;g.fillText('🔨',sx,sy-mA*0.4);
  }

  function drawJetty(g,s){
    const x=s.x, y=s.y, w=s.w, h=s.h;
    for(let j=0;j<h;j++){
      const yy=y+j, top=0.18;
      const p0=screen(x,yy,top), p1=screen(x+w,yy,top), p2=screen(x+w,yy+1,top), p3=screen(x,yy+1,top);
      g.beginPath();g.moveTo(p0[0],p0[1]);g.lineTo(p1[0],p1[1]);g.lineTo(p2[0],p2[1]);g.lineTo(p3[0],p3[1]);g.closePath();
      g.fillStyle=j%2?COL.jetty:COL.woodLite;g.fill();
      g.strokeStyle='rgba(70,40,15,.3)';g.lineWidth=1;g.stroke();
      const b0=screen(x,yy,0), b1=screen(x+w,yy,0);
      g.beginPath();g.moveTo(p0[0],p0[1]);g.lineTo(p1[0],p1[1]);g.lineTo(b1[0],b1[1]);g.lineTo(b0[0],b0[1]);g.closePath();
      g.fillStyle=COL.jettyDark;g.fill();
    }
    for(let j=0;j<=h;j+=2){
      for(const side of [0,w]){
        const[px,py]=screen(x+side,y+j,0.35);
        g.fillStyle=COL.jettyPost;
        g.fillRect(px-mA*0.08,py-mA*0.5,mA*0.16,mA*0.55);
        ell(g,px,py-mA*0.5,mA*0.1,mA*0.05,'#8a6236');
      }
    }
    // rope between the last posts, lantern + barrels
    const r0=screen(x,y+h,0.5),r1=screen(x+w,y+h,0.5);g.strokeStyle='#d8c08a';g.lineWidth=Math.max(1,mA*0.06);g.beginPath();g.moveTo(r0[0],r0[1]);g.quadraticCurveTo((r0[0]+r1[0])/2,(r0[1]+r1[1])/2+mA*0.35,r1[0],r1[1]);g.stroke();
    drawLantern(g,{x:x+w-1,y:y+h-1});
    drawBarrel(g,{x:x,y:y});
    drawDockedBoat(g, x+w*0.5, y+h+0.6);
  }

  function drawDockedBoat(g,tx,ty){
    const[sx,sy]=screen(tx,ty,0.25);
    const A=mA;
    ell(g,sx,sy+A*0.5,A*1.1,A*0.3,'rgba(255,255,255,.35)'); // ripples
    g.save();g.translate(sx,sy);
    g.fillStyle=COL.boat;
    g.beginPath();g.moveTo(0,-A*0.55);g.lineTo(A*0.9,A*0.15);g.lineTo(A*0.55,A*0.45);g.lineTo(-A*0.55,A*0.45);g.lineTo(-A*0.9,A*0.15);g.closePath();g.fill();
    g.fillStyle=COL.jettyDark;
    g.beginPath();g.moveTo(0,-A*0.55);g.lineTo(A*0.9,A*0.15);g.lineTo(A*0.55,A*0.45);g.lineTo(-A*0.55,A*0.45);g.lineTo(-A*0.9,A*0.15);g.closePath();g.lineWidth=1.5;g.stroke();
    g.strokeStyle='rgba(70,40,15,.4)';g.lineWidth=1;g.beginPath();g.moveTo(-A*0.7,A*0.2);g.lineTo(A*0.7,A*0.2);g.stroke();
    g.strokeStyle=COL.ink;g.lineWidth=2;g.beginPath();g.moveTo(0,A*0.1);g.lineTo(0,-A*1.1);g.stroke();
    g.fillStyle=COL.boatSail;
    g.beginPath();g.moveTo(0,-A*1.05);g.lineTo(A*0.7,-A*0.35);g.lineTo(0,-A*0.2);g.closePath();g.fill();
    g.fillStyle='#e5484d';g.beginPath();g.moveTo(0,-A*1.1);g.lineTo(A*0.3,-A*1.0);g.lineTo(0,-A*0.9);g.closePath();g.fill();
    g.restore();
  }

  const DRAW={palm:drawPalm,rock:drawRock,flag:drawFlag,crate:drawCrate,bush:(g,s)=>drawBush(g,s.x,s.y,false),flowers:drawFlowers,barrel:drawBarrel,lantern:drawLantern};
  function drawDecor(g,s){
    const f=DRAW[s.type];
    if(f){f(g,s);return}
    const[sx,sy]=screen(s.x+0.5,s.y+0.5,0.2);
    g.font=Math.round(mA*1.6)+'px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillStyle=COL.ink;
    g.fillText(ICON[s.type]||'⬜',sx,sy-mA*0.15);
  }

  function drawStructure(g,s,selected){
    if(s.type==='workshop')drawWorkshop(g,s);
    else if(s.type==='jetty')drawJetty(g,s);
    else if(DRAW[s.type]||ICON[s.type])drawDecor(g,s);
    else drawTilePrism(g,s.x,s.y,'#c0c8d0','#a0a8b0','#9098a0',0.6);
    if(selected){
      const pp=[[s.x,s.y],[s.x+s.w,s.y],[s.x+s.w,s.y+s.h],[s.x,s.y+s.h]];
      g.beginPath();
      pp.forEach((p,i)=>{const[sx,sy]=screen(p[0],p[1],0.25);i?g.lineTo(sx,sy):g.moveTo(sx,sy)});
      g.closePath();
      g.strokeStyle=COL.select;g.lineWidth=3;g.stroke();
    }
  }

  function drawClouds(g,view){
    for(const z of view.zones){
      if(z.unlocked)continue;
      const cx=z.x+z.w/2, cy=z.y+z.h/2;
      if(!onScreen(screen(cx,cy,0),mA*(z.w+z.h)))continue;
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
      g.font=Math.round(Math.min(mA*2.4,64))+'px sans-serif';
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
    mOx=m.ox;mOy=m.oy;mA=m.A;mW=m.w;mH=m.h;
    g.setTransform(dpr,0,0,dpr,0,0);
    g.clearRect(0,0,m.w,m.h);
    clampCam(view);
    drawSea(g,view);

    const occ=new Set();
    for(const s of view.structures)for(let j=0;j<s.h;j++)for(let i=0;i<s.w;i++)occ.add((s.x+i)+','+(s.y+j));
    const items=[];
    drawLand(g,view,occ,items);
    for(const s of view.structures){
      if(!onScreen(screen(s.x+s.w/2,s.y+s.h/2,0),mA*6))continue;
      items.push({d:s.x+s.y+s.w/2+s.h/2,f:()=>drawStructure(g,s,opts.selectedId===s.id)});
    }
    items.sort((a,b)=>a.d-b.d);
    for(const it of items)it.f();
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
      // tall things (palms, buildings) are tapped by their body, not just the ground tile under them
      const tall=s.type==='palm'?2.0:s.type==='workshop'?1.2:s.type==='flag'||s.type==='lantern'?1.6:0.5;
      for(let lift=0;lift<=tall;lift+=0.5){
        const lx=tx+lift,ly=ty+lift; // moving up on screen = moving toward smaller x and y in tile space
        if(lx>=s.x&&lx<s.x+s.w&&ly>=s.y&&ly<s.y+s.h)return s;
      }
    }
    return null;
  }

  const info=s=>s?(INFO[s.type]||s.label):'Drag to look around · pinch or use + / − to zoom · Sail Out from the jetty anytime.';

  const redraw=()=>{if(_canvas&&_view)draw(_canvas,_view,{selectedId:window.__islSel||''})};
  function setZoom(z){zoom=Math.max(ZMIN,Math.min(ZMAX,z));redraw()}
  function zoomBy(f){setZoom(zoom*f)}
  function recenter(){if(_view){centreOnUnlocked(_view);zoom=1;redraw()}}

  function onPointerDown(e){
    if(!_canvas||!_view)return;
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    try{_canvas.setPointerCapture(e.pointerId)}catch(_){}
    if(pts.size===2){ // second finger: switch from dragging to pinching
      const[a,b]=[...pts.values()];
      pinch={d:Math.hypot(a.x-b.x,a.y-b.y)||1,z:zoom};_drag=null;
    }else if(pts.size===1){
      _drag={id:e.pointerId,x:e.clientX,y:e.clientY,cx:cam.x,cy:cam.y,moved:false};
    }
  }
  function onPointerMove(e){
    if(!_view||!pts.has(e.pointerId))return;
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pinch&&pts.size>=2){
      const[a,b]=[...pts.values()];
      setZoom(pinch.z*Math.hypot(a.x-b.x,a.y-b.y)/pinch.d);
      return;
    }
    if(!_drag||_drag.id!==e.pointerId)return;
    const m=tileMetrics(_canvas,_view);
    const dx=e.clientX-_drag.x, dy=e.clientY-_drag.y;
    if(Math.hypot(dx,dy)>4)_drag.moved=true;
    cam.x=_drag.cx-(dx/(2*m.A)+dy/m.A);
    cam.y=_drag.cy-(-dx/(2*m.A)+dy/m.A);
    clampCam(_view);
    redraw();
  }
  function onPointerUp(e){
    pts.delete(e.pointerId);
    if(pts.size<2)pinch=null;
    if(_drag&&_drag.id===e.pointerId)_drag=null;
    if(pts.size===1){ // lifted one finger of a pinch: carry on dragging with the other
      const[id,p]=[...pts.entries()][0];_drag={id,x:p.x,y:p.y,cx:cam.x,cy:cam.y,moved:true};
    }
  }
  function onWheel(e){
    if(!_view)return;e.preventDefault();
    zoomBy(Math.exp(-e.deltaY*0.0016));
  }

  function bind(canvas){
    if(!canvas||canvas.__islBound)return;
    canvas.__islBound=true;
    canvas.style.touchAction='none';
    canvas.addEventListener('pointerdown',onPointerDown);
    canvas.addEventListener('pointermove',onPointerMove);
    canvas.addEventListener('pointerup',onPointerUp);
    canvas.addEventListener('pointercancel',onPointerUp);
    canvas.addEventListener('wheel',onWheel,{passive:false});
  }

  function drawAndBind(canvas,view,opts){
    if(view&&(!_view||_view.rev!==view.rev)){
      if(!_view)centreOnUnlocked(view);else clampCam(view); // keep the player's camera when the data changes
    }
    bind(canvas);
    if(opts&&opts.selectedId!==undefined)window.__islSel=opts.selectedId;
    draw(canvas,view,opts);
  }

  window.IslandView={draw:drawAndBind,hit,info,centreOnUnlocked,zoomBy,recenter};
})();
