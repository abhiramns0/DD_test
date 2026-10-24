'use strict';
// Island rules + data model. PURE: no database, no sockets, no drawing. Everything the island "is" is defined here;
// island-store.js saves it, server.js moves it over the wire, public/island-view.js draws the view model returned by view().
//
// Document (stored as JSON, schema v1 — progress fields extended without a schema bump; normalize() fills defaults):
//   { v:1, unlocked:['corner'], structures:[{id,type,x,y}], nextId:n,
//     progress:{level,xp,totalXp}, awards:[string], resources:{} }
// Geometry (zone rectangles), XP tables and structure definitions live in the catalogs below, NOT in each player's
// document, so balance / layout changes never need a data migration, and new zones / structure kinds are added by
// extending the catalogs.
const SCHEMA=1,GRID={w:20,h:20},MAX_DECOR=24,MAX_STRUCTURES=200,MAX_AWARDS=48;

// ---- zones: rectangles on the grid. Only 'corner' starts unlocked (SE of the map). The rest unlock via totalXp.
// Adjacent edges share borders so terrain joins without gaps when a zone unlocks.
const ZONES={
  corner:{id:'corner',x:12,y:11,w:7,h:7,shape:'rounded',start:true,xp:0},
  basin: {id:'basin', x:6, y:10,w:6,h:7,shape:'rounded',start:false,xp:200},
  ridge: {id:'ridge', x:12,y:4, w:7,h:7,shape:'rounded',start:false,xp:500},
  wilds: {id:'wilds', x:2, y:2, w:10,h:9,shape:'rounded',start:false,xp:1000}};

// Old zone id → new id (documents created before the corner redesign)
const ZONE_ALIAS={core:'corner',north:'ridge',east:'ridge',west:'basin'};

// ---- XP catalog (configurable thresholds). levelFromXp / zonesForXp are the only places that interpret these tables.
const XP={
  // Cumulative totalXp required to *reach* experience level N. Index 0 unused; level 1 starts at 0.
  // Extend freely — players past the last entry stay on the final level until more are added.
  levels:[0,0,100,250,450,700,1000,1400,1900,2500,3200,4000,5000],
  // zone id → totalXp required to unlock (mirrors ZONES[id].xp; kept here so balance lives in one table)
  zones:{basin:200,ridge:500,wilds:1000},
  // Server-side reward formulas. Clients never submit amounts.
  rewards:{
    // Stage / level completed (escape). stage is 1-based.
    stageComplete(stage,solo){return Math.max(0,Math.floor(40+stage*15+(solo?10:0)))},
    // Bonus for time spent in the completed stage (minutes, capped).
    playMinute:6,
    maxPlayXpPerStage:48
  }
};

function levelFromXp(totalXp){
  const t=Math.max(0,Math.floor(Number(totalXp)||0));
  let lvl=1;
  for(let i=1;i<XP.levels.length;i++){if(t>=XP.levels[i])lvl=i;else break}
  return lvl}
function xpIntoLevel(totalXp){
  const t=Math.max(0,Math.floor(Number(totalXp)||0)),lvl=levelFromXp(t);
  const floor=XP.levels[lvl]||0, next=XP.levels[lvl+1];
  return{level:lvl,xp:t-floor,need:next==null?null:Math.max(0,next-floor),totalXp:t}}
function zonesForXp(totalXp){
  const t=Math.max(0,Math.floor(Number(totalXp)||0));
  return Object.values(ZONES).filter(z=>z.start||t>=(z.xp||0)).map(z=>z.id)}

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

// ---- default structures for the starting corner (Workshop, Boat Jetty, small decorative area)
function defaultStructures(){
  const s=(id,type,x,y)=>({id:'s'+id,type,x,y});
  // Jetty sits on the SE shore so its footprint touches both land and water (terrain:'shore').
  return[s(1,'workshop',13,12),s(2,'jetty',15,15),
         s(3,'palm',12,13),s(4,'palm',17,12),s(5,'palm',14,16),s(6,'rock',17,14),s(7,'flag',13,15)]}

// ---- new island
function createDefault(){
  return{v:SCHEMA,unlocked:Object.values(ZONES).filter(z=>z.start).map(z=>z.id),
    structures:defaultStructures(),nextId:8,
    progress:{level:1,xp:0,totalXp:0},awards:[],resources:{},
    sea:{islets:[],treasures:[],voyages:0,treasureCount:0}}}

