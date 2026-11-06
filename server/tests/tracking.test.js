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
 const c=calibrate({points:noisy},plan);assert.equal(c.checked,true);assert.ok(c.rmsM>0.02&&c.maxErrorM<0.25);
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
 send([{id:'T1',box:boxAt([3.9,4.3]),feetVisible:true}]);
 assert.deepEqual(events.at(-1),['room_track',{track:'T1',phone:1,role:'A',from:'beside the Work bench',to:'at the Double door'}]);
 send([]);v=send([],1600);const t1=v.tracks.find(x=>x.id==='T1');assert.equal(t1.visible,false);assert.deepEqual(t1.floor,[3.9,4.3]);assert.equal(v.movement.at(-1).to,'out of sight');
 // A new track near the last-seen spot is suggested, never assumed.
 v=send([{id:'T2',box:boxAt([3.6,4.1]),feetVisible:true}]);
 assert.equal(v.suggestions[0].trackId,'T2');assert.equal(v.suggestions[0].role,'A');assert.equal(v.tracks.find(x=>x.id==='T2').binding,null);
 tr.bind({trackId:'T2',phone:1,role:'A'});v=tr.view(now);assert.equal(v.tracks.find(x=>x.id==='T1').binding,null);assert.equal(v.tracks.find(x=>x.id==='T2').binding.role,'A');
});
test('hidden feet keep the last floor position and are marked uncertain; uncalibrated cameras give none',()=>{
 const tr=new Tracking();let now=1e6;
 tr.update({tracker:'d',cameraId:'cam1',tracks:[{id:'T1',box:boxAt([1,3.5]),feetVisible:true}]},{calibration:cal,plan,now});
 const v=tr.update({tracker:'d',cameraId:'cam1',tracks:[{id:'T1',box:{x:.4,y:.5,w:.2,h:.6},feetVisible:false}]},{calibration:cal,plan,now:now+400});
 const t1=v.tracks[0];assert.equal(t1.certainty,'uncertain');
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
