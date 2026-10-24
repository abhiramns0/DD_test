'use strict';
// Island RENDERER. It only draws the view model that the server builds (island.js > view()) and answers "what is under this tap?".
// It contains no island rules and no networking, so layouts / structures can change on the server without touching this file
// (unknown structure types are simply drawn as a plain block).
(function(){
  const COL={water:'#58b9dc',water2:'#4aaed3',grass:'#7ccf6e',grass2:'#72c565',sand:'#f2dfa5',ink:'#27405a'};
  const ICON={palm:'🌴',rock:'🪨',flag:'🚩',crate:'📦'};
  const INFO={workshop:'Workshop — crafting is coming soon.',jetty:'Boat Jetty — sailing is coming soon.'};
  function metrics(canvas,view){const r=canvas.getBoundingClientRect(),size=Math.min(r.width,r.height),t=size/Math.max(view.grid.w,view.grid.h);return{t,ox:(r.width-t*view.grid.w)/2,oy:(r.height-t*view.grid.h)/2,w:r.width,h:r.height}}
  function draw(canvas,view,opts){
    opts=opts||{};if(!canvas||!view)return;
    const dpr=Math.min(2,window.devicePixelRatio||1),r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;
    if(canvas.width!==Math.round(r.width*dpr)||canvas.height!==Math.round(r.height*dpr)){canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr)}
    const g=canvas.getContext('2d'),m=metrics(canvas,view),t=m.t;g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,m.w,m.h);
    g.fillStyle=COL.water;g.fillRect(m.ox,m.oy,t*view.grid.w,t*view.grid.h);
    g.fillStyle=COL.water2;for(let y=0;y<view.grid.h;y++)for(let x=0;x<view.grid.w;x++)if(view.tiles[y][x]==='w'&&(x+y)%2===0)g.fillRect(m.ox+x*t,m.oy+y*t,t,t);
    for(let y=0;y<view.grid.h;y++)for(let x=0;x<view.grid.w;x++){const c=view.tiles[y][x];if(c==='w')continue;
      g.fillStyle=c==='s'?COL.sand:((x+y)%2?COL.grass2:COL.grass);g.fillRect(m.ox+x*t,m.oy+y*t,t+.5,t+.5)}
    g.setLineDash([t*.3,t*.2]);g.lineWidth=2;g.strokeStyle='rgba(255,255,255,.7)';g.fillStyle='rgba(255,255,255,.85)';g.textAlign='center';g.textBaseline='middle';g.font=Math.round(t*.8)+'px sans-serif';
    for(const z of view.zones)if(!z.unlocked){g.strokeRect(m.ox+z.x*t+2,m.oy+z.y*t+2,z.w*t-4,z.h*t-4);g.fillText('🔒',m.ox+(z.x+z.w/2)*t,m.oy+(z.y+z.h/2)*t)}
    g.setLineDash([]);
    for(const s of view.structures){const x=m.ox+s.x*t,y=m.oy+s.y*t,w=s.w*t,h=s.h*t;
      if(s.type==='workshop'){g.fillStyle='#b9794a';g.fillRect(x+t*.1,y+h*.3,w-t*.2,h*.65);g.fillStyle='#8a4f2c';g.beginPath();g.moveTo(x,y+h*.34);g.lineTo(x+w/2,y+t*.05);g.lineTo(x+w,y+h*.34);g.closePath();g.fill();
        g.fillStyle='#5a3418';g.fillRect(x+w/2-t*.25,y+h*.62,t*.5,h*.33);g.font=Math.round(t*.9)+'px sans-serif';g.fillStyle=COL.ink;g.fillText('🔨',x+w*.5,y+h*.5)}
      else if(s.type==='jetty'){g.fillStyle='#c89a62';g.fillRect(x+t*.1,y,w-t*.2,h);g.strokeStyle='#8a6236';g.lineWidth=2;for(let k=1;k<s.h;k++){g.beginPath();g.moveTo(x+t*.1,y+k*t);g.lineTo(x+w-t*.1,y+k*t);g.stroke()}
        g.fillStyle='#6b4a28';g.fillRect(x+t*.1,y,t*.12,h);g.fillRect(x+w-t*.22,y,t*.12,h)}
      else if(ICON[s.type]){g.font=Math.round(t*.95)+'px sans-serif';g.fillStyle=COL.ink;g.fillText(ICON[s.type],x+w/2,y+h/2+t*.05)}
      else{g.fillStyle='#c0c8d0';g.fillRect(x+2,y+2,w-4,h-4)} // unknown (newer) structure type: plain block
      if(opts.selectedId===s.id){g.strokeStyle='#fff';g.lineWidth=3;g.strokeRect(x+1,y+1,w-2,h-2)}}
  }
  function hit(canvas,view,cx,cy){ // client coordinates -> structure under the tap (or null)
    if(!canvas||!view)return null;const r=canvas.getBoundingClientRect(),m=metrics(canvas,view),tx=Math.floor((cx-r.left-m.ox)/m.t),ty=Math.floor((cy-r.top-m.oy)/m.t);
    for(const s of view.structures)if(tx>=s.x&&tx<s.x+s.w&&ty>=s.y&&ty<s.y+s.h)return s;return null}
  const info=s=>s?(INFO[s.type]||s.label):'Tap a building to look at it.';
  window.IslandView={draw,hit,info};
})();
