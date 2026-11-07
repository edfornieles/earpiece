const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fitHomography,apply,invert,calibrate,areaFor,Tracking}=require('../tracking');
const {RoomObserver}=require('../room');
const plan={widthM:4.77,depthM:4.5,heightM:3,doors:[{name:'Double door',widthM:1.67,wall:'bottom',offsetM:3.06}],footprints:[{name:'Work bench',points:[[1.51,1.28],[3.71,1.28],[3.71,2.38],[1.51,2.38]]}]};
// A made-up camera: floor (x,y) -> image via a known perspective map, used to build exact pairs.
const truth=[0.12,0.05,0.1,-0.02,0.08,0.4,0.01,0.09,1];
const toImage=f=>apply(truth,f);
const pairsFor=floors=>floors.map(f=>({image:toImage(f),floor:f}));
test('a homography fitted to four exact pairs recovers floor positions and inverts',()=>{
 const H=fitHomography(pairsFor([[0.5,0.5],[4,0.6],[4.2,4],[0.6,4.2]]).map(p=>({image:p.image,floor:p.floor})));
 const q=apply(H,toImage([2.4,3.1]));assert.ok(Math.hypot(q[0]-2.4,q[1]-3.1)<1e-6);
 const back=apply(invert(H),[2.4,3.1]),img=toImage([2.4,3.1]);assert.ok(Math.hypot(back[0]-img[0],back[1]-img[1])<1e-6);
});
test('calibration validates points and reports the error of extra points',()=>{
 assert.throws(()=>calibrate({points:pairsFor([[1,1],[2,2],[3,3]])},plan),/at least four/);
 assert.throws(()=>calibrate({points:pairsFor([[1,1],[2,1],[3,1],[4,1]])},plan),/Spread the points/);
 assert.throws(()=>calibrate({points:[...pairsFor([[1,1],[4,1],[4,4]]),{image:[0.5,0.5],floor:[9,9]}]},plan),/inside the room/);
 assert.throws(()=>calibrate({points:pairsFor([[1,1],[4,1],[4,4],[1,4]])},null),/floor plan/);
 const exact=calibrate({points:pairsFor([[0.5,0.5],[4,0.6],[4.2,4],[0.6,4.2]])},plan);assert.equal(exact.checked,false);assert.ok(exact.rmsM<0.001);
 const noisy=pairsFor([[0.5,0.5],[4,0.6],[4.2,4],[0.6,4.2],[2.4,3.1]]);noisy[4].floor=[2.6,3.1];
 const c=calibrate({points:noisy},plan);assert.equal(c.checked,true);assert.equal(c.validation,'holdout');assert.equal(c.maxErrorM,0.2);
});
test('areas come from doors, furniture and walls',()=>{
 assert.equal(areaFor(plan,[2.5,1.8]),'at the Work bench');
 assert.equal(areaFor(plan,[2.5,2.8]),'beside the Work bench');
 assert.equal(areaFor(plan,[3.9,4.3]),'at the Double door');
 assert.equal(areaFor(plan,[0.2,3.6]),'by the left wall');
 assert.equal(areaFor(plan,[1,3.5]),'open floor');
 assert.equal(areaFor(plan,null),'unknown');
});
const cal=calibrate({points:pairsFor([[0.5,0.5],[4,0.6],[4.2,4],[0.6,4.2]])},plan);
// A box whose feet land on a chosen floor point.
const boxAt=f=>{const [u,v]=toImage(f);return {x:u-0.05,y:v-0.3,w:0.1,h:0.3};};
test('tracks get floor positions, areas and movement; lost people stay last-seen',()=>{
 const events=[],tr=new Tracking({event:(t,d)=>events.push([t,d]),maxPhones:()=>4});let now=1e6;
 const send=(tracks,dt=400)=>{now+=dt;return tr.update({tracker:'desk',cameraId:'cam1',tracks},{calibration:cal,plan,now});};
 let v=send([{id:'T1',box:boxAt([2.5,2.8]),feetVisible:true,score:.9}]);
 assert.deepEqual(v.tracks[0].floor,[2.5,2.8]);assert.equal(v.tracks[0].area,'beside the Work bench');assert.equal(v.tracks[0].certainty,'estimate');
 tr.bind({trackId:'T1',phone:1,role:'A'});
 // Walk there at a natural pace; the smoothed position follows and settles.
 for(let k=1;k<=8;k++)send([{id:'T1',box:boxAt([2.5+1.4*k/8,2.8+1.5*k/8]),feetVisible:true}]);
 for(let k=0;k<10;k++)send([{id:'T1',box:boxAt([3.9,4.3]),feetVisible:true}]);
 const moves=events.filter(e=>e[0]==='room_track').map(e=>e[1]);assert.equal(moves[0].from,'beside the Work bench');assert.deepEqual(moves.at(-1),{track:'T1',phone:1,role:'A',from:moves.at(-1).from,to:'at the Double door'});
 send([]);v=send([],1600);const t1=v.tracks.find(x=>x.id==='T1');assert.equal(t1.visible,false);assert.ok(Math.hypot(t1.floor[0]-3.9,t1.floor[1]-4.3)<0.1,String(t1.floor));assert.equal(v.movement.at(-1).to,'out of sight');
 // A new track near the last-seen spot is suggested, never assumed.
 v=send([{id:'T2',box:boxAt([3.6,4.1]),feetVisible:true}]);
 assert.equal(v.suggestions[0].trackId,'T2');assert.equal(v.suggestions[0].role,'A');assert.equal(v.tracks.find(x=>x.id==='T2').binding,null);
 tr.bind({trackId:'T2',phone:1,role:'A'});v=tr.view(now);assert.equal(v.tracks.find(x=>x.id==='T1').binding,null);assert.equal(v.tracks.find(x=>x.id==='T2').binding.role,'A');
});
test('hidden feet keep the last floor position and are marked uncertain; uncalibrated cameras give none',()=>{
 const tr=new Tracking();let now=1e6;
 tr.update({tracker:'d',cameraId:'cam1',tracks:[{id:'T1',box:boxAt([1,3.5]),feetVisible:true}]},{calibration:cal,plan,now});
 const v=tr.update({tracker:'d',cameraId:'cam1',tracks:[{id:'T1',box:{x:.4,y:.5,w:.2,h:.6},feetVisible:false}]},{calibration:cal,plan,now:now+400});
 const t1=v.tracks[0];assert.equal(t1.certainty,'last seen');
 const none=new Tracking().update({tracker:'d',cameraId:'cam1',tracks:[{id:'T1',box:boxAt([1,3.5]),feetVisible:true}]},{calibration:null,plan,now});
 assert.equal(none.tracks[0].floor,null);assert.equal(none.tracks[0].area,'unknown');
});
test('only one screen tracks at a time, and the director context is fresh, bound and opt-in',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mother-track-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cam={id:'cam1',name:'Studio',frame:null,frameAt:0,status(){return{id:'cam1',name:'Studio',live:true};}};
 const r=new RoomObserver(path.join(dir,'.room.json'),{cameras:()=>[cam],maxPhones:()=>4});
 r.save({revision:0,floorPlan:plan});r.save({revision:1,calibration:{cameraId:'cam1',points:pairsFor([[0.5,0.5],[4,0.6],[4.2,4],[0.6,4.2]])}});
 assert.equal(new RoomObserver(path.join(dir,'.room.json'),{cameras:()=>[cam]}).config.calibrations.cam1.points.length,4);
 r.track({tracker:'one',cameraId:'cam1',tracks:[{id:'T1',box:boxAt([2.5,2.8]),feetVisible:true}]});
 assert.throws(()=>r.track({tracker:'two',cameraId:'cam1',tracks:[]}),/another screen/);
 assert.equal(r.prompt(),'');
 r.save({revision:2,shareWithAgents:true});
 assert.match(r.prompt(),/"tracking":\{"people":\[\],"unassignedPeopleVisible":1/);
 r.bindTrack({trackId:'T1',phone:2,role:'B'});
 assert.match(r.prompt(),/"who":"B \(phone 2\)".*"area":"beside the Work bench"/);
 r.tracking.at=Date.now()-6000;assert.match(r.prompt(),/"tracking":null/);
 r.stopTracking('one');assert.doesNotThrow(()=>r.track({tracker:'two',cameraId:'cam1',tracks:[]}));
 r.save({revision:3,removeCalibration:'cam1'});assert.deepEqual(r.config.calibrations,{});
});

