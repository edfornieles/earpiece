// Live tracking and floor calibration for the Room page.
// People are found in the live picture by a detector that runs in this browser; pictures never leave
// this computer. Only boxes go to the server, which turns feet positions into floor metres using the
// camera's floor calibration and keeps who-is-who as the desk confirmed it.
(()=>{
const {$,esc,api,toast}=Setup;
const SCRIPTS=['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js','https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'];
// Body points (ankles, hips, head) from MoveNet. Optional: without them the server falls back to the box.
const POSE_SCRIPT='https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js';
let poseModel=null,poseError='';
const DETECT_EVERY_MS=200,SEND_EVERY_MS=400,MIN_SCORE=0.45,OBJECT_MIN_SCORE=0.2,KEEP_UNMATCHED_MS=2500,SNAP_M=0.15;
// Furniture the detector knows. Anything else (rugs, artworks, rolls of paper) is marked by hand on the plan.
const FURNITURE=new Set(['chair','couch','bench','dining table','suitcase','backpack','handbag','potted plant','tv']);
const ANIMALS=new Set(['dog','cat']);
let lastAnimals=[],lastObjects=[],objectChoice=new Map(),dismissedObjects=new Set();
const tracker=Math.random().toString(36).slice(2,10);
const chosen=new Map();
let model=null,running=false,timer=0,lastSent=0,sending=false,nextId=1,local=[],state=null,dismissed=new Set(),stats={ms:0,fps:0,frames:0,since:0};
const serverOn=()=>!!(state?.pose?.on&&state.pose.cameraId===camera());
const tracking_=()=>running||serverOn();
let polling=0;
let calibrating=false,pairs=[],awaiting='image',showOutline=false,home=null;
function endCalibration(){calibrating=false;pairs=[];if(home){home.parent.insertBefore($('floor-plan'),home.next);home=null;}}
const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
const camera=()=>$('camera').value;
const savedCalibration=()=>room?.calibrations?.[camera()]||null;
const calibration=()=>savedCalibration()?.needsReview?null:savedCalibration();
const furnitureLabel=cls=>cls==='dining table'?'Table-shaped furniture':cls;
const plan=()=>room?.floorPlan||null;
const t=ms=>new Date(ms).toLocaleTimeString();

// ---------- detector ----------
function loadScript(src){return new Promise((ok,fail)=>{if(document.querySelector(`script[src="${src}"]`))return ok();const s=document.createElement('script');s.src=src;s.crossOrigin='anonymous';s.onload=ok;s.onerror=()=>fail(Error('Could not load the person detector. This Mac needs an internet connection the first time.'));document.head.append(s);});}
async function loadModel(){if(model)return model;for(const s of SCRIPTS)await loadScript(s);model=await window.cocoSsd.load({base:'mobilenet_v2'});loadPose();return model;}
async function loadPose(){
  if(poseModel)return;
  try{await loadScript(POSE_SCRIPT);const P=window.poseDetection;poseModel=await P.createDetector(P.SupportedModels.MoveNet,{modelType:P.movenet.modelType.MULTIPOSE_LIGHTNING,enableTracking:false});poseError='';}
  catch(e){poseError='Body points unavailable: '+(e.message||e);}
}
// Give each person box the body whose points fall inside it most.
function attachPoses(poses,W,H,now){
  const bodies=poses.map(p=>p.keypoints.map(k=>[k.x/W,k.y/H,k.score??0]));
  const used=new Set();
  for(const tr of local){
    if(tr.seen!==now)continue;
    let best=-1,bestN=4;
    bodies.forEach((kp,i)=>{if(used.has(i))return;const b=tr.box,n=kp.filter(q=>q[2]>0.3&&q[0]>=b.x-0.02&&q[0]<=b.x+b.w+0.02&&q[1]>=b.y-0.02&&q[1]<=b.y+b.h+0.02).length;if(n>bestN){best=i;bestN=n;}});
    if(best>=0){used.add(best);tr.kp=bodies[best].map(q=>q.map(v=>Math.round(v*1000)/1000));tr.kpAt=now;}
  }
}
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
      if(poseModel&&dets.length){try{attachPoses(await poseModel.estimatePoses(canvas,{maxPoses:6}),W,H,now);}catch(e){poseError='Body points failed: '+(e.message||e);}}
      stats.ms=Math.round(performance.now()-started);stats.frames++;if(now-stats.since>2000){stats.fps=Math.round(stats.frames*10000/(now-stats.since))/10;stats.frames=0;stats.since=now;}
      if(now-lastSent>=SEND_EVERY_MS)send(now);
      drawLive();
    }
  }catch(e){stop(e.message);return;}
  timer=setTimeout(step,Math.max(0,DETECT_EVERY_MS-(performance.now()-started)));
}
async function send(now){
  if(sending)return;sending=true;lastSent=now;
  const tracks=local.filter(tr=>tr.hits>=2&&now-tr.seen<400).map(tr=>({id:tr.id,box:tr.box,score:tr.score,feetVisible:tr.box.y+tr.box.h<0.97,...(tr.kp&&now-tr.kpAt<600?{kp:tr.kp}:{})}));
  try{state=await api('room',{action:'track',tracker,cameraId:camera(),tracks,objects:lastObjects,animals:lastAnimals});renderPanel();}
  catch(e){stop(e.message);}finally{sending=false;}
}
// On this computer (server pose model, full resolution) when it is set up; in this browser otherwise.
async function start(){
  if(running||serverOn())return;
  if(state?.pose?.ready||room?.tracking?.pose?.ready){
    $('track-start').disabled=true;$('tracking-state').textContent='Starting…';
    try{state=await api('room',{action:'serverTracking',on:true,cameraId:camera()});poll();}catch(e){toast(e.message);}
    renderPanel();return;
  }
  return startBrowser();
}
async function poll(){
  clearTimeout(polling);
  try{state=await api('room',{action:'trackingView'});if(room)room.tracking=state;renderPanel();drawLive();dispatchEvent(new CustomEvent('room-tracking',{detail:state}));}catch{}
  if(serverOn())polling=setTimeout(poll,350);
}
async function startBrowser(){
  if(running)return;$('track-start').disabled=true;$('tracking-state').textContent='Loading detector…';
  try{await loadModel();}catch(e){$('track-start').disabled=false;$('tracking-state').textContent='Tracking off';return toast(e.message);}
  local=[];nextId=1;running=true;stats={ms:0,fps:0,frames:0,since:Date.now()};renderPanel();step();
}
function stop(message){
  if(serverOn()){clearTimeout(polling);api('room',{action:'serverTracking',on:false}).then(v=>{state=v;if(room)room.tracking=v;renderPanel();drawLive();}).catch(e=>toast(e.message));if(message)toast(message);return;}
  const was=running;running=false;clearTimeout(timer);local=[];drawLive();
  if(was)api('room',{action:'stopTracking',tracker}).then(v=>{state=v;renderPanel();}).catch(()=>{});
  if(message)toast(message);renderPanel();
}

