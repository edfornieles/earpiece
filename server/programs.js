// Saved scores and a server-owned playhead per role. No participant audio is shared here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const copy = value => JSON.parse(JSON.stringify(value));
const TYPES = new Set(['speak', 'pause', 'wait', 'reply', 'conversation', 'await']);
function validateProgram(input) {
  if (!input || typeof input !== 'object') throw Error('Enter a program.');
  const text = (v, max) => String(v || '').trim().slice(0, max);
  const id = v => { if (!/^[a-zA-Z0-9_-]{1,80}$/.test(v || '') || ['__proto__','prototype','constructor'].includes(v)) throw Error('Use unique role, scene and cue identifiers.'); return v; };
  const unique = list => { if (new Set(list).size !== list.length) throw Error('Identifiers must be unique.'); };
  if (!Array.isArray(input.roles) || !input.roles.length || input.roles.length > 32) throw Error('Add between 1 and 32 roles.');
  const roles = input.roles.map(r => ({ id:id(r.id), name:text(r.name, 80) || r.id, brief:text(r.brief, 4000) })); unique(roles.map(r=>r.id));
  if (!Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > 100) throw Error('Add between 1 and 100 scenes.');
  const scenes = input.scenes.map(scene => {
    const tracks = {};
    for (const role of roles) {
      const cues = scene.tracks?.[role.id] || [];
      if (!Array.isArray(cues) || cues.length > 100) throw Error('A role track can contain up to 100 cues per scene.');
      tracks[role.id] = cues.map(c => {
        if (!TYPES.has(c.type)) throw Error('Choose a supported cue type.');
        const cue = { id:id(c.id), type:c.type, text:text(c.text, 6000), delivery:text(c.delivery, 1000), adapt:!!c.adapt, seconds:Math.max(0, Math.min(600, Number(c.seconds) || 0)), turns:Math.max(1, Math.min(6, Math.floor(Number(c.turns) || 2))), role:text(c.role, 80), cue:text(c.cue, 80) };
        if (['speak','reply','conversation'].includes(cue.type) && !cue.text) throw Error('Speech and question cues need text.');
        if (cue.type === 'await' && (!roles.some(r=>r.id===cue.role) || cue.role===role.id)) throw Error('A dependency must refer to another role.');
        return cue;
      });
      unique(tracks[role.id].map(c=>c.id));
    }
    for (const cues of Object.values(tracks)) for (const c of cues) if (c.type==='await' && c.cue && !tracks[c.role].some(t=>t.id===c.cue)) throw Error('The dependency refers to a cue that does not exist in this scene.');
    // Sequential order plus cross-role prerequisites must form a directed acyclic graph.
    const dependencies=new Map();
    for(const [rid,cues] of Object.entries(tracks)) for(let i=0;i<cues.length;i++) {
      const c=cues[i], required=[];
      if(i)required.push(`${rid}:${cues[i-1].id}`);
      if(c.type==='await'){const target=c.cue || tracks[c.role].at(-1)?.id;if(target)required.push(`${c.role}:${target}`);}
      dependencies.set(`${rid}:${c.id}`,required);
    }
    const finished=new Set();let progress=true;
    while(progress){progress=false;for(const [key,required] of dependencies)if(!finished.has(key)&&required.every(x=>finished.has(x))){finished.add(key);progress=true;}}
    if(finished.size!==dependencies.size)throw Error('These role dependencies form a loop. Give at least one role a way to continue.');
    return { id:id(scene.id), name:text(scene.name, 120) || 'Untitled scene', together:scene.together !== false, tracks };
  }); unique(scenes.map(s=>s.id));
  const title = text(input.title, 120); if (!title) throw Error('Give the program a title.');
  return { title, description:text(input.description, 12000), roles, scenes };
}
class ProgramStore {
  constructor(dir) { this.dir=dir; fs.mkdirSync(dir,{recursive:true}); }
  list() { return fs.readdirSync(this.dir).filter(f=>/^[a-f0-9-]+\.json$/.test(f)).map(f=>{try{return JSON.parse(fs.readFileSync(path.join(this.dir,f),'utf8'));}catch{return null;}}).filter(Boolean).sort((a,b)=>b.updated.localeCompare(a.updated)); }
  get(id) { if (!/^[a-f0-9-]{36}$/.test(id || '')) return null; try{return JSON.parse(fs.readFileSync(path.join(this.dir,id+'.json'),'utf8'));}catch{return null;} }
  save(input) {
    const value=validateProgram(input), old=input.id ? this.get(input.id) : null;
    if (input.id && !old) throw Error('That program no longer exists.');
    if (old && input.revision !== old.revision) throw Error('This program was edited elsewhere. Reload it before saving.');
    const saved={...value,id:old?.id || crypto.randomUUID(),revision:(old?.revision || 0)+1,updated:new Date().toISOString()};
    const file=path.join(this.dir,saved.id+'.json'), temp=file+'.tmp';
    fs.writeFileSync(temp,JSON.stringify(saved,null,2)); fs.renameSync(temp,file); return saved;
  }
}
class ProgramRunner {
  constructor(hooks) { this.h=hooks; this.selection=null; this.roles=[]; this.status='idle'; this.serial=0; }
  configure(selection) { this.stop(); this.selection=selection ? copy(selection) : null; this.roles=[]; this.status=selection?'prepared':'idle'; this.emit(); }
  token(phone) { const r=this.roles.find(r=>r.phone===phone);return r?`${this.serial}:${r.epoch}`:null; }
  manages(phone) { return !!this.selection && Object.values(this.selection.assignments).includes(phone); }
  emit() { this.h.change?.(this.view()); }
  view() { return {status:this.status, program:this.selection?.snapshot ? {id:this.selection.snapshot.id,title:this.selection.snapshot.title,revision:this.selection.snapshot.revision}:null,timing:this.selection?.timing,assignments:this.selection?.assignments || {},roles:this.roles.map(r=>({role:r.id,phone:r.phone,scene:r.scene,cue:r.cue,status:r.status,reason:r.reason || '',remaining:r.deadline?Math.max(0,(r.deadline-Date.now())/1000):null,completed:[...r.completed]}))}; }
  start() {
    if (!this.selection) throw Error('Select a program in Session first.');
    if (['running','paused'].includes(this.status)) throw Error('Stop the current program before starting again.');
    for (const role of this.selection.snapshot.roles) { const phone=this.selection.assignments[role.id]; if (!this.h.ready(phone)) throw Error(`Prepare ${role.name} on Phone ${phone}: start its participant visit and connect its earpiece first.`); }
    this.serial++; this.status='running';
    this.roles=this.selection.snapshot.roles.map(r=>({id:r.id,phone:this.selection.assignments[r.id],visit:this.h.visit(this.selection.assignments[r.id]),scene:0,cue:0,status:'ready',epoch:0,completed:new Set(),exchanges:0}));
    this.h.event('program_start',{program:this.selection.snapshot.id,revision:this.selection.snapshot.revision,assignments:this.selection.assignments}); this.emit(); this.tick();
  }
  valid(r, epoch) { return this.status==='running' && r.epoch===epoch && this.h.visit(r.phone)===r.visit; }
  current(r) { const scene=this.selection.snapshot.scenes[r.scene]; return {scene,cue:scene?.tracks[r.id]?.[r.cue],role:this.selection.snapshot.roles.find(x=>x.id===r.id)}; }
  hold(phone, reason='Paused by desk', automatic=false) {
    if (!['running','paused'].includes(this.status)) return;
    for(const r of this.roles.filter(r=>phone==null || r.phone===phone)) {
      if (r.status==='complete') continue;
      r.epoch++; r.deadline=null; r.status=automatic?'interrupted':'paused';r.reason=reason;r.exchanges=0;
      this.h.cancel(r.phone); this.h.event('program_hold',{role:r.id,reason});
    } this.emit();
  }
  pause() { if(!['running','paused'].includes(this.status))throw Error('Start the program before pausing.'); this.hold(null); this.status='paused'; this.emit(); }
  resume(phone) {
    if(!['running','paused'].includes(this.status))throw Error('Start the selected program first.');
    const targets=this.roles.filter(r=>phone==null || r.phone===phone).filter(r=>r.status!=='complete');
    for (const r of targets) if(!this.h.ready(r.phone) || this.h.visit(r.phone)!==r.visit)throw Error('A participant or phone changed. Stop and restart the program after checking assignments.');
    this.status='running';
    for(const r of targets) if(phone!=null || ['paused','interrupted','attention','interventionReply'].includes(r.status)){r.epoch++;this.h.cancel(r.phone);r.deadline=null;r.status='ready';r.reason='';r.exchanges=0;}
    this.emit();this.tick();
  }
  stop() { this.serial++;for(const r of this.roles){r.epoch++;r.deadline=null;this.h.cancel(r.phone);}this.status=this.selection?'stopped':'idle';this.emit(); }
  next(phone) {
    if(this.status!=='running')throw Error('Resume the program before advancing a cue.');
    const r=this.roles.find(x=>x.phone===phone);if(!r || r.status==='complete')return;
    if(this.h.visit(phone)!==r.visit)throw Error('The participant changed. Stop and restart the program.');
    r.epoch++;this.h.cancel(phone);this.advance(r);this.tick();
  }
  advance(r) {
    const {scene,cue}=this.current(r);
    if(cue)r.completed.add(`${scene.id}:${cue.id}`);
    this.h.event('program_cue_end',{role:r.id,scene:r.scene,cue:r.cue});
    r.epoch++;r.cue++;r.deadline=null;r.status='ready';r.reason='';r.exchanges=0;this.emit();
  }
  attention(r,error) { r.epoch++;r.status='attention';r.reason=error.message || String(error);r.deadline=null;this.h.cancel(r.phone);this.emit(); }
  async execute(r,cue) {
    const epoch=r.epoch; r.status='speaking';this.emit();
    try {
      await this.h.perform(r.phone,cue,{...this.current(r),program:this.selection.snapshot});
      if(!this.valid(r,epoch))return;
      if(['reply','conversation'].includes(cue.type)){r.status='reply';r.deadline=Date.now()+(cue.seconds || 45)*1000;this.emit();}
      else this.advance(r);
    }catch(error){if(this.valid(r,epoch))this.attention(r,error);}
  }
  async reply(phone,text,director=false) {
    const r=this.roles.find(x=>x.phone===phone);
    if(!r || this.status!=='running')return;
    const {cue}=this.current(r), epoch=r.epoch;
    if(['interrupted','interventionReply'].includes(r.status)) {
      if(r.status==='interventionReply' && director)return;
      r.status='thinking';r.deadline=null;this.emit();
      try {
        const decision=await this.h.decide(phone,text,{...this.current(r),program:this.selection.snapshot,director,exchanges:r.exchanges});
        if(!this.valid(r,epoch))return;
        r.reason=decision.reason || 'Returning to the score';r.exchanges++;
        if(decision.action==='resume' || r.exchanges>2){r.status='ready';this.emit();return;}
        if(decision.action==='respond' && decision.text){r.status='speaking';this.emit();await this.h.perform(phone,{type:'speak',text:decision.text,adapt:false},{...this.current(r),program:this.selection.snapshot});if(!this.valid(r,epoch))return;}
        r.status='interventionReply';r.deadline=Date.now()+45000;this.emit();
      }catch(error){if(this.valid(r,epoch))this.attention(r,error);}return;
    }
    if(r.status!=='reply')return;
    r.deadline=null;
    if(cue.type==='reply'){this.advance(r);return;}
    r.status='thinking';this.emit();
    try {
      const response=await this.h.converse(phone,text,{...this.current(r),program:this.selection.snapshot,exchanges:r.exchanges});
      if(!this.valid(r,epoch))return;
      r.status='speaking';this.emit();
      await this.h.perform(phone,{type:'speak',text:response,adapt:false},{...this.current(r),program:this.selection.snapshot});
      if(!this.valid(r,epoch))return;
      r.exchanges++;
      if(r.exchanges>=cue.turns)this.advance(r);
      else {r.status='reply';r.deadline=Date.now()+(cue.seconds || 45)*1000;this.emit();}
    }catch(error){if(this.valid(r,epoch))this.attention(r,error);}
  }
  tick() {
    if(this.status!=='running')return;
    const now=Date.now();
    for(const r of this.roles) {
      if(r.status==='complete')continue;
      if(this.h.visit(r.phone)!==r.visit){if(r.status!=='attention')this.attention(r,Error('Participant changed. Stop and restart the program.'));continue;}
      if(!this.h.ready(r.phone)){if(!['paused','attention','interrupted'].includes(r.status))this.hold(r.phone,'Phone or earpiece unavailable');continue;}
      if(r.deadline && now>=r.deadline){if(r.status==='silence')this.advance(r);else this.attention(r,Error('No reply yet. Continue or repeat this cue from the desk.'));}
      const {scene,cue}=this.current(r);
      if(!scene){r.status='complete';this.emit();continue;}
      if(r.status==='sceneWait')continue;
      if(r.status==='dependency') {
        const other=this.roles.find(x=>x.id===cue.role);
        if(other && (cue.cue?other.completed.has(`${scene.id}:${cue.cue}`):other.scene>r.scene || other.status==='sceneWait' || other.status==='complete'))this.advance(r);
        continue;
      }
      if(r.status!=='ready')continue;
      if(!cue){
        if(this.selection.timing==='shared' && scene.together){r.status='sceneWait';this.emit();}
        else {r.scene++;r.cue=0;r.status='ready';this.emit();}
        continue;
      }
      this.h.event('program_cue_start',{role:r.id,phone:r.phone,scene:r.scene,cue:r.cue,cueType:cue.type});
      if(['speak','reply','conversation'].includes(cue.type))this.execute(r,cue);
      else if(cue.type==='pause'){r.status='silence';r.deadline=now+cue.seconds*1000;this.emit();}
      else if(cue.type==='wait'){r.status='waiting';this.emit();}
      else if(cue.type==='await'){r.status='dependency';this.emit();}
    }
    const waiting=this.roles.filter(r=>r.status==='sceneWait');
    if(waiting.length && this.roles.every(r=>r.status==='complete' || (r.status==='sceneWait' && r.scene===waiting[0].scene))){for(const r of waiting){r.scene++;r.cue=0;r.status='ready';}this.h.event('program_scene_sync',{scene:waiting[0].scene});this.emit();}
    if(this.roles.length && this.roles.every(r=>r.status==='complete')){this.status='completed';this.h.event('program_complete',{});this.emit();}
  }
}
module.exports={ProgramStore,ProgramRunner,validateProgram};
