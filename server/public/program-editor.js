const {$,esc,api,toast,url}=Setup;
let library=[],draft=null,sceneIndex=0,dirty=false,saving=false;
const uid=prefix=>prefix+'_'+crypto.randomUUID().slice(0,8);
const cue=(type='speak',text='')=>({id:uid('c'),type,text,seconds:type==='pause'?8:45,turns:2,adapt:false,delivery:'',role:'',cue:''});
function blank(count=1){const roles=Array.from({length:count},(_,i)=>({id:'role_'+(i+1),name:'Role '+String.fromCharCode(65+i),brief:''}));return{title:count===4?'Gallery quartet — example':'Untitled program',description:'',roles,scenes:[{id:uid('scene'),name:'Arrival',together:true,tracks:Object.fromEntries(roles.map((r,i)=>[r.id,count===4?[cue('speak',['Walk slowly towards the far wall.','Remain near the entrance and look around.','Find a place from which you can observe the room.','Stand still for a moment and listen.'][i]),cue('pause'),cue('wait','Confirm from the desk when this role is ready.')]:[]]))}]};}
function changed(){dirty=true;$('save-state').textContent='Unsaved changes';$('save').disabled=saving;$('choose').hidden=true;}
async function refreshLibrary(){({programs:library}=await api('programs'));renderLibrary();}
function renderLibrary(){$('library').innerHTML=library.length?library.map(p=>`<div class="lib-row"><button data-id="${esc(p.id)}" aria-pressed="${draft?.id===p.id}">${esc(p.title)}<small>${p.roles.length} roles · ${p.scenes.length} scenes · v${p.revision}</small></button><button class="run" data-run="${esc(p.id)}" title="Run ${esc(p.title)}">▶ Run</button></div>`).join(''):'<p class="hint">No saved programs yet.</p>';for(const b of $('library').querySelectorAll('[data-run]'))b.onclick=()=>MotherRun.open(b.dataset.run,{after:()=>window.open(url('/control'),'earpiece_control')});for(const b of $('library').querySelectorAll('button[data-id]'))b.onclick=()=>{if(dirty&&!confirm('Discard unsaved changes and open this program?'))return;open(structuredClone(library.find(p=>p.id===b.dataset.id)));};}
function open(value){draft=value;sceneIndex=0;dirty=false;$('empty').hidden=true;$('editor').hidden=false;render();renderLibrary();}
function newDraft(n){if(dirty&&!confirm('Discard unsaved changes?'))return;open(blank(n));changed();}
$('new').onclick=()=>newDraft(1);$('example').onclick=()=>newDraft(4);
function render(){
 $('program-title').value=draft.title;$('description').value=draft.description;$('editor-heading').textContent=draft.id?'Edit program':'New program';$('revision').textContent=draft.revision?'Version '+draft.revision:'Draft';$('save-state').textContent=dirty?'Unsaved changes':'Saved';$('save').disabled=!dirty||saving;$('choose').hidden=!draft.id||dirty;$('choose').onclick=()=>MotherRun.open(draft.id,{after:()=>window.open(url('/control'),'earpiece_control')});
 $('roles').innerHTML=draft.roles.map((r,i)=>`<div class="role-definition"><label for="role-${i}">Role ${i+1}</label><input id="role-${i}" value="${esc(r.name)}" maxlength="80"><textarea rows="2" placeholder="Private role instructions" aria-label="Instructions for ${esc(r.name)}">${esc(r.brief)}</textarea><button class="remove-role quiet actions" data-index="${i}">Remove role</button></div>`).join('');
 for(const [i,el] of [...$('roles').children].entries()){el.querySelector('input').oninput=e=>{draft.roles[i].name=e.target.value;changed();};el.querySelector('input').onchange=renderScene;el.querySelector('textarea').oninput=e=>{draft.roles[i].brief=e.target.value;changed();};el.querySelector('button').onclick=()=>{if(draft.roles.length===1)return toast('Keep at least one role.');if(!confirm('Remove this role and its cues from every scene?'))return;const id=draft.roles[i].id;draft.roles.splice(i,1);for(const s of draft.scenes)delete s.tracks[id];changed();render();};}
 renderScene();
}
$('program-title').oninput=e=>{draft.title=e.target.value;changed();};$('description').oninput=e=>{draft.description=e.target.value;changed();};
$('add-role').onclick=()=>{if(draft.roles.length>=32)return toast('A program supports up to 32 roles.');const id=uid('role');draft.roles.push({id,name:'Role '+(draft.roles.length+1),brief:''});for(const s of draft.scenes)s.tracks[id]=[];changed();render();};
$('add-scene').onclick=()=>{draft.scenes.push({id:uid('scene'),name:'Scene '+(draft.scenes.length+1),together:true,tracks:Object.fromEntries(draft.roles.map(r=>[r.id,[]]))});sceneIndex=draft.scenes.length-1;changed();renderScene();};
$('scene-name').oninput=e=>{draft.scenes[sceneIndex].name=e.target.value;changed();};$('scene-name').onchange=renderScene;
$('together').onchange=e=>{draft.scenes[sceneIndex].together=e.target.checked;changed();};
function moveScene(delta){const to=sceneIndex+delta;if(to<0||to>=draft.scenes.length)return;[draft.scenes[to],draft.scenes[sceneIndex]]=[draft.scenes[sceneIndex],draft.scenes[to]];sceneIndex=to;changed();renderScene();}
$('scene-up').onclick=()=>moveScene(-1);$('scene-down').onclick=()=>moveScene(1);
$('remove-scene').onclick=()=>{if(draft.scenes.length===1)return toast('Keep at least one scene.');if(!confirm('Remove this scene and all of its role tracks?'))return;draft.scenes.splice(sceneIndex,1);sceneIndex=Math.max(0,sceneIndex-1);changed();renderScene();};
const types={speak:'Speech',pause:'Silence',wait:'Wait for desk',reply:'Question + reply',conversation:'Conversation',await:'Wait for role'};
function renderScene(){
 const scene=draft.scenes[sceneIndex];$('scene-name').value=scene.name;$('together').checked=scene.together;
 $('scene-tabs').innerHTML=draft.scenes.map((s,i)=>`<button data-scene="${i}" aria-pressed="${i===sceneIndex}">${i+1}. ${esc(s.name)}</button>`).join('');for(const b of $('scene-tabs').children)b.onclick=()=>{sceneIndex=Number(b.dataset.scene);renderScene();};
 $('tracks').innerHTML=draft.roles.map(r=>`<section class="role-track" data-role="${esc(r.id)}"><h3>${esc(r.name)}</h3><div class="cues">${scene.tracks[r.id].map(c=>`<div class="cue" data-cue="${esc(c.id)}"><div class="row"><select class="type" aria-label="Cue type">${Object.entries(types).map(([v,n])=>`<option value="${v}" ${c.type===v?'selected':''}>${n}</option>`).join('')}</select><button class="up" title="Move cue earlier">↑</button><button class="down" title="Move cue later">↓</button><button class="remove" title="Remove cue">×</button></div><div class="cue-id">${esc(c.id)}</div>
 ${['speak','reply','conversation','wait'].includes(c.type)?`<textarea class="text" aria-label="Cue text" placeholder="${c.type==='wait'?'What should the desk check?':'Spoken passage or question'}">${esc(c.text)}</textarea>`:''}
 ${['speak','reply','conversation'].includes(c.type)?`<label class="check"><input class="adapt" type="checkbox" ${c.adapt?'checked':''}> Mother may adapt this passage</label><label>Delivery / conversation boundaries<input class="delivery" value="${esc(c.delivery)}" placeholder="Quietly, with hesitation; remain on this subject"></label><button class="preview">Preview written line at desk</button>`:''}
 ${['pause','reply','conversation'].includes(c.type)?`<label>${c.type==='pause'?'Silence in seconds':'Reply timeout in seconds'}<input class="seconds" type="number" min="0" max="600" value="${c.seconds}"></label>`:''}
 ${c.type==='conversation'?`<label>Maximum reply exchanges<input class="turns" type="number" min="1" max="6" value="${c.turns}"></label>`:''}
 ${c.type==='await'?`<label>Wait for role<select class="dependency-role"><option value="">Choose a role</option>${draft.roles.filter(x=>x.id!==r.id).map(x=>`<option value="${esc(x.id)}" ${c.role===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label><label>When they finish<select class="dependency-cue"><option value="">This scene</option>${(scene.tracks[c.role]||[]).map(x=>`<option value="${esc(x.id)}" ${c.cue===x.id?'selected':''}>${esc(x.id)} — ${esc(types[x.type])}</option>`).join('')}</select></label>`:''}
 </div>`).join('')}</div><button class="add-cue actions">+ Add cue</button></section>`).join('');
 for(const track of $('tracks').children){const rid=track.dataset.role, cues=scene.tracks[rid];track.querySelector('.add-cue').onclick=()=>{cues.push(cue());changed();renderScene();};
 for(const card of track.querySelectorAll('.cue')){const i=cues.findIndex(c=>c.id===card.dataset.cue), c=cues[i];
 card.querySelector('.type').onchange=e=>{c.type=e.target.value;changed();renderScene();};
 for(const field of ['text','delivery','seconds','turns','adapt']){const el=card.querySelector('.'+field);if(el)el.oninput=e=>{c[field]=field==='adapt'?e.target.checked:['seconds','turns'].includes(field)?Number(e.target.value):e.target.value;changed();};}
 const dep=card.querySelector('.dependency-role');if(dep)dep.onchange=e=>{c.role=e.target.value;c.cue='';changed();renderScene();};const dc=card.querySelector('.dependency-cue');if(dc)dc.onchange=e=>{c.cue=e.target.value;changed();};
 card.querySelector('.remove').onclick=()=>{cues.splice(i,1);changed();renderScene();};for(const [cl,delta] of [['up',-1],['down',1]])card.querySelector('.'+cl).onclick=()=>{const to=i+delta;if(to<0||to>=cues.length)return;[cues[i],cues[to]]=[cues[to],cues[i]];changed();renderScene();};
 const preview=card.querySelector('.preview');if(preview)preview.onclick=()=>{const a=$('preview-audio');a.src=url('/api/preview?text='+encodeURIComponent(c.text.slice(0,600)));a.play().catch(()=>toast('Could not preview this line. Check the voice service.'));};
 }}
}
$('save').onclick=async()=>{if(saving)return;saving=true;$('save').disabled=true;const sent=JSON.stringify(draft);try{const {program}=await api('programs',JSON.parse(sent));if(JSON.stringify(draft)===sent){draft=program;dirty=false;}else{draft.id=program.id;draft.revision=program.revision;}await refreshLibrary();render();toast('Program saved');}catch(e){toast(e.message);}finally{saving=false;$('save').disabled=!dirty;}};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
refreshLibrary().catch(e=>toast(e.message));

// AI writing is separate from the saved library and the session's immutable score.
let generationController=null, pendingGenerated=null;
const generationFields=['draft-brief','draft-roles','draft-minutes'];
function storeWritingBrief(){try{sessionStorage.setItem('mother-writing-brief',JSON.stringify({brief:$('draft-brief').value,roles:$('draft-roles').value,minutes:$('draft-minutes').value}));}catch{}}
try{const saved=JSON.parse(sessionStorage.getItem('mother-writing-brief')||'null');if(saved){$('draft-brief').value=saved.brief||'';$('draft-roles').value=saved.roles||4;$('draft-minutes').value=saved.minutes||10;}}catch{}
for(const field of generationFields)$(field).addEventListener('input',storeWritingBrief);
function writingBusy(busy){$('generate-draft').disabled=busy;$('cancel-draft').hidden=!busy;for(const id of generationFields)$(id).disabled=busy;}
function openGenerated(){
 if(!pendingGenerated)return;
 if(dirty&&!confirm('Replace the unsaved draft currently in the editor with the generated draft?'))return;
 open(structuredClone(pendingGenerated));changed();
 $('open-generated').hidden=true;
 $('generation-state').textContent='First draft ready. Edit the scenes and role tracks below, then save your program.';
}
$('open-generated').onclick=openGenerated;
$('generate-draft').onclick=async()=>{
 if(generationController)return;
 const request={brief:$('draft-brief').value.trim(),roles:Number($('draft-roles').value),minutes:Number($('draft-minutes').value)};
 if(!request.brief){$('generation-state').textContent='Describe what you want the performance to achieve.';$('draft-brief').focus();return;}
 if(!Number.isInteger(request.roles)||request.roles<1||request.roles>16||!Number.isFinite(request.minutes)||request.minutes<1||request.minutes>120){$('generation-state').textContent='Choose 1–16 roles and approximately 1–120 minutes.';return;}
 storeWritingBrief();generationController=new AbortController();writingBusy(true);
 $('generation-state').textContent='Mother is writing the scenes and role tracks… this can take a minute.';
 try{
  const result=await api('program-draft',request,{signal:generationController.signal});
  pendingGenerated=result.program;
  $('generated-summary').textContent=`${pendingGenerated.title} — ${pendingGenerated.roles.length} roles, ${pendingGenerated.scenes.length} scenes. Ready to edit; not saved or selected for a session.`;
  $('generated-result').hidden=false;$('open-generated').hidden=false;
  $('generation-state').textContent='Your first draft is ready. Open it when you want to edit.';
  if(!draft)openGenerated();
 }catch(error){$('generation-state').textContent=error.name==='AbortError'?'Writing cancelled. Your description and editor draft are preserved.':error.message;}
 finally{generationController=null;writingBusy(false);}
};
$('cancel-draft').onclick=()=>generationController?.abort();
window.addEventListener('beforeunload',e=>{if(generationController){e.preventDefault();e.returnValue='';}});