// ---------- live picture overlay ----------
function drawLive(){
  const svg=$('track-overlay');if(!svg)return;
  svg.toggleAttribute('hidden',$('live-picture').hidden);svg.classList.toggle('calibrating',calibrating);
  const byId=new Map((state?.tracks||[]).map(x=>[x.id,x]));
  const src=running?local.filter(tr=>tr.hits>=2):serverOn()?(state?.tracks||[]).filter(x=>x.visible&&x.box):[];
  // Body points the position came from: ankles green, hips amber, head pink.
  const joints=serverOn()||running?src.map(tr=>{const kp=byId.get(tr.id)?.kp;if(!kp)return '';return [[15,16,'ankle'],[11,12,'hip'],[0,0,'head']].map(([a,b,c])=>[kp[a],kp[b]].filter(q=>q&&q[2]>0.45).map(q=>`<circle class="joint ${c}" cx="${q[0]*1000}" cy="${q[1]*1000}" r="5"/>`).join('')).join('');}).join(''):'';
  const boxes=joints+src.map(tr=>{const s=byId.get(tr.id),label=s?.binding?.person?.name||s?.binding?.label||'Unknown person';return `<g class="${s?.binding?'bound':''}"><rect x="${tr.box.x*1000}" y="${tr.box.y*1000}" width="${tr.box.w*1000}" height="${tr.box.h*1000}"/><circle cx="${(tr.box.x+tr.box.w/2)*1000}" cy="${(tr.box.y+tr.box.h)*1000}" r="6"/><text x="${tr.box.x*1000+6}" y="${Math.max(24,tr.box.y*1000+24)}">${esc(label)}${s?.area&&s.area!=='unknown'?' · '+esc(s.area):''}</text></g>`;}).join('');
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
  const furn=(state?.objects||[]).filter(o=>o.visible&&o.box).map(o=>`<g class="furniture${o.binding?' bound':''}"><rect x="${o.box.x*1000}" y="${o.box.y*1000}" width="${o.box.w*1000}" height="${o.box.h*1000}"/><text x="${o.box.x*1000+6}" y="${o.box.y*1000+22}">${esc(o.binding?.footprint||furnitureLabel(o.cls)+' '+o.id)}</text></g>`).join('');
  const pets=(state?.animals||[]).filter(a=>a.visible&&a.box).map(a=>`<g class="animal"><rect x="${a.box.x*1000}" y="${a.box.y*1000}" width="${a.box.w*1000}" height="${a.box.h*1000}"/><text x="${a.box.x*1000+6}" y="${a.box.y*1000+22}">${esc(a.name)}${a.area&&a.area!=='unknown'?' · '+esc(a.area):''}</text></g>`).join('');
  const named=(state?.finder?.objects||[]).filter(o=>o.visible&&o.box).map(o=>`<g class="named"><rect x="${o.box.x*1000}" y="${o.box.y*1000}" width="${o.box.w*1000}" height="${o.box.h*1000}"/><text x="${o.box.x*1000+6}" y="${o.box.y*1000+22}">${esc(o.name)} ${Math.round(o.score*100)}%</text></g>`).join('');
  svg.innerHTML=outline+furn+named+pets+boxes+marks;
  drawPlan();
}
function project(H,[x,y]){const w=H[6]*x+H[7]*y+H[8];if(!(w>1e-9))return null;return [(H[0]*x+H[1]*y+H[2])/w,(H[3]*x+H[4]*y+H[5])/w];}
function invert(H){const [a,b,c,d,e,f,g,h,i]=H,A=e*i-f*h,B=-(d*i-f*g),C=d*h-e*g,det=a*A+b*B+c*C;return [A,-(b*i-c*h),b*f-c*e,B,a*i-c*g,-(a*f-c*d),C,-(a*h-b*g),a*e-b*d].map(v=>v/det);}

