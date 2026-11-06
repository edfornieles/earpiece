// Live tracking and floor calibration for the Room page.
// People are found in the live picture by a detector that runs in this browser; pictures never leave
// this computer. Only boxes go to the server, which turns feet positions into floor metres using the
// camera's floor calibration and keeps who-is-who as the desk confirmed it.
(()=>{
const {$,esc,api,toast}=Setup;
const SCRIPTS=['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js','https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'];
const DETECT_EVERY_MS=200,SEND_EVERY_MS=400,MIN_SCORE=0.45,OBJECT_MIN_SCORE=0.2,KEEP_UNMATCHED_MS=2500,SNAP_M=0.15;
// Furniture the detector knows. Anything else (rugs, artworks, rolls of paper) is marked by hand on the plan.
const FURNITURE=new Set(['chair','couch','bench','dining table','suitcase','backpack','handbag','potted plant','tv']);
const ANIMALS=new Set(['dog','cat']);
let lastAnimals=[],lastObjects=[],objectChoice=new Map(),dismissedObjects=new Set();
const tracker=Math.random().toString(36).slice(2,10);
const chosen=new Map();
let model=null,running=false,timer=0,lastSent=0,sending=false,nextId=1,local=[],state=null,dismissed=new Set(),stats={ms:0,fps:0,frames:0,since:0};
let calibrating=false,pairs=[],awaiting='image',showOutline=true,home=null;
function endCalibration(){calibrating=false;pairs=[];if(home){home.parent.insertBefore($('floor-plan'),home.next);home=null;}}
const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
const camera=()=>$('camera').value;
const calibration=()=>room?.calibrations?.[camera()]||null;
const plan=()=>room?.floorPlan||null;
const t=ms=>new Date(ms).toLocaleTimeString();

// ---------- detector ----------
function loadScript(src){return new Promise((ok,fail)=>{if(document.querySelector(`script[src="${src}"]`))return ok();const s=document.createElement('script');s.src=src;s.crossOrigin='anonymous';s.onload=ok;s.onerror=()=>fail(Error('Could not load the person detector. This Mac needs an internet connection the first time.'));document.head.append(s);});}
async function loadModel(){if(model)return model;for(const s of SCRIPTS)await loadScript(s);model=await window.cocoSsd.load({base:'mobilenet_v2'});return model;}
const iou=(a,b)=>{const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y),x2=Math.min(a.x+a.w,b.x+b.w),y2=Math.min(a.y+a.h,b.y+b.h),i=Math.max(0,x2-x1)*Math.max(0,y2-y1);return i/(a.w*a.h+b.w*b.h-i||1);};
const centre=b=>[b.x+b.w/2,b.y+b.h/2];
// Greedy matching: best overlap first, then nearest centre for fast movers.
function associate(dets,now){
  const pairsList=[];
  local.forEach((tr,i)=>dets.forEach((d,j)=>{const o=iou(tr.box,d.box),[ax,ay]=centre(tr.box),[bx,by]=centre(d.box),dist=Math.hypot(ax-bx,ay-by);if(o>0.15||dist<0.18)pairsList.push({i,j,score:o-dist});}));
  pairsList.sort((a,b)=>b.score-a.score);
  const usedT=new Set(),usedD=new Set();
  for(const p of pairsList){if(usedT.has(p.i)||usedD.has(p.j))continue;usedT.add(p.i);usedD.add(p.j);const tr=local[p.i],d=dets[p.j];
    tr.box={x:tr.box.x*0.4+d.box.x*0.6,y:tr.box.y*0.4+d.box.y*0.6,w:tr.box.w*0.4+d.box.w*0.6,h:tr.box.h*0.4+d.box.h*0.6};tr.score=d.score;tr.seen=now;tr.hits++;}
  dets.forEach((d,j)=>{if(!usedD.has(j))local.push({id:'T'+nextId++,box:d.box,score:d.score,seen:now,hits:1});});
  local=local.filter(tr=>now-tr.seen<KEEP_UNMATCHED_MS);
}
async function step(){
  if(!running)return;
  const img=$('live-picture'),started=performance.now();
  try{
    if(img.complete&&img.naturalWidth){
      canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;ctx.drawImage(img,0,0);
      const found=await model.detect(canvas,30,OBJECT_MIN_SCORE),W=canvas.width,H=canvas.height,now=Date.now();
      lastAnimals=found.filter(f=>ANIMALS.has(f.class)).map(f=>({cls:f.class,score:f.score,box:{x:f.bbox[0]/W,y:f.bbox[1]/H,w:f.bbox[2]/W,h:f.bbox[3]/H}}));
      lastObjects=found.filter(f=>FURNITURE.has(f.class)).map(f=>({cls:f.class,score:f.score,box:{x:f.bbox[0]/W,y:f.bbox[1]/H,w:f.bbox[2]/W,h:f.bbox[3]/H}}));
      const dets=found.filter(f=>f.class==='person'&&f.score>=MIN_SCORE).map(f=>({score:f.score,box:{x:f.bbox[0]/W,y:f.bbox[1]/H,w:f.bbox[2]/W,h:f.bbox[3]/H}}));
      associate(dets,now);
      stats.ms=Math.round(performance.now()-started);stats.frames++;if(now-stats.since>2000){stats.fps=Math.round(stats.frames*10000/(now-stats.since))/10;stats.frames=0;stats.since=now;}
      if(now-lastSent>=SEND_EVERY_MS)send(now);
      drawLive();
    }
  }catch(e){stop(e.message);return;}
  timer=setTimeout(step,Math.max(0,DETECT_EVERY_MS-(performance.now()-started)));
}
async function send(now){
  if(sending)return;sending=true;lastSent=now;
  const tracks=local.filter(tr=>tr.hits>=2&&now-tr.seen<400).map(tr=>({id:tr.id,box:tr.box,score:tr.score,feetVisible:tr.box.y+tr.box.h<0.97}));
  try{state=await api('room',{action:'track',tracker,cameraId:camera(),tracks,objects:lastObjects,animals:lastAnimals});renderPanel();}
  catch(e){stop(e.message);}finally{sending=false;}
}
async function start(){
  if(running)return;$('track-start').disabled=true;$('tracking-state').textContent='Loading detector…';
  try{await loadModel();}catch(e){$('track-start').disabled=false;$('tracking-state').textContent='Tracking off';return toast(e.message);}
  local=[];nextId=1;running=true;stats={ms:0,fps:0,frames:0,since:Date.now()};renderPanel();step();
}
function stop(message){
  const was=running;running=false;clearTimeout(timer);local=[];drawLive();
  if(was)api('room',{action:'stopTracking',tracker}).then(v=>{state=v;renderPanel();}).catch(()=>{});
  if(message)toast(message);renderPanel();
}

// ---------- live picture overlay ----------
function drawLive(){
  const svg=$('track-overlay');if(!svg)return;
  svg.toggleAttribute('hidden',$('live-picture').hidden);svg.classList.toggle('calibrating',calibrating);
  const byId=new Map((state?.tracks||[]).map(x=>[x.id,x]));
  const boxes=running?local.filter(tr=>tr.hits>=2).map(tr=>{const s=byId.get(tr.id),label=s?.binding?.label||tr.id;return `<g class="${s?.binding?'bound':''}"><rect x="${tr.box.x*1000}" y="${tr.box.y*1000}" width="${tr.box.w*1000}" height="${tr.box.h*1000}"/><circle cx="${(tr.box.x+tr.box.w/2)*1000}" cy="${(tr.box.y+tr.box.h)*1000}" r="6"/><text x="${tr.box.x*1000+6}" y="${Math.max(24,tr.box.y*1000+24)}">${esc(label)}${s?.area&&s.area!=='unknown'?' · '+esc(s.area):''}</text></g>`;}).join(''):'';
  let outline='';
  const cal=calibration(),p=plan();
  if(cal&&p&&showOutline&&!calibrating){
    const Hi=invert(cal.H),proj=pt=>{const q=project(Hi,pt);return q&&q.every(v=>v>-0.5&&v<1.5)?q:null;};
    const poly=(pts,cls)=>{const seg=[];for(let i=0;i<pts.length;i++){const a=proj(pts[i]),b=proj(pts[(i+1)%pts.length]);if(a&&b)seg.push(`<line class="${cls}" x1="${a[0]*1000}" y1="${a[1]*1000}" x2="${b[0]*1000}" y2="${b[1]*1000}"/>`);}return seg.join('');};
    const edge=(a,b)=>{const out=[];for(let k=0;k<=10;k++)out.push([a[0]+(b[0]-a[0])*k/10,a[1]+(b[1]-a[1])*k/10]);return out;};
    const room4=[[0,0],[p.widthM,0],[p.widthM,p.depthM],[0,p.depthM]];
    // Densify edges so a wall that runs partly out of view still draws its visible part.
    outline=poly(room4.flatMap((a,i)=>edge(a,room4[(i+1)%4]).slice(0,-1)),'floor-edge')+(p.footprints||[]).map(o=>poly(o.points.flatMap((a,i)=>edge(a,o.points[(i+1)%o.points.length]).slice(0,-1)),'floor-object')).join('');
  }
  const marks=calibrating?pairs.map((q,i)=>q.image?`<g class="calib"><circle cx="${q.image[0]*1000}" cy="${q.image[1]*1000}" r="9"/><text x="${q.image[0]*1000+12}" y="${q.image[1]*1000-10}">${i+1}</text></g>`:'').join(''):'';
  const furn=(state?.objects||[]).filter(o=>o.visible&&o.box).map(o=>`<g class="furniture${o.binding?' bound':''}"><rect x="${o.box.x*1000}" y="${o.box.y*1000}" width="${o.box.w*1000}" height="${o.box.h*1000}"/><text x="${o.box.x*1000+6}" y="${o.box.y*1000+22}">${esc(o.binding?.footprint||o.cls+' '+o.id)}</text></g>`).join('');
  const pets=(state?.animals||[]).filter(a=>a.visible&&a.box).map(a=>`<g class="animal"><rect x="${a.box.x*1000}" y="${a.box.y*1000}" width="${a.box.w*1000}" height="${a.box.h*1000}"/><text x="${a.box.x*1000+6}" y="${a.box.y*1000+22}">${esc(a.name)}${a.area&&a.area!=='unknown'?' · '+esc(a.area):''}</text></g>`).join('');
  svg.innerHTML=outline+furn+pets+boxes+marks;
  drawPlan();
}
function project(H,[x,y]){const w=H[6]*x+H[7]*y+H[8];if(!(w>1e-9))return null;return [(H[0]*x+H[1]*y+H[2])/w,(H[3]*x+H[4]*y+H[5])/w];}
function invert(H){const [a,b,c,d,e,f,g,h,i]=H,A=e*i-f*h,B=-(d*i-f*g),C=d*h-e*g,det=a*A+b*B+c*C;return [A,-(b*i-c*h),b*f-c*e,B,a*i-c*g,-(a*f-c*d),C,-(a*h-b*g),a*e-b*d].map(v=>v/det);}

// ---------- floor plan layer ----------
function drawPlan(){
  const svg=$('test-map');if(!svg)return;
  let layer=svg.querySelector('#live-layer');if(!layer){layer=document.createElementNS('http://www.w3.org/2000/svg','g');layer.id='live-layer';svg.append(layer);}
  const p=plan(),u=p?Math.max(p.widthM,p.depthM)/220:0.02;
  const people=(state?.tracks||[]).filter(x=>x.floor&&(running||x.binding)).map(x=>`<g class="live-person${x.visible?'':' last-seen'}${x.binding?' bound':''}" transform="translate(${x.floor[0]} ${x.floor[1]})"><circle r="${7*u}"/><text x="${10*u}" y="${4*u}">${esc(x.binding?.role||x.binding?.label||x.id)}</text></g>`).join('');
  const marks=calibrating?pairs.map((q,i)=>q.floor?`<g class="calib" transform="translate(${q.floor[0]} ${q.floor[1]})"><circle r="${5*u}"/><text x="${7*u}" y="${-5*u}">${i+1}</text></g>`:'').join(''):'';
  const furn=(state?.objects||[]).map(o=>`<g class="live-object${o.visible?'':' last-seen'}${o.binding?' bound':''}" transform="translate(${o.floor[0]} ${o.floor[1]})"><rect x="${-5*u}" y="${-5*u}" width="${10*u}" height="${10*u}"/><text x="${8*u}" y="${4*u}">${esc(o.binding?.footprint||o.cls)}</text></g>`).join('');
  const pets=(state?.animals||[]).filter(a=>a.floor).map(a=>`<g class="live-animal${a.visible?'':' last-seen'}" transform="translate(${a.floor[0]} ${a.floor[1]})"><circle r="${5*u}"/><text x="${8*u}" y="${4*u}">${esc(a.name)}</text></g>`).join('');
  layer.innerHTML=furn+pets+people+marks;
}

// ---------- calibration ----------
function snap(pt){
  const p=plan();if(!p)return {pt,label:''};
  const corners=[...(p.footprints||[]).flatMap(o=>o.points.map((q,i)=>({q,label:`${o.name} corner ${i+1}`}))),...[[0,0],[p.widthM,0],[p.widthM,p.depthM],[0,p.depthM]].map((q,i)=>({q,label:`Room corner ${i+1}`})),...(p.doors||[]).filter(d=>d.offsetM!==null&&d.wall==='bottom').flatMap(d=>[{q:[d.offsetM,p.depthM],label:`${d.name} left edge`},{q:[d.offsetM+d.widthM,p.depthM],label:`${d.name} right edge`}])];
  let best=null;for(const c of corners){const dist=Math.hypot(c.q[0]-pt[0],c.q[1]-pt[1]);if(dist<=SNAP_M&&(!best||dist<best.dist))best={...c,dist};}
  return best?{pt:best.q.slice(),label:best.label}:{pt,label:''};
}
function beginCalibration(){
  if(!plan())return toast('Save the measured floor plan first.');
  calibrating=true;pairs=(calibration()?.points||[]).map(q=>({...q}));awaiting='image';
  // Bring the plan next to the picture while calibrating, so both clicks are on screen together.
  const planEl=$('floor-plan');home={parent:planEl.parentNode,next:planEl.nextSibling};$('calibration-plan').append(planEl);
  if($('live-picture').hidden)$('view-live').click();
  renderPanel();drawLive();
}
function onPicture(e){
  if(!calibrating||awaiting!=='image')return;
  const r=$('live-picture').getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
  if(x<0||x>1||y<0||y>1)return;
  pairs.push({image:[x,y],floor:null,label:''});awaiting='floor';renderPanel();drawLive();
}
function onPlan(e){
  if(!calibrating||awaiting!=='floor')return;
  const svg=$('test-map');if(!svg)return;
  e.stopPropagation();e.preventDefault();
  const m=svg.getScreenCTM();if(!m)return;const q=svg.createSVGPoint();q.x=e.clientX;q.y=e.clientY;const {x,y}=q.matrixTransform(m.inverse());
  const p=plan();if(x<0||y<0||x>p.widthM||y>p.depthM)return;
  const s=snap([x,y]),last=pairs[pairs.length-1];last.floor=s.pt.map(v=>Math.round(v*100)/100);last.label=s.label;awaiting='image';renderPanel();drawLive();
}
async function saveCalibration(){
  const points=pairs.filter(q=>q.image&&q.floor);
  try{room=await api('room',{action:'save',revision:room.revision,calibration:{cameraId:camera(),points}});endCalibration();render();renderPanel();drawLive();const c=calibration();toast(c.checked?`Calibration saved. Average error ${Math.round(c.rmsM*100)} cm.`:'Calibration saved. Add a fifth point to measure its accuracy.');}
  catch(e){toast(e.message);}
}
async function removeCalibration(){
  if(!confirm('Remove the floor calibration for this camera?'))return;
  try{room=await api('room',{action:'save',revision:room.revision,removeCalibration:camera()});render();renderPanel();drawLive();}catch(e){toast(e.message);}
}

// ---------- panel ----------
function renderPanel(){
  const cal=calibration();
  const elsewhere=!running&&state?.running;
  $('tracking-state').textContent=running?`Tracking · ${stats.fps||'…'} fps · ${stats.ms} ms per frame`:elsewhere?'Tracking on another screen':'Tracking off';
  $('tracking-state').classList.toggle('on',running);
  $('track-start').disabled=running||calibrating||elsewhere;$('track-stop').disabled=!running;$('calibrate').disabled=calibrating;
  $('calibration-state').innerHTML=cal?`Floor calibration: ${cal.points.length} points, saved ${esc(new Date(cal.savedAt).toLocaleString())}. ${cal.checked?`Average error ${Math.round(cal.rmsM*100)} cm, worst ${Math.round(cal.maxErrorM*100)} cm.`:'Add a fifth point to measure accuracy.'} <label class="check inline"><input type="checkbox" id="show-outline" ${showOutline?'checked':''}> Show the plan on the live picture</label> <button id="remove-calibration" class="link">Remove</button>`:'This camera has no floor calibration yet. Tracking will show people in the picture but cannot place them on the plan.';
  $('show-outline')?.addEventListener('change',e=>{showOutline=e.target.checked;drawLive();});
  $('remove-calibration')?.addEventListener('click',removeCalibration);
  $('calibration-editor').hidden=!calibrating;
  if(calibrating){
    const done=pairs.filter(q=>q.image&&q.floor).length;
    $('calibration-step').textContent=awaiting==='image'?`Point ${pairs.length+1}: click a spot on the floor in the live picture — a rug corner, the foot of a table leg, the edge of a doorway.`:`Point ${pairs.length}: now click the same spot on the floor plan. Clicks near a corner snap to it.`;
    $('calibration-points').innerHTML=pairs.map((q,i)=>`<li>${i+1}. ${q.floor?`${esc(q.label||'Floor point')} · x ${q.floor[0].toFixed(2)} m, y ${q.floor[1].toFixed(2)} m`:'waiting for the plan…'}</li>`).join('');
    $('calibration-save').disabled=done<4||awaiting!=='image';$('calibration-undo').disabled=!pairs.length;
    $('calibration-save').textContent=done<4?`Save calibration (${done}/4)`:'Save calibration';
  }
  const phones_=typeof phones!=='undefined'?phones:[],role=typeof roleFor==='function'?roleFor:()=>'';
  const opts=phones_.map(p=>`<option value="${p.device}">Phone ${p.device}${role(p.device)?' · '+esc(role(p.device)):''}</option>`).join('');
  const tracks=(state?.tracks||[]).slice().sort((a,b)=>(b.visible-a.visible)||a.id.localeCompare(b.id));
  const suggestion=(state?.suggestions||[]).filter(s=>!dismissed.has(s.trackId+'>'+s.phone));
  const markup=(suggestion.length?suggestion.map(s=>`<div class="room-item suggest" data-track="${esc(s.trackId)}" data-phone="${s.phone}" data-role="${esc(s.role)}"><strong>Is ${esc(s.trackId)} ${esc(s.label)}?</strong><p>${esc(s.label)} went out of sight and ${esc(s.trackId)} appeared ${s.distanceM} m from where they were last seen.</p><div class="row"><button class="yes primary">Yes, that’s ${esc(s.role||'them')}</button><button class="no">No</button></div></div>`).join(''):'')+
    (tracks.length?tracks.map(x=>`<div class="room-item" data-track="${esc(x.id)}"><strong>${esc(x.binding?.label||x.id)}${x.binding?` <span class="hint">· ${esc(x.id)}</span>`:''}</strong><p class="status"></p><div class="row"><select aria-label="Phone for ${esc(x.id)}">${opts.replace(`value="${chosen.get(x.id)??x.binding?.phone}"`,`value="${chosen.get(x.id)??x.binding?.phone}" selected`)}</select><button class="bind">This is them</button>${x.binding?'<button class="unbind">Clear</button>':''}</div></div>`).join(''):`<p class="hint">${running||elsewhere?'No one in view yet.':'Start tracking to find people in the live picture.'}</p>`);
  if($('tracks').dataset.markup!==markup){
    const focused=document.activeElement?.tagName==='SELECT'&&document.activeElement.closest('#tracks');if(!focused){$('tracks').innerHTML=markup;$('tracks').dataset.markup=markup;
    for(const el of $('tracks').querySelectorAll('[data-track]')){
      el.querySelector('select')?.addEventListener('change',e=>chosen.set(el.dataset.track,e.target.value));
      el.querySelector('.bind')?.addEventListener('click',()=>bind(el.dataset.track,Number(el.querySelector('select').value)));
      el.querySelector('.unbind')?.addEventListener('click',()=>bind(el.dataset.track,null));
      el.querySelector('.yes')?.addEventListener('click',()=>bind(el.dataset.track,Number(el.dataset.phone),el.dataset.role));
      el.querySelector('.no')?.addEventListener('click',()=>{dismissed.add(el.dataset.track+'>'+el.dataset.phone);renderPanel();});
    }}
  }
  const byId=new Map(tracks.map(x=>[x.id,x]));
  for(const el of $('tracks').querySelectorAll('.room-item[data-track]:not(.suggest)')){const x=byId.get(el.dataset.track);if(!x)continue;
    el.querySelector('.status').textContent=`${x.visible?'Visible':`Out of sight · last seen ${Math.round((Date.now()-x.lastSeenAt)/1000)} s ago`} · ${x.area}${x.floor?` · x ${x.floor[0].toFixed(1)} m, y ${x.floor[1].toFixed(1)} m`:''}${x.visible&&!x.feetVisible?' · feet not in view, position uncertain':''}`;}
  renderObjects();
  $('movement').innerHTML=(state?.movement||[]).slice().reverse().map(m=>`<p><strong>${esc(t(m.at))}</strong> · ${esc(m.who)}${m.object?` moved ${m.distanceM} m`:''}: ${m.from?esc(m.from)+' → ':''}${esc(m.to)}</p>`).join('')||'No movement yet.';
  drawPlan();
}
function renderObjects(){
  const items=(room?.floorPlan?.footprints||[]).filter(f=>!(f.heightM!=null&&f.heightM<0.05)).map(f=>f.name);
  const objs=(state?.objects||[]).slice().sort((a,b)=>(b.visible-a.visible)||a.id.localeCompare(b.id));
  const sugg=(state?.objectSuggestions||[]).filter(x=>!dismissedObjects.has(x.objectId+'>'+x.footprint));
  const opts=sel=>items.map(n=>`<option${n===sel?' selected':''}>${esc(n)}</option>`).join('');
  const markup=sugg.map(x=>`<div class="room-item suggest" data-object="${esc(x.objectId)}" data-footprint="${esc(x.footprint)}"><strong>Is this ${esc(x.cls)} the ${esc(x.footprint)}?</strong><p>The camera sees a ${esc(x.cls)} ${x.distanceM?x.distanceM+' m from':'on'} the ${esc(x.footprint)} outline.</p><div class="row"><button class="yes primary">Yes, it’s the ${esc(x.footprint)}</button><button class="no">No</button></div></div>`).join('')+
    (objs.length?objs.map(o=>`<div class="room-item" data-object="${esc(o.id)}"><strong>${esc(o.binding?o.binding.footprint:o.cls)}${o.binding?` <span class="hint">· ${esc(o.cls)} ${esc(o.id)}</span>`:` <span class="hint">· ${esc(o.id)}</span>`}</strong><p class="status"></p><div class="row"><select aria-label="Plan item for ${esc(o.id)}">${opts(objectChoice.get(o.id)??o.binding?.footprint)}</select><button class="bind">This is it</button>${o.binding?'<button class="unbind">Clear</button>':''}</div></div>`).join(''):`<p class="hint">${running?'No furniture recognised yet. The detector knows chairs, sofas, tables, benches and bags.':'Start tracking to follow furniture too.'}</p>`);
  if($('objects').dataset.markup!==markup&&!(document.activeElement?.tagName==='SELECT'&&document.activeElement.closest('#objects'))){
    $('objects').innerHTML=markup;$('objects').dataset.markup=markup;
    for(const el of $('objects').querySelectorAll('[data-object]')){
      el.querySelector('select')?.addEventListener('change',e=>objectChoice.set(el.dataset.object,e.target.value));
      el.querySelector('.bind')?.addEventListener('click',()=>bindObject(el.dataset.object,el.querySelector('select').value));
      el.querySelector('.unbind')?.addEventListener('click',()=>bindObject(el.dataset.object,null));
      el.querySelector('.yes')?.addEventListener('click',()=>bindObject(el.dataset.object,el.dataset.footprint));
      el.querySelector('.no')?.addEventListener('click',()=>{dismissedObjects.add(el.dataset.object+'>'+el.dataset.footprint);renderObjects();});
    }
  }
  const byId=new Map(objs.map(o=>[o.id,o]));
  for(const el of $('objects').querySelectorAll('.room-item[data-object]:not(.suggest)')){const o=byId.get(el.dataset.object);if(!o)continue;
    el.querySelector('.status').textContent=`${o.visible?(o.blocked?'Seen, partly blocked by a person':'Seen now'):`Not seen for ${Math.round((Date.now()-o.lastSeenAt)/1000)} s`} · x ${o.floor[0].toFixed(1)} m, y ${o.floor[1].toFixed(1)} m${o.score!=null?` · ${Math.round(o.score*100)}% sure`:''}`;}
}
async function bindObject(objectId,footprint){
  try{state=await api('room',{action:'bindObject',objectId,footprint});if(room)room.tracking=state;objectChoice.delete(objectId);renderPanel();drawLive();}catch(e){toast(e.message);}
}
async function bind(trackId,phone,knownRole){
  // Keep a role the desk already confirmed (from a suggestion); otherwise use the program's role for that phone.
  const role=knownRole??(phone&&typeof roleFor==='function'?roleFor(phone):'');
  try{state=await api('room',{action:'bindTrack',trackId,phone,role});if(room)room.tracking=state;chosen.delete(trackId);renderPanel();drawLive();}catch(e){toast(e.message);}
}

// ---------- wiring ----------
$('track-start').onclick=start;$('track-stop').onclick=()=>stop();
$('calibrate').onclick=beginCalibration;
$('calibration-undo').onclick=()=>{pairs.pop();awaiting='image';renderPanel();drawLive();};
$('calibration-cancel').onclick=()=>{endCalibration();renderPanel();drawLive();};
$('calibration-save').onclick=saveCalibration;
$('track-overlay').addEventListener('click',onPicture);
$('floor-plan').addEventListener('click',onPlan,true);
$('camera').addEventListener('change',()=>{if(running)stop('Tracking stopped: camera changed.');endCalibration();renderPanel();drawLive();});
window.addEventListener('beforeunload',()=>{if(running)navigator.sendBeacon?.(Setup.url('/api/room'),new Blob([JSON.stringify({action:'stopTracking',tracker})],{type:'application/json'}));});
// Keep the panel current while another screen or nobody is tracking.
setInterval(()=>{if(!running){state=room?.tracking||state;renderPanel();}drawLive();},1000);
})();
