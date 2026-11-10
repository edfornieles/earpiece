const {test}=require('node:test'),assert=require('node:assert/strict');
const {ObjectFinder}=require('../objects-finder');
const {Tracking}=require('../tracking');
// A camera looking straight down: image (u,v) in 0..1 maps to floor (4.77u, 4.5v).
const H=[4.77,0,0,0,4.5,0,0,0,1];
function setup(){
 const footprints=[{name:'Armchair',points:[[1,3.6],[1.8,3.6],[1.8,4.4],[1,4.4]]}];
 const room={config:{calibrations:{cam2:{H}},floorPlan:{widthM:4.77,depthM:4.5,heightM:3,doors:[],footprints}},
  moveFootprint(name,d){const f=this.config.floorPlan.footprints.find(x=>x.name===name);f.points=f.points.map(p=>[p[0]+d[0],p[1]+d[1]]);return this.config.floorPlan;},
  addFootprint({name,centre,size}){this.config.floorPlan.footprints.push({name,points:[[centre[0]-size[0]/2,centre[1]-size[1]/2],[centre[0]+size[0]/2,centre[1]+size[1]/2],[centre[0]-size[0]/2,centre[1]+size[1]/2]]});return this.config.floorPlan;}};
 const tracking=new Tracking();tracking.cameraId='cam2';
 const f=new ObjectFinder({root:'/nonexistent',cameras:[],tracking,room});
 f.cat=[{name:'Armchair',query:'a brown leather armchair',footprintM:[0.8,0.8],followOnPlan:true},{name:'Tall stool',query:'a tall white stool',footprintM:[0.35,0.35],followOnPlan:true},{name:'Work bench',query:'a workbench',footprintM:[2.2,1.1],followOnPlan:false}];
 return {f,room,tracking};
}
// A detection whose bottom-centre sits on floor point (x,y).
const at=(q,x,y,w=0.1,h=0.1)=>({query:q,score:0.4,box:[(x/4.77-w/2)*960,(y/4.5-h)*540,w*960,h*540]});
test('a known object without an outline gets one once its position is steady',()=>{
 const {f,room}=setup();let now=1e6;
 for(let i=0;i<3;i++)f.place([at(1,3.5,2.0)],960,540,[],now+=2500);
 assert.equal(room.config.floorPlan.footprints.length,1);
 f.accept('Tall stool',f.status(now).objects[0].proposal.at,now);
 const s=room.config.floorPlan.footprints.find(x=>x.name==='Tall stool');assert.ok(s,'stool outline added');
 assert.ok(Math.abs(s.points[0][1]-1.65)<0.02,'centre is half a depth beyond the front edge, away from the camera');
});
test('an object with an outline moves it only after settling well away, never while a person blocks it',()=>{
 const {f,room,tracking}=setup();let now=1e6;
 const person={x:2.5/4.77-0.1,y:(3.0/4.5)-0.5,w:0.2,h:0.55};
 for(let i=0;i<5;i++)f.place([at(0,2.9,3.0)],960,540,[person],now+=2500);
 assert.equal(room.config.floorPlan.footprints[0].points[0][0],1,'blocked: not moved');
 f.place([at(0,2.9,3.0)],960,540,[],now+=2500);f.place([at(0,2.95,3.0)],960,540,[],now+=2500);
 assert.equal(room.config.floorPlan.footprints[0].points[0][0],1,'two clean sightings are not enough');
 f.place([at(0,2.9,3.02)],960,540,[],now+=2500);
 assert.equal(room.config.floorPlan.footprints[0].points[0][0],1,'awaits review');
 f.accept('Armchair',f.status(now).objects[0].proposal.at,now);
 assert.ok(room.config.floorPlan.footprints[0].points[0][0]>2,'moved after three steady sightings');
 assert.equal(tracking.movement.at(-1).who,'Armchair');assert.equal(tracking.movement.at(-1).object,true);
});
test('large furniture is named but never moved by its (often hidden) base',()=>{
 const {f,room}=setup();let now=1e6;
 for(let i=0;i<4;i++)f.place([at(2,2.0,1.0,0.4,0.1)],960,540,[],now+=2500);
 assert.ok(!room.config.floorPlan.footprints.some(x=>x.name==='Work bench'));
 assert.equal(f.status(now).objects.find(o=>o.name==='Work bench').follows,false);
});

