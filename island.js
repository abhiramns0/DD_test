'use strict';
// Island rules + data model. PURE: no database, no sockets, no drawing. Everything the island "is" is defined here;
// island-store.js saves it, server.js moves it over the wire, public/island-view.js draws the view model returned by view().
//
// Document (stored as JSON, schema v1):
//   { v:1, unlocked:['core'], structures:[{id,type,x,y}], nextId:n, progress:{level:1}, resources:{} }
// Geometry (zone rectangles) and structure definitions live in the catalogs below, NOT in each player's document, so
// balance / layout changes never need a data migration, and new zones / structure kinds are added by extending the catalogs.
const SCHEMA=1,GRID={w:20,h:20},MAX_DECOR=24,MAX_STRUCTURES=200;

// ---- zones: rectangles on the grid. 'core' is the starting island. The others are reserved expansion areas (nothing can unlock them yet).
const ZONES={
  core:{id:'core',x:4,y:4,w:12,h:12,shape:'rounded',start:true},
  north:{id:'north',x:6,y:0,w:8,h:4,shape:'rect'},
  east:{id:'east',x:16,y:6,w:4,h:8,shape:'rect'},
  west:{id:'west',x:0,y:6,w:4,h:8,shape:'rect'}};

// ---- structure catalog. kind groups behaviour; terrain says where it may stand ('land' = grass/sand, 'shore' = must touch both land and water).
// Reserved for later (do not exist yet): kind 'resource_node', 'powerup_station', 'weapon_facility'.
const STRUCTURES={
  workshop:{type:'workshop',kind:'building',label:'Workshop',w:3,h:3,terrain:'land',removable:false,placeable:false},
  jetty:{type:'jetty',kind:'dock',label:'Boat Jetty',w:2,h:4,terrain:'shore',removable:false,placeable:false},
  palm:{type:'palm',kind:'decor',label:'Palm tree',w:1,h:1,terrain:'land',removable:true,placeable:true},
  rock:{type:'rock',kind:'decor',label:'Rock',w:1,h:1,terrain:'land',removable:true,placeable:true},
  flag:{type:'flag',kind:'decor',label:'Flag',w:1,h:1,terrain:'land',removable:true,placeable:true},
  crate:{type:'crate',kind:'decor',label:'Crate',w:1,h:1,terrain:'land',removable:true,placeable:true}};

const isInt=n=>Number.isInteger(n);
const inRect=(r,x,y)=>x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h;
function zoneLand(z,x,y){ // is tile (x,y) land inside this zone?
  if(!inRect(z,x,y))return false;
  if(z.shape==='rounded'){const lx=x-z.x,ly=y-z.y;return Math.min(lx,z.w-1-lx)+Math.min(ly,z.h-1-ly)>=2} // cuts the corners
  return true}

// ---- terrain: 'w' water, 'g' grass, 's' sand (land next to water). Derived from the unlocked zones only.
function terrainGrid(unlocked){
  const zs=unlocked.map(id=>ZONES[id]).filter(Boolean),land=(x,y)=>x>=0&&y>=0&&x<GRID.w&&y<GRID.h&&zs.some(z=>zoneLand(z,x,y)),rows=[];
  for(let y=0;y<GRID.h;y++){let r='';for(let x=0;x<GRID.w;x++){
    if(!land(x,y))r+='w';else r+=(!land(x-1,y)||!land(x+1,y)||!land(x,y-1)||!land(x,y+1))?'s':'g'}rows.push(r)}
  return rows}

// ---- placement rules (shared by the default layout, saved-data checking and player actions)
function tilesOf(def,x,y){const t=[];for(let j=0;j<def.h;j++)for(let i=0;i<def.w;i++)t.push([x+i,y+j]);return t}
function canStand(def,x,y,tiles,others,skipId){ // -> '' when OK, otherwise the reason
  if(!isInt(x)||!isInt(y))return'bad_position';
  const fp=tilesOf(def,x,y);
  if(fp.some(([a,b])=>a<0||b<0||a>=GRID.w||b>=GRID.h))return'out_of_bounds';
  const ts=fp.map(([a,b])=>tiles[b][a]);
  if(def.terrain==='land'&&ts.some(t=>t==='w'))return'not_land';
  if(def.terrain==='shore'&&(!ts.some(t=>t!=='w')||!ts.some(t=>t==='w')))return'not_shore';
  for(const o of others){if(o.id===skipId)continue;const od=STRUCTURES[o.type];
    if(od&&x<o.x+od.w&&o.x<x+def.w&&y<o.y+od.h&&o.y<y+def.h)return'occupied'}
  return''}

