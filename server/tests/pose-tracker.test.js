const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('events');
const {PoseTracker}=require('../pose-tracker');
test('server tracking sends pose frames and turns replies into tracks with body points',()=>{
  const sent=[],tracked=[],stopped=[];
  const proc=Object.assign(new EventEmitter(),{stdin:{write:l=>sent.push(JSON.parse(l))},stdout:new EventEmitter(),stderr:new EventEmitter(),kill(){}});
  const cam={id:'cam2',frame:Buffer.from('preview'),frameAt:Date.now()};
  const room={tracking:{owner:'',at:0},track:x=>{tracked.push(x);return {};},stopTracking:t=>stopped.push(t)};
  const full={frame:Buffer.from('full'),at:Date.now()},identity={fullFps:1,fullFrames:()=>full};
  const pt=new PoseTracker({root:'/nowhere',cameras:[cam],room,identity,spawnImpl:()=>proc});
  pt.ready=true;pt.start('cam2');clearInterval(pt.timer);
  assert.equal(identity.fullFps,5,'full-resolution stream speeds up while tracking');
  proc.stdout.emit('data','{"ready":true,"device":"mps"}\n');
  pt.tick();assert.equal(sent.length,1);assert.equal(Buffer.from(sent[0].jpeg,'base64').toString(),'full');assert.equal(sent[0].objects,true);
  pt.tick();assert.equal(sent.length,1,'one frame at a time');
  const kp=Array.from({length:17},()=>[1000,500,0.9]);
  proc.stdout.emit('data',JSON.stringify({id:1,w:2000,h:1000,ms:40,people:[{track:3,conf:0.8,box:[900,200,200,700],kp}],objects:[{cls:'dog',conf:0.7,box:[0,800,200,150]},{cls:'chair',conf:0.5,box:[100,500,200,300]}]})+'\n');
  const t=tracked[0];assert.equal(t.tracker,'server');assert.equal(t.tracks[0].id,'P3');assert.deepEqual(t.tracks[0].box,{x:0.45,y:0.2,w:0.1,h:0.7});
  assert.equal(t.tracks[0].feetVisible,true);assert.deepEqual(t.tracks[0].kp[0],[0.5,0.5,0.9]);
  assert.equal(t.animals[0].cls,'dog');assert.equal(t.objects[0].cls,'chair');
  pt.tick();assert.equal(sent.length,1,'the same frame is not sent twice');
  pt.stop();assert.deepEqual(stopped,['server']);assert.equal(identity.fullFps,1);
});

test('four visible tabletop corners recover rotation while preserving dimensions',()=>{
 const {fitTabletop}=require('../positioning');
 const cam={x:2,y:2,z:2},H=[8,0,-2,0,8,-2,0,0,1];
 const footprint={heightM:1,points:[[1,1],[3,1],[3,2],[1,2]]};
 const c=Math.cos(.4),s=Math.sin(.4);
 const corners=footprint.points.map(([x,y])=>[2.4+c*(x-2)-s*(y-1.5),2.6+s*(x-2)+c*(y-1.5)]);
 const image=corners.map(([x,y])=>[x/4,y/4]);
 const result=fitTabletop({H,camera:cam},footprint,image,{widthM:5,depthM:5});
 assert.ok(result.error<1e-8);
 assert.ok(Math.abs(Math.atan2(result.points[1][1]-result.points[0][1],result.points[1][0]-result.points[0][0])-.4)<1e-8);
 assert.throws(()=>fitTabletop({H,camera:cam},footprint,[[.2,.2],[.2,.2],[.2,.2],[.2,.2]],{widthM:5,depthM:5}),/do not fit/);
});

test('visible tabletop edges can establish rotation when the back corners are hidden',()=>{
 const {fitTabletopEdges}=require('../positioning');
 const camera={x:2,y:2,z:2},H=[8,0,-2,0,8,-2,0,0,1];
 const footprint={heightM:1,points:[[1,1],[3,1],[3,2],[1,2]]}, plan={widthM:4,depthM:4};
 const angle=.2, x=Math.cos(angle), y=Math.sin(angle);
 const image=[[2,1],[2-y,1+x],[2+x,1+y]].map(p=>p.map(v=>v/4));
 const result=fitTabletopEdges({H,camera},footprint,image,plan);
 assert.ok(result.error<1e-8);
 assert.ok(Math.abs(result.points[3][1]-(1+2*y))<1e-8);
 assert.throws(()=>fitTabletopEdges({H,camera},footprint,[...image.slice(0,2),[.5,.3]],plan),/long edge is unclear/);
});

test('automatic tabletop pose uses an adjoining pair of visible edges',()=>{
 const {detectTabletopPose,angleDifference}=require('../positioning');
 const camera={x:2,y:2,z:2},H=[8,0,-2,0,8,-2,0,0,1];
 const footprint={heightM:1,points:[[1,1],[3,1],[3,2],[1,2]]};
 const angle=.2, a=[2,1], b=[2-Math.sin(angle),1+Math.cos(angle)], c=[2+1.5*Math.cos(angle),1+1.5*Math.sin(angle)];
 const image=p=>p.map(v=>v/4);
 const plan={widthM:5,depthM:5};
 const result=detectTabletopPose({H,camera},footprint,[[a,b],[a,c]].map(e=>e.map(image)),plan);
 assert.ok(result);
 assert.ok(angleDifference(result.angle,angle)<1e-8);
 assert.equal(detectTabletopPose({H,camera},footprint,[[a,b].map(image)],plan),null);
});
