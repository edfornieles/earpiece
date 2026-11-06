const {$,esc,api,toast,url}=Setup;
let room=null,phones=[],selection=null,view='live',editing=null,metadataDirty=false,metadataRevision=null,busy=false,drawing=false,origin=null;
const age=ms=>Math.max(0,Math.round((Date.now()-ms)/1000));
const roleFor=phone=>selection?.snapshot.roles.find(r=>selection.assignments[r.id]===phone)?.name||'';
function selectedObservation(){return room?.latest?.cameraId===$('camera').value?room.latest:null;}
function imgUrl(id){return url('/api/room-frame?observation='+encodeURIComponent(id));}
async function load(){try{const [data,p,r]=await Promise.all([api('room'),api('phones'),api('program-run')]);room=data;phones=p.devices;selection=r.selection;render();}catch(e){$('notice').textContent=e.message;}}
const dimensionIds=['floor-width','floor-depth','floor-height'];
let testPlanKey='', testPosition=null, testEvents=[];
function showTestMarker(){
 const marker=$('test-marker');if(!marker||!testPosition)return;
 const {x,y,visible}=testPosition;
 marker.setAttribute('transform',`translate(${x} ${y})`);
 marker.classList.toggle('last-seen',!visible);
 $('test-position').textContent=`${visible?'Test position':'Last seen'}: x ${x.toFixed(2)} m, y ${y.toFixed(2)} m`;
 $('test-hide').disabled=!visible;
 $('test-export').disabled=!testEvents.length;
 $('test-count').textContent=`${testEvents.length} logged ${testEvents.length===1?'event':'events'}`;
}
function logTestPosition(event){
 testEvents.push({event,at:new Date().toISOString(),...testPosition});showTestMarker();
}
function renderFloorPlan(plan){
 const key=JSON.stringify(plan||null);
 if(key===testPlanKey)return;
 testPlanKey=key;testEvents=[];testPosition=null;
 if(!plan){$('floor-plan').textContent='No measured plan saved yet.';return;}
 const {widthM:w,depthM:d,heightM:h}=plan;
 const unit=Math.max(w,d)/220;
 testPosition={x:w/2,y:d*((plan.footprints?.length)?0.75:0.5),visible:true};
 const doorMarks=plan.doors.filter(door=>door.wall==='bottom'&&door.offsetM===null&&/right/i.test(door.position)).map(()=>`<text x="${w}" y="${d+14*unit}" text-anchor="end">Door near here ↗</text>`).join('');
 const footprints=plan.footprints||[];
 const furniture=footprints.map(o=>{
  const x=o.points.reduce((sum,p)=>sum+p[0],0)/o.points.length,y=o.points.reduce((sum,p)=>sum+p[1],0)/o.points.length;
  return `<polygon class="plan-object${o.estimated?' estimated':''}" points="${o.points.map(p=>p.join(',')).join(' ')}"/><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central">${esc(o.name)}</text>`;
 }).join('');
 const doors=plan.doors.filter(door=>door.offsetM!==null).map(door=>{
  const a=door.offsetM,b=a+door.widthM,horizontal=door.wall==='top'||door.wall==='bottom',edge=door.wall==='bottom'?d:door.wall==='right'?w:0;
  return `<line class="plan-door" x1="${horizontal?a:edge}" y1="${horizontal?edge:a}" x2="${horizontal?b:edge}" y2="${horizontal?edge:b}"/>`;
 }).join('');
 const inventory=footprints.map(o=>`<li><strong>${esc(o.name)}</strong>${o.estimated?' · estimated placement or outline':''}${o.notes?' — '+esc(o.notes):''}</li>`).join('');
 $('floor-plan').innerHTML=`<svg id="test-map" class="floor-diagram test-map" tabindex="0" role="img" aria-label="Studio test plan. Click to place your marker or use arrow keys." style="--plan-font:${10*unit}px" viewBox="${-12*unit} ${-22*unit} ${w+24*unit} ${d+49*unit}"><rect class="test-floor" x="0" y="0" width="${w}" height="${d}"/><text x="${w/2}" y="${-8*unit}" text-anchor="middle">${esc(w)} m wide</text><text x="0" y="${d+25*unit}">${esc(d)} m deep · ${esc(h)} m ceiling</text><circle class="plan-origin" cx="0" cy="0" r="${3*unit}"/>${doorMarks}${furniture}${doors}<g id="test-marker"><circle r="${7*unit}"/><text x="${10*unit}" y="${-6*unit}">You</text></g></svg>${plan.doors.map(door=>`<p class="hint"><strong>${esc(door.name)} · ${esc(door.widthM)} m</strong><br>${esc(door.wall)} wall${door.position?' · '+esc(door.position):''}${door.offsetM===null?' · exact offset unmeasured':''}</p>`).join('')}${inventory?`<ul class="hint plan-inventory">${inventory}</ul>`:''}<p class="hint">Click the floor or use arrow keys to move your marker. A click or movement makes it visible again.</p><p id="test-position" class="hint" role="status"></p><div class="row"><button id="test-hide">Mark out of sight</button><button id="test-export">Download test log</button></div><p id="test-count" class="hint actions"></p>`;
 const svg=$('test-map');
 const place=(x,y)=>{testPosition={x,y,visible:true};logTestPosition('placed');};
 svg.onclick=e=>{
  const matrix=svg.getScreenCTM();if(!matrix)return;
  const point=svg.createSVGPoint();point.x=e.clientX;point.y=e.clientY;
  const {x,y}=point.matrixTransform(matrix.inverse());
  if(x>=0&&x<=w&&y>=0&&y<=d)place(x,y);
 };
 svg.onkeydown=e=>{
  const delta={ArrowLeft:[-.1,0],ArrowRight:[.1,0],ArrowUp:[0,-.1],ArrowDown:[0,.1]}[e.key];if(!delta)return;
  e.preventDefault();place(Math.max(0,Math.min(w,testPosition.x+delta[0])),Math.max(0,Math.min(d,testPosition.y+delta[1])));
 };
 $('test-hide').onclick=()=>{testPosition={...testPosition,visible:false};logTestPosition('out_of_sight');};
 $('test-export').onclick=()=>{
  const link=document.createElement('a');
  link.href=URL.createObjectURL(new Blob([JSON.stringify({source:'manual-test',units:'metres',floorPlan:plan,events:testEvents},null,2)],{type:'application/json'}));
  link.download='mother-studio-marker-test.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
 };
 showTestMarker();
}
function render(){
 if(!drawing)$('picture').classList.remove('drawing');
 $('draw').textContent=drawing?'Cancel drawing':'+ Draw an object region';
 const selected=$('camera').value||room.cameraId||room.cameras[0]?.id||'';
 const options=room.cameras.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}${c.live?'':' — no live picture'}</option>`).join('');if($('camera').innerHTML!==options)$('camera').innerHTML=options;$('camera').value=selected;
 if(!metadataDirty){$('room-name').value=room.name;$('room-notes').value=room.notes;$('share').checked=room.shareWithAgents;dimensionIds.forEach((id,i)=>{$(id).value=room.floorPlan?.[['widthM','depthM','heightM'][i]]??'';});}renderFloorPlan(room.floorPlan);
 $('notice').textContent=room.error;
 $('observer-state').textContent=(room.busy||busy)?'Analysing a frame…':room.enabled?'Observer on':'Observer off';
 $('observe').disabled=busy||room.busy||room.enabled||!selected;$('start').disabled=busy||room.busy||room.enabled||!selected;$('stop').disabled=!(room.enabled||room.busy||busy);
 const current=selectedObservation();$('view-analysis').disabled=!current;$('draw').disabled=!current;
 if(!current)view='live';
 $('view-live').setAttribute('aria-pressed',String(view==='live'));$('view-analysis').setAttribute('aria-pressed',String(view==='analysed'));
 const live=url('/cam/'+selected+'.mjpg');if($('live-picture').getAttribute('src')!==live)$('live-picture').src=live;
 $('live-picture').hidden=view!=='live';$('analysed-picture').hidden=view!=='analysed';$('overlay').toggleAttribute('hidden',view!=='analysed');
 const camera=room.cameras.find(c=>c.id===selected);$('observe').disabled ||= !camera?.live;$('start').disabled ||= !camera?.live;$('picture-empty').hidden=!!camera?.live||view==='analysed';
 if(current){const src=imgUrl(current.id);if($('analysed-picture').getAttribute('src')!==src)$('analysed-picture').src=src;}
 $('frame-state').textContent=view==='live'?'Live picture. AI overlays appear only on the analysed frame.':`${current.cameraName} · captured ${new Date(current.capturedAt).toLocaleTimeString()} · ${age(current.capturedAt)}s ago · approximate image regions`;
 if(current){
  $('summary').textContent=current.summary;$('answer').textContent=current.answer;
  $('observation-age').textContent=`Frame ${age(current.capturedAt)}s old · analysis took ${((current.analysedAt-current.capturedAt)/1000).toFixed(1)}s`;
  $('observation-age').className='badge'+(age(current.capturedAt)>30?' stale':'');
  $('changes').innerHTML=current.changes.length?'<h3>Possible changes</h3>'+current.changes.map(c=>`<p class="hint">${esc(c)}</p>`).join(''):'';
  $('uncertainties').innerHTML=current.uncertainties.map(c=>`<p>${esc(c)}</p>`).join('');
 }else{$('summary').textContent='Analyse this camera to begin.';$('answer').textContent='';$('observation-age').textContent='Not analysed yet';$('changes').innerHTML='';$('uncertainties').innerHTML='';}
 renderOverlay(current);renderInventory();renderObjects(current);renderPeople(current);
 $('history').innerHTML=room.history.slice().reverse().map(h=>`<p><strong>${esc(new Date(h.capturedAt).toLocaleTimeString())}</strong> · ${esc(h.summary)}</p>`).join('')||'No observations yet.';
}
function renderOverlay(current){
 if(drawing)return;
 const boxes=current?[...current.objects.map(o=>{const known=room.landmarks.find(l=>l.id===o.landmarkId&&l.cameraId===current.cameraId);return known?{...o,id:known.id,kind:'landmark',label:known.name,box:known.box}:{...o,kind:'object',label:o.name};}),...current.people.map((p,i)=>({...p,kind:'person',label:'Person '+(i+1)}))]:[];
 $('overlay').innerHTML=boxes.map(o=>`<g data-kind="${o.kind}" data-id="${esc(o.id)}"><rect class="${o.kind}" x="${o.box.x*1000}" y="${o.box.y*1000}" width="${o.box.w*1000}" height="${o.box.h*1000}"></rect><text transform="translate(${o.box.x*1000+7},${Math.max(25,o.box.y*1000+25)}) scale(1,${$('analysed-picture').naturalWidth/$('analysed-picture').naturalHeight||16/9})">${esc(o.label)}</text></g>`).join('');
 if(editing?.cameraId===$('camera').value){const b=editing.box;$('overlay').insertAdjacentHTML('beforeend',`<rect class="manual" x="${b.x*1000}" y="${b.y*1000}" width="${b.w*1000}" height="${b.h*1000}"></rect>`);}
 for(const el of $('overlay').querySelectorAll('g'))el.onclick=()=>{if(drawing)return;if(el.dataset.kind==='landmark'){editObject({...room.landmarks.find(l=>l.id===el.dataset.id)});}else if(el.dataset.kind==='object'){const o=current.objects.find(o=>o.id===el.dataset.id);editObject({...o,cameraId:current.cameraId});}else toast('Use the People panel below to confirm this person’s phone for this frame.');};
}
function renderInventory(){
 $('inventory').innerHTML=room.landmarks.map(l=>`<div class="room-item" data-id="${esc(l.id)}"><strong>${esc(l.name)}</strong><p>${esc(l.description)}</p><p>${esc(l.rules)}</p><div class="row"><button class="edit">Edit</button><button class="remove">Remove from inventory</button></div></div>`).join('')||'<p class="hint">No confirmed objects yet. Name an AI suggestion or draw a region on an analysed frame.</p>';
 for(const el of $('inventory').children){if(!el.dataset.id)continue;const l=room.landmarks.find(l=>l.id===el.dataset.id);el.querySelector('.edit').onclick=()=>editObject({...l});el.querySelector('.remove').onclick=async()=>{if(!confirm('Remove this label from the room inventory?'))return;try{room=await api('room',{action:'save',revision:room.revision,remove:l.id});render();}catch(e){toast(e.message);}};}
}
function renderObjects(current){
 $('suggestions').innerHTML=current?.objects.length?current.objects.map(o=>`<div class="room-item" data-id="${esc(o.id)}"><strong>${esc(o.name)}</strong><p>${esc(o.description)} · ${esc(o.certainty==='clear'?'Visible estimate':'Uncertain')}</p><button>${o.landmarkId?'Review known object':'Name & keep'}</button></div>`).join(''):'No objects suggested for this camera yet.';
 for(const el of $('suggestions').querySelectorAll('[data-id]'))el.querySelector('button').onclick=()=>{const o=current.objects.find(o=>o.id===el.dataset.id),known=room.landmarks.find(l=>l.id===o.landmarkId);editObject(known?{...known}:{...o,cameraId:current.cameraId});};
}
function renderPeople(current){
 const options=phones.map(p=>`<option value="${p.device}">Phone ${p.device}${roleFor(p.device)?' · '+esc(roleFor(p.device)):''}</option>`).join('');
 const markup=current?.people.length?current.people.map((p,i)=>{const match=room.bindings.find(b=>b.personId===p.id&&b.observationId===current.id);return `<div class="room-item" data-person="${esc(p.id)}"><strong>Person ${i+1}${match?' · Phone '+match.phone+(match.role?' / '+esc(match.role):''):''}</strong><p>${esc(p.description)}</p><p>${esc(p.activity)} · ${esc(p.certainty)}</p><div class="row"><select aria-label="Phone for person ${i+1}">${options}</select><button>Confirm for this frame</button></div></div>`;}).join(''):'<p class="hint">No people identified in this analysed frame.</p>';
 if($('people').dataset.markup===markup)return;$('people').innerHTML=markup;$('people').dataset.markup=markup;
 for(const el of $('people').querySelectorAll('[data-person]'))el.querySelector('button').onclick=async()=>{const phone=Number(el.querySelector('select').value);try{room=await api('room',{action:'bind',observationId:current.id,personId:el.dataset.person,phone,role:roleFor(phone)});render();}catch(e){toast(e.message);}};
}
async function action(type){
 if(!room)return;
 if(busy&&type!=='stop')return;
 if(type!=='stop')busy=true;render();
 try{room=await api('room',{action:type,cameraId:$('camera').value,interval:Number($('interval').value),question:$('question').value});if(type==='observe')view='analysed';render();}
 catch(e){toast(e.message);await load();}finally{busy=false;render();}
}
$('observe').onclick=()=>action('observe');$('start').onclick=()=>action('start');$('stop').onclick=()=>action('stop');
$('camera').onchange=()=>{drawing=false;view='live';render();};
$('view-live').onclick=()=>{drawing=false;view='live';render();};$('view-analysis').onclick=()=>{view='analysed';render();};
for(const id of ['room-name','room-notes','share',...dimensionIds])$(id).oninput=()=>{if(!metadataDirty)metadataRevision=room?.revision;metadataDirty=true;$('room-save-state').textContent='Unsaved room setup';};
$('save-room').onclick=async()=>{if(!room)return;const [widthM,depthM,heightM]=dimensionIds.map(id=>$(id).value);const floorPlan=[widthM,depthM,heightM].some(Boolean)?{...room.floorPlan,widthM:Number(widthM),depthM:Number(depthM),heightM:Number(heightM)}:null;try{room=await api('room',{action:'save',floorPlan,revision:metadataDirty?metadataRevision:room.revision,name:$('room-name').value,notes:$('room-notes').value,shareWithAgents:$('share').checked});metadataDirty=false;$('room-save-state').textContent='Saved. Continuous observation is stopped.';render();}catch(e){toast(e.message);}};
async function editObject(value){
 try{if(room.enabled||room.busy)room=await api('room',{action:'stop'});}catch(e){return toast(e.message);}
 editing={...value,id:room.landmarks.some(l=>l.id===value.id)?value.id:undefined,revision:room.revision};view='analysed';drawing=false;
 $('object-name').value=value.name||'';$('object-description').value=value.description||'';$('object-rules').value=value.rules||'';$('object-editor').hidden=false;render();toast('Observer paused. Review this object and save its name.');
}
$('save-object').onclick=async()=>{if(!editing)return;try{room=await api('room',{action:'save',revision:editing.revision,landmark:{...editing,name:$('object-name').value,description:$('object-description').value,rules:$('object-rules').value}});editing=null;$('object-editor').hidden=true;render();toast('Object confirmed in the room inventory');}catch(e){toast(e.message);}};
$('cancel-object').onclick=()=>{editing=null;drawing=false;origin=null;$('object-editor').hidden=true;render();};
$('draw').onclick=async()=>{if(drawing){drawing=false;origin=null;render();return;}try{room=await api('room',{action:'stop'});view='analysed';render();drawing=true;$('draw').textContent='Cancel drawing';$('picture').classList.add('drawing');toast('Drag a rectangle around the object in the analysed frame.');}catch(e){toast(e.message);}};
$('redraw-object').onclick=()=>{if(editing)$('draw').onclick();};
function point(e){const r=$('analysed-picture').getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
$('overlay').onpointerdown=e=>{if(!drawing)return;origin=point(e);$('overlay').setPointerCapture(e.pointerId);e.preventDefault();};
$('overlay').onpointermove=e=>{if(!drawing||!origin)return;const end=point(e),b={x:Math.min(origin.x,end.x),y:Math.min(origin.y,end.y),w:Math.abs(end.x-origin.x),h:Math.abs(end.y-origin.y)};document.getElementById('draw-preview')?.remove();$('overlay').insertAdjacentHTML('beforeend',`<rect id="draw-preview" class="manual" x="${b.x*1000}" y="${b.y*1000}" width="${b.w*1000}" height="${b.h*1000}"></rect>`);};
$('overlay').onpointerup=e=>{if(!drawing||!origin)return;const end=point(e),b={x:Math.min(origin.x,end.x),y:Math.min(origin.y,end.y),w:Math.abs(end.x-origin.x),h:Math.abs(end.y-origin.y)};origin=null;drawing=false;$('picture').classList.remove('drawing');if(b.w<.01||b.h<.01)return toast('Draw a larger region around the object.');editObject({...editing,...(editing?{name:$('object-name').value,description:$('object-description').value,rules:$('object-rules').value}:{}),cameraId:$('camera').value,box:b});};
$('overlay').onpointercancel=()=>{origin=null;drawing=false;$('picture').classList.remove('drawing');};
window.addEventListener('beforeunload',e=>{if(metadataDirty||editing){e.preventDefault();e.returnValue='';}});
load();setInterval(()=>{if(!busy&&!drawing)load();},3000);