// ---------- floor plan layer ----------
function drawPlan(){
  const status = $('floor-live-state');
  if (status) {
    const message = savedCalibration()?.needsReview
      ? 'Live floor positions are paused until this view is recalibrated. Person detection still works in the camera feed.'
      : !calibration() ? 'Calibrate this camera to show live positions on the plan.'
      : (tracking_() || state?.running) && state?.cameraId === camera()
        ? 'Live positions are estimates. Review settled furniture moves before updating the plan.'
        : 'Start tracking to see live positions on the plan.';
    if (status.textContent !== message) status.textContent = message;
  }
  const svg=$('test-map');if(!svg)return;
  let layer=svg.querySelector('#live-layer');if(!layer){layer=document.createElementNS('http://www.w3.org/2000/svg','g');layer.id='live-layer';svg.append(layer);}
  const p=plan(),u=p?Math.max(p.widthM,p.depthM)/220:0.02;
  // Each person: a dot coloured by how sure the position is, and a dashed ring showing its error radius.
  const people=(state?.tracks||[]).filter(x=>x.floor&&(x.visible?tracking_():x.binding)).map(x=>{const c=conf(x);return `<g class="live-person ${c}${!x.visible?' last-seen':''}${x.binding?' bound':''}" transform="translate(${x.floor[0]} ${x.floor[1]})">${x.radiusM?`<circle class="ring" r="${Math.min(1.5,x.radiusM)}"/>`:''}<circle class="dot" r="${4.5*u}"/><text x="${10*u}" y="${4*u}">${esc(personName(x))}${!x.visible?' · last seen':''}</text></g>`;}).join('');
  const marks=calibrating?pairs.map((q,i)=>q.floor?`<g class="calib" transform="translate(${q.floor[0]} ${q.floor[1]})"><circle r="${5*u}"/><text x="${7*u}" y="${-5*u}">${i+1}</text></g>`:'').join(''):'';
  const furn=(state?.objects||[]).map(o=>`<g class="live-object${o.visible?'':' last-seen'}${o.binding?' bound':''}" transform="translate(${o.floor[0]} ${o.floor[1]})"><rect x="${-5*u}" y="${-5*u}" width="${10*u}" height="${10*u}"/><text x="${8*u}" y="${4*u}">${esc(o.binding?.footprint||furnitureLabel(o.cls))}</text></g>`).join('');
  const pets=(state?.animals||[]).filter(a=>a.floor).map(a=>`<g class="live-animal${a.visible?'':' last-seen'}" transform="translate(${a.floor[0]} ${a.floor[1]})"><circle r="${5*u}"/><text x="${8*u}" y="${4*u}">${esc(a.name)}</text></g>`).join('');
  const hasLivePositions = calibration() && (running || state?.running) && state?.cameraId === camera();
  const named=(state?.finder?.objects||[]).filter(o=>o.floor).map(o=>`<g class="live-object bound${o.visible?'':' last-seen'}" transform="translate(${o.floor[0]} ${o.floor[1]})"><rect x="${-4*u}" y="${-4*u}" width="${8*u}" height="${8*u}"/><text x="${8*u}" y="${4*u}">${esc(o.name)}</text></g>`).join('');
  layer.innerHTML = (hasLivePositions ? furn + named + pets + people : '') + marks;
  drawCoverage(svg);
}
const conf=x=>!x.visible||x.certainty==='last seen'?'unsure':x.confidence||(x.certainty==='estimate'?'rough':'unsure');
const personName=x=>x.binding?.person?.name||x.binding?.label||'Unknown';
const coverageFor=()=>room?.coverage?.[camera()]||null;
let coverageKey='';
function drawCoverage(svg){
  const cov=coverageFor(),on=$('coverage-toggle')?.checked!==false;
  let g=svg.querySelector('#coverage-layer');
  if(!g){g=document.createElementNS('http://www.w3.org/2000/svg','g');g.id='coverage-layer';const floor=svg.querySelector('.test-floor');floor?floor.after(g):svg.prepend(g);coverageKey='';}
  g.classList.toggle('off',!on);
  const key=cov?cov.cameraId+JSON.stringify(cov.summary)+cov.cells.length:'';
  if(key!==coverageKey){
    coverageKey=key;const h=(cov?.step||0.25)/2;
    g.innerHTML=cov?`<defs><pattern id="cov-hatch" width=".09" height=".09" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="cov-hatch-line" x1="0" y1="0" x2="0" y2=".09"/></pattern></defs>`+cov.cells.filter(c=>c.state!=='feet'&&c.state!=='furniture').map(c=>`<rect class="cov-cell ${c.state==='body only'?'body':'blind'}" x="${c.x-h}" y="${c.y-h}" width="${2*h}" height="${2*h}"><title>${esc(c.state)}</title></rect>`).join(''):'';
  }
  const sum=$('coverage-summary');
  if(sum){const text=!cov?'Calibrate this camera to see which parts of the floor it can see.':`This camera sees feet on ${cov.summary.feet}% of the floor and only the upper body on ${cov.summary.bodyOnly}%; ${cov.summary.unseen}% is out of sight${cov.blindAreas.length?` (${cov.blindAreas.join(', ')})`:''}.${cov.cameraPlaced?'':' Add the camera position for body-only and blind-spot estimates.'}`;if(sum.textContent!==text)sum.textContent=text;}
  $('coverage-key').hidden=!cov;
}
// One line per person in view (and bound people out of sight): where, and how far to trust it.
function renderPeopleNow(){
  const el=$('people-now');if(!el)return;
  // When tracking is off, nobody is "in view": what is left is where people were last seen.
  const live=!!state?.running&&state?.cameraId===camera();
  const list=(state?.tracks||[]).map(x=>live?x:{...x,visible:false}).filter(x=>x.visible||x.binding).sort((a,b)=>(b.visible-a.visible)||(!!b.binding-!!a.binding));
  const label={sure:'sure',rough:'rough',unsure:'unsure'},how={feet:'from feet',hips:'from hips','hips (seated)':'seated',seat:'seated',head:'from head',held:'held'};
  const markup=list.map(x=>{const c=conf(x),r=x.radiusM?` ±${Math.round(x.radiusM*100)} cm`:'';return `<div class="person-row ${c}"><span class="dot"></span><div><strong>${esc(personName(x))}</strong>${x.binding?.role?` <span class="hint">· ${esc(x.binding.role)}</span>`:''}<div class="where">${x.visible?esc(x.area||'position unknown'):'out of sight · last '+esc(x.area||'unknown')}</div></div><span class="pill ${c}" title="${esc(how[x.how]||x.certainty||'')}">${x.visible&&x.floor?label[c]+r:x.visible?'no floor position':'last seen'}</span></div>`;}).join('');
  if(el.dataset.markup!==markup){el.innerHTML=markup;el.dataset.markup=markup;}
  const n=list.filter(x=>x.visible).length;$('people-count').textContent=n?`${n} in view`:'none in view';
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
  calibrating=true;pairs=(savedCalibration()?.points||[]).map(q=>({...q}));awaiting='image';
  // Bring the plan next to the picture while calibrating, so both clicks are on screen together.
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
  try{room=await api('room',{action:'save',revision:room.revision,calibration:{cameraId:camera(),points}});endCalibration();render();renderPanel();drawLive();const c=calibration();toast(c.validation==='holdout'?`Calibration saved. Check point error ${Math.round(c.maxErrorM*100)} cm.`:'Calibration saved. Add a separate check point to measure accuracy.');}
  catch(e){toast(e.message);}
}
async function removeCalibration(){
  if(!confirm('Remove the floor calibration for this camera?'))return;
  try{room=await api('room',{action:'save',revision:room.revision,removeCalibration:camera()});render();renderPanel();drawLive();}catch(e){toast(e.message);}
}