test('a furniture observation from an old camera calibration cannot change the plan',()=>{
 const {f,room}=setup();let now=1e6;
 for(let i=0;i<3;i++)f.place([at(0,2.9,3.0)],960,540,[],now+=2500);
 const proposed=f.status(now).objects[0].proposal;
 room.cals=()=>({cam2:{H:[...H.slice(0,2),.2,...H.slice(3)]}});
 assert.throws(()=>f.accept('Armchair',proposed.at,now),/no longer current/);
 f.place([at(0,2.9,3.0)],960,540,[],now+=2500);
 assert.equal(f.status(now).objects[0].proposal,null);
});

test('an opted-in object updates the plan after three clear, stable sightings',()=>{
 const {f,room}=setup();let now=1e6;
 f.cat[0].autoMove=true;
 const old=room.config.floorPlan.footprints[0].points[0][0];
 for(let i=0;i<2;i++)f.place([at(0,2.9,3)],960,540,[],now+=2500);
 assert.equal(room.config.floorPlan.footprints[0].points[0][0],old);
 f.place([at(0,2.9,3)],960,540,[],now+=2500);
 assert.ok(room.config.floorPlan.footprints[0].points[0][0]>2);
});

test('a tabletop at a known height can move the plan without seeing its feet',()=>{
 const {f,room}=setup();let now=1e6;
 room.config.calibrations.cam2.camera={x:2.4,y:2.25,z:2};
 const bench={name:'Work bench',heightM:1,points:[[1.2,1.8],[2,1.8],[2,2.4],[1.2,2.4]]};
 room.config.floorPlan.footprints.push(bench);
 Object.assign(f.cat[2],{locateBy:'tabletop',autoMove:true,followOnPlan:true});
 const hit={query:2,score:.6,box:[(1.6/4.77)*960,(1.35/4.5)*540,(1.6/4.77)*960,(1.2/4.5)*540]};
 for(let i=0;i<3;i++)f.place([hit],960,540,[],now+=2500);
 assert.ok(Math.abs(bench.points[0][0]-2)<.06);
});
// ---- room checks: short, and never beside the voice ----
function checks(gate){
 const s=setup(),log=[];let hold=null;
 const f=new ObjectFinder({root:'/nonexistent',cameras:[],tracking:s.tracking,room:s.room,hooks:{gate:(o)=>gate?gate(o):hold,checked:(now)=>log.push(now)}});
 f.catalogue=()=>[];
 return {f,log,view:{running:true,tracks:[]},hold:(v)=>{hold=v;}};
}
test('a room check waits for a quiet moment, looks a few times, then gives the memory back',()=>{
 const {f,log,view}=checks();let now=1e6;
 f.wanted={at:now,reason:'test'};
 assert.equal(f.checking(view,now),false);assert.equal(f.status(now).check.waiting,'waiting for a quiet moment');
 assert.equal(f.checking(view,now+=16000),true,'quiet for long enough: look');
 f.check.passes=4;
 assert.equal(f.checking(view,now+=1000),false);assert.equal(f.check,null);
 assert.deepEqual(log,[now]);assert.equal(f.status(now).lastCheckAt,now);
 assert.equal(f.checking(view,now+=60000),false,'the next check is minutes away');
 assert.ok(f.nextCheckAt()>now);
});
test('the voice holds a check, and the desk button skips the wait but never the voice',()=>{
 const {f,view,hold}=checks();let now=1e6,killed=0;
 f.request('asked from the desk',{force:true,now});
 hold({why:'waiting for the voice to finish',urgent:true});
 f.proc={kill(){killed++;}};
 assert.equal(f.checking(view,now),false);assert.equal(killed,1,'the worker is unloaded at once');
 assert.equal(f.status(now).check.waiting,'waiting for the voice to finish');
 hold(null);
 assert.equal(f.checking(view,now+=1000),true,'forced: no quiet wait once the voice is done');
 hold({why:'waiting for the voice to finish',urgent:true});
 assert.equal(f.checking(view,now+=200000),false);assert.equal(f.checking(view,now+=200000),false);
 assert.equal(f.check,null,'held too long: give up');assert.ok(f.wanted.at>now,'and try again shortly');
});
test('someone stepping away from a movable piece asks for a check',()=>{
 const {f,view}=checks();let now=1e6;
 f.catalogue=()=>[{name:'Armchair',query:'x'}];f.lastCheckAt=now-120000;f.wanted=null;
 f.watchLeaving({running:true,tracks:[{visible:true,floor:[1.4,3.3]}]},now);
 f.watchLeaving(view,now+=5000);
 assert.match(f.wanted.reason,/Armchair/);
});
