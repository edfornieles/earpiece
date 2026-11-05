// Session selection and live run controls; never opens or forwards a microphone.
(() => {
 const key=new URLSearchParams(location.search).get('k') || '';
 const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const url=route=>route+(route.includes('?')?'&':'?')+'k='+encodeURIComponent(key);
 async function api(route,body){const res=await fetch(url('/api/'+route),body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await res.json();if(!res.ok||value.error)throw Error(value.error||'Request failed');return value;}
 let state=null,library=[],chosen=null,assignments={},dirty=false,busy=false,loaded=false;
 const selection=$('program-select'), live=$('program-live');
 if(selection){
  $('program-edit-link').href=url('/programs');
  selection.onchange=()=>{chosen=library.find(p=>p.id===selection.value)||null;assignments=Object.fromEntries((chosen?.roles||[]).map((r,i)=>[r.id,i+1]));dirty=true;renderAssignments();selectionStatus('Unsaved program selection');};
  $('program-latest').onclick=()=>{const latest=library.find(p=>p.id===chosen?.id);if(!latest)return;chosen=structuredClone(latest);assignments=Object.fromEntries(chosen.roles.map((r,i)=>[r.id,assignments[r.id]||i+1]));dirty=true;renderAssignments();selectionStatus('Latest version loaded — save this choice to use it');};
  $('program-timing').onchange=()=>{dirty=true;selectionStatus('Unsaved program selection');};
  $('save-program-selection').onclick=async()=>{if(busy||!state)return;busy=true;selectionStatus('Saving…');renderSelection();
   try{await api('program-selection',{instance:state.instance,id:chosen?.id||null,revision:chosen?.revision,assignments,timing:$('program-timing').value});dirty=false;await load();selectionStatus('Saved for the next recording');}
   catch(e){selectionStatus(e.message);}finally{busy=false;renderSelection();}
  };
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
 }
 function selectionStatus(message){$('program-selection-state').textContent=message;$('save-program-selection').disabled=!state||!state.standby||busy;}
 function renderAssignments(){
  $('program-assignments').innerHTML=chosen?chosen.roles.map(r=>`<label>${esc(r.name)}<select data-role="${esc(r.id)}">${Array.from({length:state.maxPhones||4},(_,i)=>`<option value="${i+1}" ${assignments[r.id]===i+1?'selected':''}>Phone ${i+1}</option>`).join('')}</select></label>`).join(''):'';
  for(const el of $('program-assignments').querySelectorAll('select')){el.disabled=!state.standby||busy;el.onchange=()=>{assignments[el.dataset.role]=Number(el.value);dirty=true;selectionStatus('Unsaved program selection');};}
  $('program-latest').hidden=!chosen||!state.standby||!library.some(p=>p.id===chosen.id&&p.revision>chosen.revision);
  $('program-version').textContent=chosen?`${chosen.roles.length} roles · ${chosen.scenes.length} scenes · version ${chosen.revision}. This version is copied into the session when you save your choice.`:'Free direction: use the AI brief and live desk without a score.';
 }
 function renderSelection(){
  if(dirty&&loaded){selection.disabled=!state.standby||busy;$('program-timing').disabled=!state.standby||busy;for(const el of $('program-assignments').querySelectorAll('select'))el.disabled=!state.standby||busy;$('save-program-selection').disabled=!state.standby||busy;return;}
  const saved=state.selection;
  if(!dirty){
   const requested=!loaded&&new URLSearchParams(location.search).get('program');
   chosen=requested?library.find(p=>p.id===requested)||saved?.snapshot:saved?.snapshot||null;
   assignments=saved&&chosen?.id===saved.snapshot.id?{...saved.assignments}:Object.fromEntries((chosen?.roles||[]).map((r,i)=>[r.id,i+1]));
   $('program-timing').value=saved?.timing||'shared';
   if(requested&&chosen&&(!saved||chosen.id!==saved.snapshot.id||chosen.revision!==saved.snapshot.revision)){dirty=true;selectionStatus('Check role assignments, then save this choice');}
  }
  const choices=[...library];if(chosen&&!choices.some(p=>p.id===chosen.id))choices.push(chosen);
  selection.innerHTML='<option value="">No program — free direction</option>'+choices.map(p=>`<option value="${esc(p.id)}">${esc(p.id===chosen?.id?chosen.title:p.title)}</option>`).join('');selection.value=chosen?.id||'';
  selection.disabled=!state.standby||busy;$('program-timing').disabled=!state.standby||busy;
  renderAssignments();
  if(!dirty)selectionStatus(state.standby?(chosen?'Saved for the next recording':'No program selected'):'Program and roles are locked for this recording.');
  else $('save-program-selection').disabled=!state.standby||busy;
  loaded=true;
 }
 const names={prepared:'Prepared',ready:'Next cue',speaking:'Speaking',thinking:'Mother deciding',reply:'Waiting for a reply',silence:'Silence',waiting:'Waiting for desk',dependency:'Waiting for another role',sceneWait:'Waiting at scene boundary',complete:'Finished',paused:'Paused',attention:'Needs attention',interrupted:'Live interruption',interventionReply:'Conversation after interruption'};
 function renderLive(){
  const {selection:sel,run}=state;
  const heading=sel?`${sel.snapshot.title} · v${sel.snapshot.revision}`:'No performance program selected';
  let markup=`<div class="row between"><h2>${esc(heading)}</h2><a href="${url('/session')}" target="earpiece_pages">${sel?'Session setup ↗':'Choose a program ↗'}</a></div>`;
  if(sel){markup+=`<p class="hint">${esc(run.status)} · ${sel.timing==='shared'?'Shared scene timing':'Independent role timing'}. Start each assigned participant visit before starting the score.</p><div class="row program-controls">`;
   if(['prepared','stopped','completed'].includes(run.status))markup+=`<button data-action="start" ${state.standby?'disabled':''}>${run.status==='completed'?'Restart program':'Start program'}</button>`;
   if(run.status==='running')markup+='<button data-action="pause">Pause all roles</button>';
   if(run.status==='paused')markup+='<button data-action="resume">Resume program</button>';
   if(['running','paused'].includes(run.status))markup+='<button data-action="stop">Stop program</button>';
   markup+='</div><div class="program-run-roles">';
   for(const role of sel.snapshot.roles){const r=run.roles.find(r=>r.role===role.id)||{phone:sel.assignments[role.id],scene:0,cue:0,status:'prepared'},scene=sel.snapshot.scenes[r.scene],cue=scene?.tracks[role.id]?.[r.cue];
    markup+=`<div class="program-run-role ${r.status==='attention'?'attention':''}"><strong>${esc(role.name)} · Phone ${r.phone}</strong><p>${esc(scene?.name||'End')} · ${esc(names[r.status]||r.status)}</p>${cue?`<p>${esc((cue.text||({pause:'Silence: '+cue.seconds+' seconds',await:'Wait for role',wait:'Wait for desk'}[cue.type])||cue.type).slice(0,160))}</p>`:''}${r.reason?`<p>${esc(r.reason)}</p>`:''}`;
    if(run.status==='running'&&r.status!=='complete')markup+=`<div class="row"><button data-action="resume" data-phone="${r.phone}">Repeat / resume cue</button><button data-action="next" data-phone="${r.phone}">Continue cue →</button></div>`;
    markup+='</div>';
   }markup+='</div>';
  }
  // Keep controls stable during polling so an update cannot swallow a pointer press.
  if(live.dataset.markup!==markup){live.innerHTML=markup;live.dataset.markup=markup;
   for(const b of live.querySelectorAll('[data-action]'))b.onclick=async()=>{if(busy)return;if(b.dataset.action==='start'&&!confirm('Start the selected score for all assigned roles now?'))return;if(b.dataset.action==='stop'&&!confirm('Stop the program? Starting it again begins at the first scene.'))return;busy=true;b.disabled=true;
    try{state={...state,...await api('program-run',{instance:state.instance,action:b.dataset.action,phone:b.dataset.phone?Number(b.dataset.phone):undefined})};live.dataset.markup='';renderLive();}
    catch(e){const status=$('program-run-error');if(status)status.textContent=e.message;else alert(e.message);}
    finally{busy=false;b.disabled=false;}
   };
  }
 }
 async function load(){
  try{
   const data=await api('program-run');
   if(selection){
    if(state&&data.instance!==state.instance&&dirty){selectionStatus('The session changed. Reload this page before saving.');$('save-program-selection').disabled=true;return;}
    const [saved,setup]=await Promise.all([api('programs'),api('setup')]);library=saved.programs;if(setup.instance!==data.instance)throw Error('Session changing — reconnecting…');state={...data,maxPhones:setup.maxPhones};renderSelection();
   }else{state=data;renderLive();}
   if($('program-run-error'))$('program-run-error').textContent='';
  }catch(e){if(selection)selectionStatus(e.message);else if($('program-run-error'))$('program-run-error').textContent=e.message;}
 }
 if(selection||live){load();setInterval(()=>{if(!busy)load();},2500);}
})();