// ---- new island
function createDefault(){
  const s=(id,type,x,y)=>({id:'s'+id,type,x,y});
  return{v:SCHEMA,unlocked:Object.values(ZONES).filter(z=>z.start).map(z=>z.id),
    structures:[s(1,'workshop',7,6),s(2,'jetty',9,14),                                   // the two core buildings
                s(3,'palm',5,8),s(4,'palm',13,7),s(5,'palm',6,12),s(6,'rock',12,12),s(7,'flag',11,13)], // decorative area
    nextId:8,progress:{level:1},resources:{}}}

// ---- load-time check / repair of a stored document. Never throws on odd data; refuses documents written by a NEWER game version
// (so an old server can never overwrite newer data).  -> {ok,doc,dropped} | {ok:false,err}
function normalize(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return{ok:false,err:'corrupt'};
  if(raw.v>SCHEMA)return{ok:false,err:'too_new'};
  const unlocked=[...new Set((Array.isArray(raw.unlocked)?raw.unlocked:[]).filter(id=>typeof id==='string'&&ZONES[id]))];
  for(const z of Object.values(ZONES))if(z.start&&!unlocked.includes(z.id))unlocked.push(z.id);
  const tiles=terrainGrid(unlocked),out=[];let dropped=0,maxId=0;
  for(const o of(Array.isArray(raw.structures)?raw.structures:[]).slice(0,MAX_STRUCTURES)){
    const def=o&&STRUCTURES[o.type];
    if(!def||typeof o.id!=='string'||!/^s\d{1,9}$/.test(o.id)||out.some(p=>p.id===o.id)||canStand(def,o.x,o.y,tiles,out)){dropped++;continue}
    out.push({id:o.id,type:o.type,x:o.x,y:o.y});maxId=Math.max(maxId,+o.id.slice(1))}
  const lvl=raw.progress&&isInt(raw.progress.level)&&raw.progress.level>=1&&raw.progress.level<=999?raw.progress.level:1;
  return{ok:true,dropped,doc:{v:SCHEMA,unlocked,structures:out,nextId:Math.max(maxId+1,isInt(raw.nextId)&&raw.nextId<1e9?raw.nextId:0),
    progress:{level:lvl},resources:raw.resources&&typeof raw.resources==='object'&&!Array.isArray(raw.resources)?raw.resources:{}}}}

// ---- player actions. Input is untrusted: every field is checked here. -> {ok:true,doc} | {ok:false,err}
const ACTIONS={
  place(doc,a){ // put a decoration on a free land tile of an unlocked zone
    const def=a&&typeof a.type==='string'&&STRUCTURES[a.type];if(!def||!def.placeable)return{ok:false,err:'bad_type'};
    if(doc.structures.length>=MAX_STRUCTURES||doc.structures.filter(o=>STRUCTURES[o.type].kind==='decor').length>=MAX_DECOR)return{ok:false,err:'limit'};
    const why=canStand(def,a.x,a.y,terrainGrid(doc.unlocked),doc.structures);if(why)return{ok:false,err:why};
    const next=JSON.parse(JSON.stringify(doc));next.structures.push({id:'s'+next.nextId,type:def.type,x:a.x,y:a.y});next.nextId++;return{ok:true,doc:next}},
  remove(doc,a){ // remove a decoration (buildings cannot be removed)
    const o=a&&typeof a.id==='string'&&doc.structures.find(s=>s.id===a.id);if(!o)return{ok:false,err:'not_found'};
    if(!STRUCTURES[o.type].removable)return{ok:false,err:'locked'};
    const next=JSON.parse(JSON.stringify(doc));next.structures=next.structures.filter(s=>s.id!==a.id);return{ok:true,doc:next}}};
function apply(doc,a){const f=a&&typeof a.op==='string'&&Object.prototype.hasOwnProperty.call(ACTIONS,a.op)?ACTIONS[a.op]:null;return f?f(doc,a):{ok:false,err:'bad_action'}} // a = {op:'place'|'remove', ...}

// ---- view model for the renderer: plain data only, no rules needed on the client
function view(doc,rev){
  return{v:SCHEMA,rev,grid:GRID,tiles:terrainGrid(doc.unlocked),
    zones:Object.values(ZONES).map(z=>({id:z.id,x:z.x,y:z.y,w:z.w,h:z.h,unlocked:doc.unlocked.includes(z.id)})),
    structures:doc.structures.map(o=>{const d=STRUCTURES[o.type];return{id:o.id,type:o.type,kind:d.kind,label:d.label,x:o.x,y:o.y,w:d.w,h:d.h,removable:d.removable}}),
    placeable:Object.values(STRUCTURES).filter(d=>d.placeable).map(d=>({type:d.type,label:d.label})),
    progress:doc.progress,limits:{decor:MAX_DECOR}}}

module.exports={SCHEMA,GRID,ZONES,STRUCTURES,MAX_DECOR,createDefault,normalize,apply,view,terrainGrid,canStand};