// ---- load-time check / repair of a stored document. Never throws on odd data; refuses documents written by a NEWER game version
// (so an old server can never overwrite newer data).  -> {ok,doc,dropped} | {ok:false,err}
function normalize(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return{ok:false,err:'corrupt'};
  if(raw.v>SCHEMA)return{ok:false,err:'too_new'};

  // Resolve zone ids (aliases from the pre-corner layout) and always keep every start zone.
  let unlocked=[...new Set((Array.isArray(raw.unlocked)?raw.unlocked:[])
    .map(id=>typeof id==='string'?(ZONE_ALIAS[id]||id):null)
    .filter(id=>id&&ZONES[id]))];
  for(const z of Object.values(ZONES))if(z.start&&!unlocked.includes(z.id))unlocked.push(z.id);

  //added
    const rawSea=raw.sea&&typeof raw.sea==='object'&&!Array.isArray(raw.sea)?raw.sea:{};
  const sea={
    islets:Array.isArray(rawSea.islets)?rawSea.islets.filter(id=>typeof id==='string').slice(0,200):[],
    treasures:Array.isArray(rawSea.treasures)?rawSea.treasures.filter(id=>typeof id==='string').slice(0,200):[],
    voyages:isInt(rawSea.voyages)&&rawSea.voyages>=0&&rawSea.voyages<=1e6?rawSea.voyages:0,
    treasureCount:isInt(rawSea.treasureCount)&&rawSea.treasureCount>=0&&rawSea.treasureCount<=1e6?rawSea.treasureCount:0};

  // Progress: prefer totalXp; fall back to deriving from a legacy level-only document.
  const rawProg=raw.progress&&typeof raw.progress==='object'&&!Array.isArray(raw.progress)?raw.progress:{};
  let totalXp=isInt(rawProg.totalXp)&&rawProg.totalXp>=0&&rawProg.totalXp<=1e9?rawProg.totalXp:null;
  if(totalXp==null){
    const legacyLvl=isInt(rawProg.level)&&rawProg.level>=1&&rawProg.level<=999?rawProg.level:1;
    totalXp=XP.levels[Math.min(legacyLvl,XP.levels.length-1)]||0}
  // Zones unlocked by XP must be present even if an older client saved a smaller list.
  for(const id of zonesForXp(totalXp))if(!unlocked.includes(id))unlocked.push(id);
  // Drop zones the player no longer qualifies for only when they were never earned (start zones always stay).
  unlocked=unlocked.filter(id=>{const z=ZONES[id];return z&&(z.start||totalXp>=(z.xp||0))});

  const tiles=terrainGrid(unlocked),out=[];let dropped=0,maxId=0;
  for(const o of(Array.isArray(raw.structures)?raw.structures:[]).slice(0,MAX_STRUCTURES)){
    const def=o&&STRUCTURES[o.type];
    if(!def||typeof o.id!=='string'||!/^s\d{1,9}$/.test(o.id)||out.some(p=>p.id===o.id)||canStand(def,o.x,o.y,tiles,out)){dropped++;continue}
    out.push({id:o.id,type:o.type,x:o.x,y:o.y});maxId=Math.max(maxId,+o.id.slice(1))}

  // Old corner redesign: if the Workshop was lost (old coordinates no longer stand on land), reinstall the default set once.
  if(!out.some(s=>s.type==='workshop')){
    const seed=defaultStructures();
    for(const o of seed){if(canStand(STRUCTURES[o.type],o.x,o.y,tiles,out)===''){out.push(o);maxId=Math.max(maxId,+o.id.slice(1))}}
  }

  const awards=[];
  if(Array.isArray(raw.awards))for(const k of raw.awards.slice(-MAX_AWARDS)){
    if(typeof k==='string'&&k.length>0&&k.length<=80&&!awards.includes(k))awards.push(k)}

  const into=xpIntoLevel(totalXp);
  return{ok:true,dropped,doc:{v:SCHEMA,unlocked,structures:out,
    nextId:Math.max(maxId+1,isInt(raw.nextId)&&raw.nextId<1e9?raw.nextId:0),
    progress:{level:into.level,xp:into.xp,totalXp:into.totalXp},
    awards,resources:raw.resources&&typeof raw.resources==='object'&&!Array.isArray(raw.resources)?raw.resources:{}}}}

// ---- player actions. Input is untrusted: every field is checked here. -> {ok:true,doc} | {ok:false,err}
// XP is intentionally NOT an action: clients can never grant themselves XP through island:act.
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

