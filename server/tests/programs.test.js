const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ProgramStore,ProgramRunner,validateProgram}=require('../programs');
const passage=(id,type='speak',extra={})=>({id,type,text:type==='speak'?'Go to the wall.':'',seconds:0,turns:2,...extra});
function score(tracks={a:[passage('a1')],b:[passage('b1')]}){return {title:'Two roles',roles:[{id:'a',name:'A'},{id:'b',name:'B'}],scenes:[{id:'one',name:'One',together:true,tracks},{id:'two',name:'Two',together:true,tracks:{a:[],b:[]}}]};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function rig(program=score(),timing='shared'){
 const pending=[],cancelled=[],events=[],visits={1:'v1',2:'v2'},ready={1:true,2:true};
 const runner=new ProgramRunner({ready:id=>ready[id],visit:id=>visits[id],perform:(id,cue)=>new Promise((resolve,reject)=>pending.push({id,cue,resolve,reject})),cancel:id=>cancelled.push(id),event:(...v)=>events.push(v),change(){},decide:async()=>({action:'resume',reason:'Back to score'}),converse:async()=> 'Thank you. Look again.'});
 runner.configure({snapshot:validateProgram(program),assignments:{a:1,b:2},timing});
 return{runner,pending,visits,ready,cancelled,events};
}
test('program revisions reject stale saves and snapshots remain unchanged',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mother-programs-'));
 try{const store=new ProgramStore(dir),first=store.save(score());const snapshot=structuredClone(first);const second=store.save({...first,title:'Updated'});assert.equal(second.revision,2);assert.equal(snapshot.title,'Two roles');assert.throws(()=>store.save(first),/edited elsewhere/);assert.equal(store.get('../../private'),null);assert.equal(store.list().length,1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('invalid and cyclic cross-role dependencies are rejected',()=>{
 const p=score({a:[passage('a1','await',{role:'b',cue:'b1'})],b:[passage('b1','await',{role:'a',cue:'a1'})]});
 assert.throws(()=>validateProgram(p),/loop/);p.scenes[0].tracks.b=[];assert.throws(()=>validateProgram(p),/does not exist/);
});
test('roles speak independently and shared scenes advance only after actual playback',async()=>{
 const {runner:r,pending}=rig();r.start();assert.equal(pending.length,2);assert.equal(r.roles[0].cue,0);
 pending[0].resolve();await settle();r.tick();assert.equal(r.roles[0].status,'sceneWait');assert.equal(r.roles[0].scene,0);
 pending[1].resolve();await settle();r.tick();assert.equal(r.roles[0].scene,1);assert.equal(r.roles[1].scene,1);
});
test('independent timing lets one role enter the next scene alone',async()=>{
 const {runner:r,pending}=rig(score(),'independent');r.start();pending[0].resolve();await settle();r.tick();assert.equal(r.roles[0].scene,1);assert.equal(r.roles[1].scene,0);
});
test('a pause or role override invalidates delayed generation and repeats from the cue boundary',async()=>{
 const {runner:r,pending}=rig();r.start();r.pause();pending[0].resolve();await settle();assert.equal(r.roles[0].cue,0);assert.equal(r.status,'paused');r.resume();assert.equal(pending.length,4);assert.equal(r.roles[0].status,'speaking');r.next(1);pending[2].resolve();await settle();assert.equal(r.roles[0].cue,1);
});
test('participant replacement and hardware loss require an explicit desk recovery',async()=>{
 const {runner:r,pending,visits,ready}=rig();r.start();ready[1]=false;r.tick();assert.equal(r.roles[0].status,'paused');pending[0].resolve();await settle();assert.equal(r.roles[0].cue,0);ready[1]=true;visits[1]='new-visit';r.tick();assert.equal(r.roles[0].status,'attention');assert.throws(()=>r.resume(1),/participant or phone changed/);
});
test('a role dependency waits only for its specified cue',async()=>{
 const {runner:r,pending}=rig(score({a:[passage('a1')],b:[passage('b1','await',{role:'a',cue:'a1'}),passage('b2')]}));r.start();assert.equal(pending.length,1);assert.equal(r.roles[1].status,'dependency');pending[0].resolve();await settle();r.tick();r.tick();assert.equal(pending.length,2);assert.equal(pending[1].id,2);
});
test('reply and bounded conversation cues do not advance before participant replies',async()=>{
 const {runner:r,pending}=rig(score({a:[passage('a1','reply',{text:'What do you see?'})],b:[passage('b1','conversation',{text:'Tell me more.',turns:1})]}));r.start();for(const p of [...pending])p.resolve();await settle();assert.equal(r.roles[0].status,'reply');await r.reply(1,'A painting');assert.equal(r.roles[0].cue,1);const reply=r.reply(2,'A sculpture');await settle();assert.equal(pending.length,3);assert.equal(r.roles[1].cue,0);pending[2].resolve();await reply;assert.equal(r.roles[1].cue,1);
});
test('live interruption can let Mother return while missing transcription leaves a visible hold',async()=>{
 const {runner:r,ready}=rig();r.start();r.hold(1,'human director cut in',true);ready[1]=false;r.tick();assert.equal(r.roles[0].status,'interrupted');ready[1]=true;await r.reply(1,'Stay here a moment',true);assert.equal(r.roles[0].status,'ready');assert.equal(r.roles[0].cue,0);
});
test('reply timeout asks the desk rather than silently skipping',async()=>{
 const {runner:r,pending}=rig(score({a:[passage('a1','reply',{text:'Where are you?'})],b:[]}));r.start();pending[0].resolve();await settle();r.roles[0].deadline=Date.now()-1;r.tick();assert.equal(r.roles[0].status,'attention');assert.equal(r.roles[0].cue,0);
});

test('silence is scheduled only after the preceding passage has finished',async()=>{
 const {runner:r,pending}=rig(score({a:[passage('a1'),passage('a2','pause',{seconds:8})],b:[]}));r.start();r.tick();assert.equal(r.roles[0].deadline,undefined);pending[0].resolve();await settle();r.tick();assert.equal(r.roles[0].status,'silence');assert.ok(r.roles[0].deadline>Date.now()+7000);r.roles[0].deadline=Date.now()-1;r.tick();assert.equal(r.roles[0].completed.has('one:a2'),true);assert.equal(r.roles[0].scene,1);
});
test('reserved object keys cannot be used as score identifiers',()=>{
 const p=score();p.roles[0].id='__proto__';assert.throws(()=>validateProgram(p),/identifiers/);
});
