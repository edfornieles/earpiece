const {test}=require('node:test'),assert=require('node:assert/strict');
const {calibrate,apply}=require('../tracking');
const {place,Smoother,confidence,coverage,looksSeated,KP}=require('../positioning');
const plan={widthM:4.77,depthM:4.5,heightM:3,doors:[],footprints:[{name:'Work bench',heightM:1.05,points:[[1.5,1.3],[3.7,1.3],[3.7,2.4],[1.5,2.4]]}]};
// The Tapo as measured: jars wall, 2.2 m from the door wall, 2.1 m up, looking across and down.
const C={x:0.1,y:2.3,z:2.1},p=30*Math.PI/180,f=0.7,fwd=[Math.cos(p),0,-Math.sin(p)],right=[0,1,0],up=[Math.sin(p),0,Math.cos(p)];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const see=([x,y,z=0])=>{const d=[x-C.x,y-C.y,z-C.z],k=dot(d,fwd);return [0.5+f*dot(d,right)/k,0.5-f*dot(d,up)/k];};
const H=calibrate({points:[[2,1],[4,1],[4,4],[2,4],[3,2.5]].map(fl=>({image:see(fl),floor:fl}))},plan).H;
// A standing person at (x,y): keypoints at body heights.
function body(x,y,{feet=true,seated=false}={}){
  const kp=Array.from({length:17},()=>[0,0,0]),at=(z)=>[...see([x,y,z]),0.9];
  kp[KP.nose]=at(seated?1.25:1.62);kp[KP.lsho]=kp[KP.rsho]=at(seated?1.05:1.4);
  kp[KP.lhip]=kp[KP.rhip]=at(seated?0.62:0.93);kp[KP.lknee]=kp[KP.rknee]=at(seated?0.6:0.5);
  if(feet)kp[KP.lank]=kp[KP.rank]=at(0.05);
  return kp;
}
test('visible feet give a tight position; hidden feet fall back to hips, then head, each with an honest radius',()=>{
 const a=place({H,cam:C,plan,kp:body(3.2,3.0)});
 assert.equal(a.how,'feet');assert.ok(Math.hypot(a.floor[0]-3.2,a.floor[1]-3.0)<0.08);assert.ok(a.radius<0.2,String(a.radius));
 const b=place({H,cam:C,plan,kp:body(3.2,3.0,{feet:false})});
 assert.equal(b.how,'hips');assert.ok(Math.hypot(b.floor[0]-3.2,b.floor[1]-3.0)<0.08);assert.ok(b.radius>a.radius&&b.radius<0.7,String(b.radius));
 assert.equal(confidence(a.radius,a.how),'sure');
});
test('"feet" that land on a workbench are rejected as hidden legs',()=>{
 const kp=body(2.6,1.8,{feet:false});kp[KP.lank]=kp[KP.rank]=[...see([2.6,1.8,0]),0.9];   // the detector guesses ankles on the bench top
 assert.notEqual(place({H,cam:C,plan,kp}).how,'feet');
});
test('a seated person is recognised and placed from hips at seat height',()=>{
 const kp=body(2.1,3.3,{feet:false,seated:true});assert.equal(looksSeated(kp),true);
 const s=place({H,cam:C,plan,kp});assert.equal(s.how,'hips (seated)');assert.ok(Math.hypot(s.floor[0]-2.1,s.floor[1]-3.3)<0.1,JSON.stringify(s.floor));
});
test('the smoother follows walking, ignores a wild reading, and holds briefly through a gap',()=>{
 const sm=new Smoother();let t=0,out;
 for(let i=0;i<20;i++){t+=200;out=sm.step({floor:[1+i*0.05,2],radius:0.15,how:'feet'},t);}
 assert.ok(Math.abs(out.floor[0]-1.95)<0.12,String(out.floor[0]));
 out=sm.step({floor:[4.5,0.2],radius:0.15,how:'feet'},t+=200);assert.ok(out.floor[0]<2.3,'a jump across the room is ignored');
 out=sm.step(null,t+=1000);assert.equal(out.how,'held');assert.ok(out.radius>0.15);
 assert.equal(sm.step(null,t+=3000),null,'dropped after the hold time');
});
test('coverage separates where feet are seen, where only bodies are, and blind floor',()=>{
 const cov=coverage({H,cam:C,plan,step:0.25});
 const at=(x,y)=>cov.cells.reduce((b,c)=>Math.hypot(c.x-x,c.y-y)<Math.hypot(b.x-x,b.y-y)?c:b).state;
 assert.equal(at(4.2,3.0),'feet');
 assert.equal(at(4.2,1.85),'body only','just behind the bench, legs are hidden');
 assert.equal(at(2.6,1.8),'furniture');
 assert.ok(cov.summary.feet>20&&cov.summary.feet<100);
});
test('live tracking uses body points: hips when feet are hidden, with radius and confidence for the directors',()=>{
 const {Tracking}=require('../tracking');const tr=new Tracking();let now=1e6,v;
 const cal={H,camera:C};
 const boxOf=kp=>{const xs=kp.filter(q=>q[2]).map(q=>q[0]),ys=kp.filter(q=>q[2]).map(q=>q[1]);return {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};};
 for(let i=0;i<6;i++){const kp=body(3.2,3.0);v=tr.update({tracker:'d',cameraId:'cam2',tracks:[{id:'T1',box:boxOf(kp),feetVisible:true,kp}]},{calibration:cal,plan,now:now+=300});}
 let t=v.tracks[0];assert.equal(t.how,'feet');assert.equal(t.confidence,'sure');assert.ok(Math.hypot(t.floor[0]-3.2,t.floor[1]-3.0)<0.1,String(t.floor));
 const tr2=new Tracking();
 for(let i=0;i<6;i++){const kp=body(3.2,3.0,{feet:false});v=tr2.update({tracker:'d',cameraId:'cam2',tracks:[{id:'T1',box:boxOf(kp),feetVisible:false,kp}]},{calibration:cal,plan,now:now+=300});}
 t=v.tracks[0];assert.equal(t.how,'hips');assert.ok(t.radiusM>0.1&&t.radiusM<0.7,String(t.radiusM));assert.ok(Math.hypot(t.floor[0]-3.2,t.floor[1]-3.0)<0.15,String(t.floor));
});