test('a camera whose picture includes the horizon calibrates, and points above it have no floor position',()=>{
 // Pinhole camera 1.6 m up near the door wall, facing up the plan and tilted 25 degrees down.
 const C=[2.4,5.2,1.6],p=25*Math.PI/180,f=0.8,fwd=[0,-Math.cos(p),-Math.sin(p)],up=[0,-Math.sin(p),Math.cos(p)];
 const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
 const see=([x,y])=>{const d=[x-C[0],y-C[1],-C[2]],z=dot(d,fwd);return [0.5+f*d[0]/z,0.5-f*dot(d,up)/z];};
 const floors=[[1.6,1.5],[3.4,1.6],[3.0,3.6],[1.8,3.5],[2.6,2.4]];
 const pts=floors.map(fl=>({image:see(fl),floor:fl}));
 assert.ok(pts.every(q=>q.image.every(v=>v>=0&&v<=1)),JSON.stringify(pts));
 const c=calibrate({points:pts},plan);assert.ok(c.rmsM<0.001);
 const q=apply(c.H,see([2.1,2.9]));assert.ok(Math.hypot(q[0]-2.1,q[1]-2.9)<1e-6);
 assert.equal(apply(c.H,[0.5,0.02]),null,'the top of the picture is wall, not floor');
});