// ---- server-only XP grant. Pure. key is a dedupe token (e.g. "stage:coop:s:3") so the same event can never pay twice.
// -> {ok:true,doc,gained,unlocked:[ids],levelUp:bool} | {ok:false,err}
function awardXp(doc,amount,key){
  if(!doc||typeof doc!=='object')return{ok:false,err:'corrupt'};
  if(!isInt(amount)||amount<=0||amount>5000)return{ok:false,err:'bad_amount'};
  if(typeof key!=='string'||key.length<3||key.length>80)return{ok:false,err:'bad_key'};
  const awards=Array.isArray(doc.awards)?doc.awards.slice(-MAX_AWARDS):[];
  if(awards.includes(key))return{ok:false,err:'duplicate'};
  const next=JSON.parse(JSON.stringify(doc));
  next.awards=awards.concat([key]).slice(-MAX_AWARDS);
  const before=next.progress&&isInt(next.progress.totalXp)?next.progress.totalXp:0;
  const totalXp=Math.min(1e9,before+amount);
  const into=xpIntoLevel(totalXp);
  next.progress={level:into.level,xp:into.xp,totalXp:into.totalXp};
  const newly=[];
  for(const id of zonesForXp(totalXp)){
    if(!next.unlocked.includes(id)){next.unlocked.push(id);newly.push(id)}}
  return{ok:true,doc:next,gained:amount,unlocked:newly,levelUp:into.level>(doc.progress&&doc.progress.level||1)}}

// Compute the XP a completed stage should grant (server calls this, then awardXp).
function stageXp(stage,solo,elapsedMs){
  const base=XP.rewards.stageComplete(Math.max(1,Math.floor(stage||1)),!!solo);
  const mins=Math.max(0,Math.floor((elapsedMs||0)/60000));
  const time=Math.min(XP.rewards.maxPlayXpPerStage,mins*XP.rewards.playMinute);
  return base+time}

// ---- view model for the renderer: plain data only, no rules needed on the client
function view(doc,rev){
  const into=xpIntoLevel(doc.progress&&doc.progress.totalXp||0);
  const nextZones=Object.values(ZONES)
    .filter(z=>!z.start&&!doc.unlocked.includes(z.id))
    .map(z=>({id:z.id,xp:z.xp||0}))
    .sort((a,b)=>a.xp-b.xp);
  return{v:SCHEMA,rev,grid:GRID,tiles:terrainGrid(doc.unlocked),
             sea:{voyages:doc.sea&&doc.sea.voyages||0,treasures:doc.sea&&doc.sea.treasureCount||0,islets:(doc.sea&&doc.sea.islets||[]).length},
    zones:Object.values(ZONES).map(z=>({id:z.id,x:z.x,y:z.y,w:z.w,h:z.h,unlocked:doc.unlocked.includes(z.id),xp:z.xp||0})),
    structures:doc.structures.map(o=>{const d=STRUCTURES[o.type];return{id:o.id,type:o.type,kind:d.kind,label:d.label,x:o.x,y:o.y,w:d.w,h:d.h,removable:d.removable}}),
    placeable:Object.values(STRUCTURES).filter(d=>d.placeable).map(d=>({type:d.type,label:d.label})),
    progress:{level:into.level,xp:into.xp,need:into.need,totalXp:into.totalXp},
    nextZones,limits:{decor:MAX_DECOR}}}

function applySeaDiscoveries(doc,disc){
  if(!doc||!disc)return{ok:false,err:'bad'};
  const next=JSON.parse(JSON.stringify(doc));
  if(!next.sea)next.sea={islets:[],treasures:[],voyages:0,treasureCount:0};
  const s=next.sea;
  if(Array.isArray(disc.islets))for(const id of disc.islets)if(typeof id==='string'&&!s.islets.includes(id))s.islets.push(id);
  if(Array.isArray(disc.treasures))for(const id of disc.treasures)if(typeof id==='string'&&!s.treasures.includes(id))s.treasures.push(id);
  if(Number.isInteger(disc.voyages)&&disc.voyages>s.voyages)s.voyages=disc.voyages;
  if(Number.isInteger(disc.treasureCount)&&disc.treasureCount>s.treasureCount)s.treasureCount=disc.treasureCount;
  s.islets=s.islets.slice(0,200);s.treasures=s.treasures.slice(0,200);
  return{ok:true,doc:next}}

module.exports={SCHEMA,GRID,ZONES,ZONE_ALIAS,STRUCTURES,XP,MAX_DECOR,MAX_AWARDS,
  createDefault,normalize,apply,awardXp,stageXp,levelFromXp,xpIntoLevel,zonesForXp,
  view,terrainGrid,canStand,defaultStructures};