// ---------- panel ----------
function renderPanel(){
  const cal=calibration();
  const srv=serverOn(),on=running||srv,elsewhere=!on&&state?.running&&state?.pose?.on!==true,pz=state?.pose;
  $('tracking-state').textContent=srv?(pz.error?'Tracking · '+pz.error:pz.device?`Tracking · ${pz.fps||'…'} fps · ${pz.source==='full'?'full resolution':'preview'}`:'Tracking · loading model…'):running?'Tracking in this browser':elsewhere?'Tracking on another screen':'Tracking off';
  $('tracking-state').classList.toggle('on',on);
  $('track-start').disabled=on||calibrating||elsewhere;$('track-stop').disabled=!on;$('track-start').hidden=on;$('track-stop').hidden=!on;document.body.classList.toggle('rm-live',on);document.body.classList.toggle('rm-calibrating',calibrating);$('calibrate').disabled=calibrating;
  $('calibration-state').innerHTML=cal?`Floor calibration: ${cal.points.length} points, saved ${esc(new Date(cal.savedAt).toLocaleString())}. ${cal.validation==='holdout'?`Check point error ${Math.round(cal.maxErrorM*100)} cm.`:'Add a separate check point to measure accuracy.'} <label class="check inline"><input type="checkbox" id="show-outline" ${showOutline?'checked':''}> Show the plan on the live picture</label> <button id="remove-calibration" class="link">Remove</button>`:savedCalibration()?.needsReview?'Floor positions paused. Recalibrate to align the floor plan with this camera view. Your previous anchors are saved.':'This camera has no floor calibration yet. Tracking will show people in the picture but cannot place them on the plan.';
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
  const faces=state?.faces;
  const faceOpts=(faces?.registered||[]).filter(p=>p.face).map(p=>`<option value="${esc(p.pid)}">${esc(p.name)} #${p.number}</option>`).join('');
  const fin=state?.finder;if($('finder-state'))$('finder-state').textContent=!fin?'':!fin.ready?'The object finder is not set up on this computer.':fin.error?`Object finder: ${fin.error}`:!fin.device?(fin.running?'Object finder starting…':''):`Objects found by description${fin.device==='mps'?' (on this Mac\'s GPU)':''}: ${(fin.objects||[]).map(o=>`${o.name}${o.visible?'':' (not seen now)'}${o.area?' · '+o.area:''}${o.follows?'':' · not moved on the plan'}`).join('; ')||'none yet'}`;
  if($('faces-state'))$('faces-state').textContent=!faces?'':!faces.ready?'Face recognition is not set up on this computer.':`Faces: ${(faces.registered||[]).filter(p=>p.enrolled).map(p=>`${p.name} (${p.views} view${p.views===1?'':'s'})`).join(', ')||'nobody enrolled yet'}${(faces.registered||[]).filter(p=>p.face&&p.problem).map(p=>` · ${p.name}: ${p.problem}`).join('')}${faces.source?` · reading ${faces.source}`:''}${faces.recent?.length?` · recognised just now: ${faces.recent.map(r=>`${r.name} ${Math.round(r.score*100)}%`).join(', ')}`:''}`;
  const visiblePeople = (state?.tracks||[]).filter(person=>person.visible);
  const visibleFurniture = (state?.objects||[]).filter(object=>object.visible);
  $('people-summary').textContent = 'Name and assign'+(visiblePeople.length?' · '+visiblePeople.length:'');
  renderPeopleNow();
  $('furniture-summary').textContent = 'Furniture · '+visibleFurniture.length+' in view';
  const tracks=(state?.tracks||[]).slice().sort((a,b)=>(b.visible-a.visible)||a.id.localeCompare(b.id));
  const suggestion=(state?.suggestions||[]).filter(s=>!dismissed.has(s.trackId+'>'+s.phone));
  const markup=(suggestion.length?suggestion.map(s=>`<div class="room-item suggest" data-track="${esc(s.trackId)}" data-phone="${s.phone}" data-role="${esc(s.role)}"><strong>Is ${esc(s.trackId)} ${esc(s.label)}?</strong><p>${esc(s.label)} went out of sight and ${esc(s.trackId)} appeared ${s.distanceM} m from where they were last seen.</p><div class="row"><button class="yes primary">Yes, that’s ${esc(s.role||'them')}</button><button class="no">No</button></div></div>`).join(''):'')+
    (tracks.length?tracks.map(x=>`<div class="room-item" data-track="${esc(x.id)}"><strong>${esc(x.binding?.label||x.id)}${x.binding?` <span class="hint">· ${esc(x.id)}</span>`:''}</strong><p class="status"></p><div class="row"><select aria-label="Phone for ${esc(x.id)}">${opts.replace(`value="${chosen.get(x.id)??x.binding?.phone}"`,`value="${chosen.get(x.id)??x.binding?.phone}" selected`)}</select><button class="bind">This is them</button>${x.visible?'<button class="name-person">Name person</button>':''}${x.binding?'<button class="unbind">Clear</button>':''}</div>${x.visible&&faceOpts?`<div class="row"><select class="who" aria-label="Who is ${esc(x.id)}"><option value="">Who is this?</option>${faceOpts}</select><button class="identify">That's them</button></div>`:''}${x.binding?.person?`<p class="hint">${x.binding.person.by==='desk'?'Named at the desk':'Recognised by face'}${x.binding.person.score?` · ${Math.round(x.binding.person.score*100)}% match`:''}</p>`:''}</div>`).join(''):`<p class="hint">${running||elsewhere?'No one in view yet.':'Start tracking to find people in the live picture.'}</p>`);
  if($('tracks').dataset.markup!==markup){
    const focused=document.activeElement?.tagName==='SELECT'&&document.activeElement.closest('#tracks');if(!focused){$('tracks').innerHTML=markup;$('tracks').dataset.markup=markup;
    for(const el of $('tracks').querySelectorAll('[data-track]')){
      el.querySelector('select')?.addEventListener('change',e=>chosen.set(el.dataset.track,e.target.value));
      el.querySelector('.bind')?.addEventListener('click',()=>bind(el.dataset.track,Number(el.querySelector('select').value)));
      el.querySelector('.identify')?.addEventListener('click',async()=>{const pid=el.querySelector('.who').value;if(!pid)return toast('Choose who this is.');try{state=await api('room',{action:'identifyTrack',trackId:el.dataset.track,pid});if(room)room.tracking=state;renderPanel();drawLive();toast('Named. The camera will learn this face as it sees it.');}catch(e){toast(e.message);}});
      el.querySelector('.name-person')?.addEventListener('click',()=>{
        const name=window.prompt('Name this person');
        if(name?.trim())bind(el.dataset.track,null,undefined,name.trim());
      });
      el.querySelector('.unbind')?.addEventListener('click',()=>bind(el.dataset.track,null));
      el.querySelector('.yes')?.addEventListener('click',()=>bind(el.dataset.track,Number(el.dataset.phone),el.dataset.role));
      el.querySelector('.no')?.addEventListener('click',()=>{dismissed.add(el.dataset.track+'>'+el.dataset.phone);renderPanel();});
    }}
  }
  const byId=new Map(tracks.map(x=>[x.id,x]));
  for(const el of $('tracks').querySelectorAll('.room-item[data-track]:not(.suggest)')){const x=byId.get(el.dataset.track);if(!x)continue;
    el.querySelector('.status').textContent=`${x.visible?'Visible':`Out of sight · last seen ${Math.round((Date.now()-x.lastSeenAt)/1000)} s ago`} · ${x.area}${x.floor?` · x ${x.floor[0].toFixed(1)} m, y ${x.floor[1].toFixed(1)} m`:''}${x.certainty==='last seen'&&x.positionAt?' · position last seen '+Math.max(0,Math.round((Date.now()-x.positionAt)/1000))+' s ago':x.certainty==='from head'?' · rough position':x.visible&&!x.floor?' · floor position unavailable':''}`;}
  renderObjects();
  const proposals = [
    ...(state?.objects||[]).filter(o=>o.proposal).map(o=>({id:o.id,name:o.binding.footprint,proposal:o.proposal})),
    ...(state?.finder?.objects||[]).filter(o=>state?.running&&o.proposal).map(o=>({id:o.name,name:o.name,proposal:o.proposal,source:'finder'}))
  ];
  const review = $('move-review');
  const proposalMarkup = proposals.map(({id,name,proposal,source})=>
    `<div class="room-item"><strong>${esc(name)} · ${proposal.from?'proposed move '+proposal.distanceM.toFixed(2)+' m':'proposed placement'}</strong><p class="hint">${proposal.from?proposal.from.map(v=>v.toFixed(2)).join(', ')+' → ':''}${proposal.to.map(v=>v.toFixed(2)).join(', ')} m</p><button data-move-id="${esc(id)}" data-move-at="${proposal.at}" data-move-source="${source||'tracker'}">Apply to plan</button></div>`
  ).join('');
  if(review.dataset.markup!==proposalMarkup){review.innerHTML=proposalMarkup;review.dataset.markup=proposalMarkup;}
  // Anonymous detections dropping out of view are noise; named people, objects and arrivals are not.
  const feed=(state?.movement||[]).filter(m=>!(m.to==='out of sight'&&/^Track /.test(m.who))).filter((m,i,a)=>{const p=a[i-1];return !p||p.who!==m.who||p.from!==m.from||p.to!==m.to;}).slice().reverse().slice(0,30).map(m=>`<p><time>${esc(t(m.at).replace(/:\d\d(?=\D*$)/,''))}</time><span><b>${esc(m.who)}</b>${m.object?` moved ${m.distanceM} m`:''} ${m.from?`<i>${esc(m.from)}</i> → `:''}${esc(m.to)}</span></p>`).join('')||'<p class="rm-dim">No movement yet.</p>';
  if($('movement').dataset.markup!==feed){$('movement').innerHTML=feed;$('movement').dataset.markup=feed;}
  drawPlan();
}
function renderObjects(){
  const items=(room?.floorPlan?.footprints||[]).filter(f=>!(f.heightM!=null&&f.heightM<0.05)).map(f=>f.name);
  const objs=(state?.objects||[]).slice().sort((a,b)=>(b.visible-a.visible)||a.id.localeCompare(b.id));
  const sugg=(state?.objectSuggestions||[]).filter(x=>!dismissedObjects.has(x.objectId+'>'+x.footprint));
  const opts=sel=>items.map(n=>`<option${n===sel?' selected':''}>${esc(n)}</option>`).join('');
  const markup=sugg.map(x=>`<div class="room-item suggest" data-object="${esc(x.objectId)}" data-footprint="${esc(x.footprint)}"><strong>Is this ${esc(furnitureLabel(x.cls))} the ${esc(x.footprint)}?</strong><p>The camera sees a ${esc(furnitureLabel(x.cls))} ${x.distanceM?x.distanceM+' m from':'on'} the ${esc(x.footprint)} outline.</p><div class="row"><button class="yes primary">Yes, it’s the ${esc(x.footprint)}</button><button class="no">No</button></div></div>`).join('')+
    (objs.length?objs.map(o=>`<div class="room-item" data-object="${esc(o.id)}"><strong>${esc(o.binding?o.binding.footprint:o.cls)}${o.binding?` <span class="hint">· ${esc(furnitureLabel(o.cls))} ${esc(o.id)}</span>`:` <span class="hint">· ${esc(o.id)}</span>`}</strong><p class="status"></p><div class="row"><select aria-label="Plan item for ${esc(o.id)}">${opts(objectChoice.get(o.id)??o.binding?.footprint)}</select><button class="bind">This is it</button>${o.binding?'<button class="unbind">Clear</button>':''}</div></div>`).join(''):`<p class="hint">${running?'No furniture recognised yet. The detector knows chairs, sofas, tables, benches and bags.':'Start tracking to follow furniture too.'}</p>`);
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
async function bind(trackId,phone,knownRole,name){
  // Keep a role the desk already confirmed (from a suggestion); otherwise use the program's role for that phone.
  const role=knownRole??(phone&&typeof roleFor==='function'?roleFor(phone):'');
  try{state=await api('room',{action:'bindTrack',trackId,phone,role,name});if(room)room.tracking=state;chosen.delete(trackId);renderPanel();drawLive();}catch(e){toast(e.message);}
}

$('move-review').onclick=async event=>{
  const button=event.target.closest('[data-move-id]');
  if(!button)return;
  try{
    state=await api('room',{action:'acceptObjectMove',source:button.dataset.moveSource,objectId:button.dataset.moveId,at:Number(button.dataset.moveAt)});
    await load();
    renderPanel();
  }catch(error){toast(error.message);}
};

// ---------- wiring ----------
try{const v=localStorage.getItem('room.coverage');if(v!==null)$('coverage-toggle').checked=v==='1';}catch{}
$('coverage-toggle').addEventListener('change',e=>{try{localStorage.setItem('room.coverage',e.target.checked?'1':'0');}catch{}drawPlan();});
if($('open-3d'))$('open-3d').href='room3d.html'+location.search;
$('track-start').onclick=start;$('track-stop').onclick=()=>stop();
$('calibrate').onclick=beginCalibration;
$('calibration-undo').onclick=()=>{pairs.pop();awaiting='image';renderPanel();drawLive();};
$('calibration-cancel').onclick=()=>{endCalibration();renderPanel();drawLive();};
$('calibration-save').onclick=saveCalibration;
$('track-overlay').addEventListener('click',onPicture);
$('floor-plan').addEventListener('click',onPlan,true);
$('camera').addEventListener('change',()=>{if(tracking_())stop('Tracking stopped: camera changed.');endCalibration();renderPanel();drawLive();});
window.addEventListener('beforeunload',()=>{if(running)navigator.sendBeacon?.(Setup.url('/api/room'),new Blob([JSON.stringify({action:'stopTracking',tracker})],{type:'application/json'}));});
// Keep the panel current while another screen or nobody is tracking.
setInterval(()=>{if(!running&&!serverOn()){state=room?.tracking||state;renderPanel();if(serverOn())poll();}drawLive();},1000);
})();