test('wall names and floor-level items read naturally',()=>{
 const named={...plan,wallNames:{left:'jars wall',right:'grid wall',top:'shelf wall',bottom:'door wall'},footprints:[...plan.footprints,{name:'Rug',heightM:0.01,points:[[0.5,3],[1.4,3],[1.4,4],[0.5,4]]}]};
 assert.equal(areaFor(named,[0.2,1.0]),'by the jars wall');
 assert.equal(areaFor(named,[4.6,1.0]),'by the grid wall');
 assert.equal(areaFor(named,[1.0,3.5]),'on the Rug');
 assert.equal(areaFor(plan,[0.2,3.6]),'by the left wall');
});
test('furniture keeps its identity, is suggested for its plan item, and only moves the plan once settled and unblocked',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mother-furn-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cam={id:'cam1',name:'Studio',frame:null,frameAt:0,status(){return{id:'cam1',name:'Studio',live:true};}};
 const events=[],r=new RoomObserver(path.join(dir,'.room.json'),{cameras:()=>[cam],maxPhones:()=>4,event:(t,d)=>events.push([t,d])});
 const chair={name:'Armchair',heightM:0.85,points:[[2.0,3.6],[2.8,3.6],[2.8,4.4],[2.0,4.4]]};
 r.save({revision:0,floorPlan:{...plan,footprints:[...plan.footprints,chair]}});
 r.save({revision:1,calibration:{cameraId:'cam1',points:pairsFor([[0.5,0.5],[4,0.6],[4.2,4],[0.6,4.2]])}});
 // An object box whose base sits on a floor point.
 const objAt=(f,w=0.08)=>{const [u,v]=toImage(f);return {cls:'couch',score:0.3,box:{x:u-w/2,y:v-0.1,w,h:0.1}};};
 const send=(objects,people=[])=>r.track({tracker:'desk',cameraId:'cam1',tracks:people,objects});
 for(let i=0;i<4;i++)send([objAt([2.4,3.6])]);
 assert.equal(r.tracking.view().objects.length,0,'not shown until seen steadily');
 send([objAt([2.42,3.61])]);
 let v=r.tracking.view();assert.equal(v.objects.length,1);const id=v.objects[0].id;
 assert.deepEqual(v.objectSuggestions[0],{objectId:id,cls:'couch',footprint:'Armchair',distanceM:0});
 r.bindObject({objectId:id,footprint:'Armchair'});
 // Moved 1.2 m along the wall. Not applied until it has settled for a few seconds.
 const realNow=Date.now;let clock=realNow();Date.now=()=>clock;t.after(()=>{Date.now=realNow;});
 const step=(f,people=[])=>{clock+=700;send([objAt(f)],people);};
 // The detector calls it a chair now and then: still the same armchair.
 send([{...objAt([2.42,3.6]),cls:'chair'}]);assert.equal(r.tracking.view().objects.length,1);
 // Carried 1.2 m along the wall with a person in front of it: followed, but the plan does not move while blocked.
 const blocker=f=>{const b=objAt(f).box;return {id:'T1',box:{x:b.x-0.02,y:b.y-0.3,w:b.w+0.04,h:0.4},feetVisible:true};};
 for(const x of [2.2,2.0,1.8,1.6,1.4,1.2,1.2,1.2,1.2,1.2,1.2,1.2])step([x,3.6],[blocker([x,3.6])]);
 assert.equal(r.config.floorPlan.footprints.find(f=>f.name==='Armchair').points[0][0],2.0);
 assert.equal(r.tracking.view().objects.length,1,'still one armchair, not a new object');
 // The person steps away; once it has settled for a few seconds the outline follows.
 step([1.2,3.6]);assert.equal(r.config.floorPlan.footprints.find(f=>f.name==='Armchair').points[0][0],2.0,'not on the first clean sighting');
 for(let i=0;i<8;i++)step([1.2,3.6]);
 assert.equal(r.config.floorPlan.footprints.find(f=>f.name==='Armchair').points[0][0],2.0);
 const proposal=r.tracking.view().objects[0].proposal;
 assert.ok(proposal);
 r.acceptObjectMove({objectId:id,at:proposal.at});
 const moved=r.config.floorPlan.footprints.find(f=>f.name==='Armchair');
 assert.ok(Math.abs(moved.points[0][0]-0.8)<0.15,JSON.stringify(moved.points));assert.equal(moved.estimated,true);assert.match(moved.notes,/Moved by the camera/);
 assert.equal(events.find(e=>e[0]==='room_object_moved')[1].footprint,'Armchair');
 const m=r.tracking.view().movement.at(-1);assert.equal(m.object,true);assert.equal(m.who,'Armchair');
 assert.equal(new RoomObserver(path.join(dir,'.room.json'),{cameras:()=>[cam]}).config.floorPlan.footprints.find(f=>f.name==='Armchair').points[0][0],moved.points[0][0]);
 r.save({revision:r.config.revision,shareWithAgents:true});
 assert.match(r.prompt(),/"furnitureMoves":\[\{"item":"Armchair"/);
 // Moved while out of view: a chair turning up elsewhere is the missing armchair, not a stranger.
 clock+=4000;send([]);for(let i=0;i<8;i++)step([3.5,4.0]);
 assert.equal(r.tracking.view().objects.length,1);
 r.acceptObjectMove({objectId:id,at:r.tracking.view().objects[0].proposal.at});
 assert.ok(Math.abs(r.config.floorPlan.footprints.find(f=>f.name==='Armchair').points[0][0]-3.1)<0.15);
});

test('Yuri the dog is followed by name, logged by area, never matched to a phone, and shared with directors',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mother-dog-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cam={id:'cam1',name:'Studio',frame:null,frameAt:0,status(){return{id:'cam1',name:'Studio',live:true};}};
 const r=new RoomObserver(path.join(dir,'.room.json'),{cameras:()=>[cam],maxPhones:()=>4});
 r.save({revision:0,floorPlan:{...plan,footprints:[...plan.footprints,{name:'Rug',heightM:0.01,points:[[0.3,2.8],[1.5,2.8],[1.5,4.0],[0.3,4.0]]}]}});
 r.save({revision:1,calibration:{cameraId:'cam1',points:pairsFor([[0.5,0.5],[4,0.6],[4.2,4],[0.6,4.2]])}});
 assert.throws(()=>r.save({revision:2,animals:[{kind:'horse',name:'Ed'}]}),/dog or cat/);
 r.save({revision:2,animals:[{kind:'dog',name:'Yuri'}]});
 const dogAt=(f,score=0.8)=>{const [u,v]=toImage(f);return {cls:'dog',score,box:{x:u-0.03,y:v-0.05,w:0.06,h:0.05}};};
 const realNow=Date.now;let clock=realNow();Date.now=()=>clock;t.after(()=>{Date.now=realNow;});
 const send=(animals)=>{clock+=500;return r.track({tracker:'desk',cameraId:'cam1',tracks:[],objects:[],animals});};
 let v=send([dogAt([1.0,3.4]),dogAt([3.5,1.0],0.2)]);
 assert.equal(v.animals.length,1);assert.equal(v.animals[0].name,'Yuri');assert.equal(v.animals[0].area,'on the Rug');assert.equal(v.tracks.length,0);
 send([dogAt([0.15,1.5])]);send([dogAt([0.15,1.5])]);
 v=send([]);v=send([]);v=send([]);v=send([]);v=send([]);v=send([]);
 const lines=v.movement.filter(m=>m.animal).map(m=>`${m.who}: ${m.from}→${m.to}`);
 assert.deepEqual(lines,['Yuri: null→on the Rug','Yuri: on the Rug→beside the Rug','Yuri: beside the Rug→by the left wall','Yuri: by the left wall→out of sight']);
 assert.throws(()=>r.bindTrack({trackId:'dog',phone:1}),/no longer tracked/);
 r.save({revision:r.config.revision,shareWithAgents:true});
 assert.match(r.prompt(),/"animals":\[\{"name":"Yuri","kind":"dog","visible":false/);
});

test('with the camera position known, people whose feet are hidden are placed from their head',()=>{
 // Camera on the jars wall, 2.2 m from the door wall, 2.1 m up, looking across the room and tilted down.
 const C=[0.1,2.3,2.1],p=30*Math.PI/180,f=0.7,fwd=[Math.cos(p),0,-Math.sin(p)],right=[0,1,0],up=[Math.sin(p),0,Math.cos(p)];
 const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
 const see=([x,y,z=0])=>{const d=[x-C[0],y-C[1],z-C[2]],k=dot(d,fwd);return [0.5+f*dot(d,right)/k,0.5-f*dot(d,up)/k];};
 const floors=[[2,1],[4,1],[4,4],[2,4],[3,2.5]];
 const cal={...calibrate({points:floors.map(fl=>({image:see(fl),floor:fl}))},plan),camera:{x:C[0],y:C[1],z:C[2]}};
 // A person at (3.2, 3.0), 1.7 m tall; their legs are hidden so the box ends at the bench edge.
 const head=see([3.2,3.0,1.7]),hip=see([3.2,3.0,0.9]);
 const box={x:head[0]-0.03,y:head[1],w:0.06,h:hip[1]-head[1]};
 const tr=new Tracking();
 const v=tr.update({tracker:'d',cameraId:'cam2',tracks:[{id:'T1',box,feetVisible:false}]},{calibration:cal,plan,now:Date.now()});
 assert.ok(Math.hypot(v.tracks[0].floor[0]-3.2,v.tracks[0].floor[1]-3.0)<0.05,JSON.stringify(v.tracks[0].floor));
 assert.equal(v.tracks[0].certainty,'from head');
 // Without the camera position the old behaviour stays: uncertain.
 const v2=new Tracking().update({tracker:'d',cameraId:'cam2',tracks:[{id:'T1',box,feetVisible:false}]},{calibration:{...cal,camera:undefined},plan,now:Date.now()});
 assert.equal(v2.tracks[0].certainty,'uncertain');
});

test('a person whose legs are hidden but who overlaps a seat the finder placed is "seated on" it',()=>{
 const cal=calibrate({points:pairsFor([[0.5,0.5],[4,0.6],[4.2,4],[0.6,4.2]])},plan);
 const tr=new Tracking();
 tr.finderStatus=()=>({objects:[{name:'Tall stool',visible:true,floor:[2.11,3.34],box:{x:0.70,y:0.68,w:0.06,h:0.27}}]});
 const v=tr.update({tracker:'d',cameraId:'cam2',tracks:[{id:'T1',box:{x:0.66,y:0.31,w:0.18,h:0.68},feetVisible:false}]},{calibration:cal,plan,now:Date.now()});
 assert.deepEqual(v.tracks[0].floor,[2.11,3.34]);assert.equal(v.tracks[0].area,'seated on the Tall stool');assert.equal(v.tracks[0].certainty,'seated');
});
