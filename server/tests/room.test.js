const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {RoomObserver,analyseFrame,box}=require('../room');
const region={x:.1,y:.2,w:.3,h:.4};
const observation=()=>({summary:'A studio with a chair.',answer:'A chair is visible.',objects:[{landmarkId:'invented',name:'Chair',description:'Blue chair near the wall',box:region,certainty:'clear'}],people:[{description:'Person in dark clothing',activity:'Standing beside the chair',box:region,certainty:'uncertain'}],changes:[],uncertainties:['The doorway is partly obscured.']});
function setup(t,analyse=async()=>observation()){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mother-room-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cam={id:'cam1',name:'Studio',frame:Buffer.from([255,216,255,217]),frameAt:Date.now(),status(){return{id:this.id,name:this.name,live:true};}};
 const file=path.join(dir,'.room.json'),hooks={cameras:()=>[cam],maxPhones:()=>4,analyse};return{room:new RoomObserver(file,hooks),cam,file,hooks};
}
test('observation retains capture time and exact frame; unknown landmark IDs stay unconfirmed',async t=>{
 const {room:r,cam}=setup(t);const captured=cam.frameAt,original=Buffer.from(cam.frame);const o=await r.observe('cam1');assert.equal(o.capturedAt,captured);assert.deepEqual(r.frames.get(o.id),original);assert.equal(o.objects[0].landmarkId,'');assert.equal(r.config.landmarks.length,0);assert.equal(r.prompt(),'');
});
test('reviewed inventory survives restart, while observation and continuous uploads do not',async t=>{
 const {room:r,file,hooks}=setup(t);r.save({revision:0,name:'My studio',landmark:{name:'Reading chair',cameraId:'cam1',box:region,rules:'May sit after asking.'}});r.start('cam1',5);const restored=new RoomObserver(file,hooks);assert.equal(restored.config.landmarks[0].name,'Reading chair');assert.equal(restored.enabled,false);assert.equal(restored.latest,null);assert.throws(()=>restored.save({revision:0,name:'Stale edit'}),/edited elsewhere/);
});
test('stopping invalidates a delayed analysis and prevents a result from appearing after cancellation',async t=>{
 let resolve;const {room:r}=setup(t,()=>new Promise(done=>resolve=done));const work=r.observe('cam1');assert.equal(r.busy,true);r.stop();resolve(observation());assert.equal(await work,null);assert.equal(r.latest,null);assert.equal(r.frames.size,0);assert.equal(r.busy,false);
});
test('person-to-phone confirmation is scoped to one fresh observation',async t=>{
 const {room:r,cam}=setup(t);const first=await r.observe('cam1');r.bind({observationId:first.id,personId:'person_1',phone:1,role:'A'});assert.equal(r.bindings.length,1);r.lastAttempt=0;cam.frameAt=Date.now();await r.observe('cam1');assert.equal(r.bindings.length,0);assert.throws(()=>r.bind({observationId:first.id,personId:'person_1',phone:1}),/frame changed/);
});
test('director context is opt-in and excludes stale visual observations',async t=>{
 const {room:r}=setup(t);await r.observe('cam1');r.save({revision:0,shareWithAgents:true,landmark:{name:'Chair',cameraId:'cam1',box:region}});assert.match(r.prompt(),/A studio with a chair/);r.latest.capturedAt=Date.now()-31000;assert.match(r.prompt(),/"observation":null/);assert.match(r.prompt(),/"name":"Chair"/);
});
test('background analysis is serialized and stops on missing fresh frames or service failures',async t=>{
 let calls=0,finish;const {room:r,cam}=setup(t,()=>{calls++;return new Promise(resolve=>finish=resolve);});r.start('cam1',5);const tick=r.tick();await r.tick();assert.equal(calls,1);finish(observation());await tick;assert.equal(r.enabled,true);r.nextAt=0;cam.frameAt=Date.now()-5000;await r.tick();assert.equal(r.enabled,false);assert.match(r.error,/fresh picture/);
});
test('invalid physical-image regions cannot be saved as landmarks',t=>{
 const {room:r}=setup(t);assert.throws(()=>box({...region,w:2}),/within/);assert.throws(()=>r.save({revision:0,landmark:{name:'Door',cameraId:'cam1',box:{x:NaN}}}),/valid region/);assert.equal(r.config.landmarks.length,0);
});
test('vision sends only the provided frame and context, with structured output and cancellation',async()=>{
 let sent;const frame=Buffer.from('sample-jpeg');const result=await analyseFrame({frame,context:{room:'Studio'},question:'Where is the chair?'},{key:'test',fetchImpl:async(url,options)=>{sent={url,...options,body:JSON.parse(options.body)};return{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(observation())}}]})};}});assert.equal(result.objects.length,1);assert.match(sent.body.messages[1].content[1].image_url.url,/data:image\/jpeg;base64,/);assert.equal(sent.body.response_format.json_schema.strict,true);assert.equal(sent.body.messages[1].content[0].text,'Where is the chair?');assert.match(sent.body.messages[0].content,/never recognise faces/i);assert.ok(sent.signal);
});

test('stopping a network request discards its abort instead of publishing an error or stale observation',async t=>{
 const {room:r}=setup(t,({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
 const work=r.observe('cam1');r.stop();assert.equal(await work,null);assert.equal(r.latest,null);assert.equal(r.error,'');assert.equal(r.busy,false);
});
