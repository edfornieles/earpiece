const {test}=require('node:test'),assert=require('node:assert/strict');
const os=require('os'),path=require('path'),fs=require('fs');
const {World,briefing,relative,facingOf,mapPng}=require('../world');
const {PNG}=require('pngjs');
const sq=(name,x,y,s=0.6,heightM=0.8)=>({name,heightM,points:[[x,y],[x+s,y],[x+s,y+s],[x,y+s]]});
const plan=()=>({widthM:4.77,depthM:4.5,heightM:3,wallNames:{top:'shelf wall',right:'grid wall',bottom:'door wall',left:'jars wall'},
 doors:[{name:'Double door',wall:'bottom',offsetM:3.06,widthM:1.67}],footprints:[sq('Armchair',0.3,3.5,0.8),sq('Small stool',3.8,0.4,0.4,0.45),sq('Work bench',1.6,0.2,1.2)]});
test('the briefing describes the room in words, without leaving anything out',()=>{
 const text=briefing(plan(),{name:'Studio',camera:{x:0.1,y:2.3,z:2.1}});
 assert.match(text,/4\.8 m wide and 4\.5 m deep/);
 for(const word of ['Armchair','Small stool','Work bench','Double door','shelf wall','grid wall','door wall','jars wall'])assert.ok(text.includes(word),word);
 assert.equal(briefing(null),'');
});
test('what is around a person: distances always, sides only when their facing is known',()=>{
 const me={floor:[2.2,2.5]};
 const plain=relative(plan(),me);
 assert.match(plain,/Work bench/);assert.doesNotMatch(plain,/to their (left|right)|in front of them|behind them/);
 const facingTop=relative(plan(),me,{facing:{dir:[0,-1],how:'body'},others:[{floor:[2.2,3.5],name:'Paula'}]});
 assert.match(facingTop,/Work bench[^;]*in front/);assert.match(facingTop,/Paula[^;]*behind/);
 assert.match(facingTop,/Small stool[^;]*(in front|right)/);
});
test('facing comes from walking when they move, otherwise from the body',()=>{
 const walking=facingOf({floor:[2,2]},null,[{at:0,p:[1,2]},{at:2000,p:[2,2]}]);
 assert.deepEqual(walking,{dir:[1,0],how:'walking'});
 assert.equal(facingOf({floor:[2,2]},null,[{at:0,p:[2,2]},{at:2000,p:[2.1,2]}]),null,'standing still, no body points: unknown');
});
test('the map is a picture of the plan with people on it',()=>{
 const png=PNG.sync.read(mapPng(plan(),[{floor:[2.2,2.5],me:true,facing:[0,-1]},{floor:[1,1],label:'Paula'}]));
 assert.ok(png.width>400&&png.height>400);
 let red=0;for(let i=0;i<png.data.length;i+=4)if(png.data[i]===214&&png.data[i+1]===40&&png.data[i+2]===40)red++;
 assert.ok(red>100,'the participant is drawn in red');
});
test('moves are remembered, described, undone, and survive a restart',async()=>{
 const file=path.join(os.tmpdir(),`room-memory-${process.pid}.json`);try{fs.unlinkSync(file);}catch{}
 const p=plan(),calls=[];
 const room={config:{floorPlan:p},moveFootprint(name,d,by){calls.push([name,d,by]);const f=p.footprints.find(x=>x.name===name);if(!f)return null;f.points=f.points.map(q=>[q[0]+d[0],q[1]+d[1]]);return p;}};
 const w=new World({file,room}),now=1e12;
 assert.match(w.note(now),/not checked|has not/i);
 room.moveFootprint('Small stool',[-2,2.5],'camera');
 const e=w.moved({name:'Small stool',from:[4,0.6],to:[2,3.1],delta:[-2,2.5],by:'camera',now});
 assert.equal(e.distanceM,3.2);assert.ok(e.to&&!e.to.includes('Small stool'),'a place is never named after the object itself');
 w.checked(now);
 assert.match(w.note(now+60000),/Small stool/);
 assert.equal(w.view(now).changes[0].name,'Small stool');
 assert.equal(w.held('Small stool',now),false);
 w.undo(e.id,now);
 assert.deepEqual(calls.at(-1),['Small stool',[2,-2.5],'undo']);
 assert.equal(w.held('Small stool',now+60000),true,'the camera may not move it again straight away');
 assert.doesNotMatch(w.note(now+60000),/Moved recently/);
 assert.throws(()=>w.undo(e.id,now),/no longer/);
 await new Promise(r=>setTimeout(r,700));
 const again=new World({file,room});
 assert.equal(again.view(now).lastCheckAt,now);assert.equal(again.view(now).changes[0].undone,now);
 fs.unlinkSync(file);
});

test('an older furniture move cannot be undone over a newer move',()=>{
 const room={config:{floorPlan:plan()},moveFootprint(){assert.fail('an older move must not change the plan');}};
 const w=new World({file:'/nonexistent/memory.json',room});
 const first=w.moved({name:'Small stool',from:[4,.6],to:[3,1],delta:[-1,.4]});
 w.moved({name:'Small stool',from:[3,1],to:[2,2],delta:[-1,1]});
 assert.throws(()=>w.undo(first.id),/most recent move/);
});

test('undoing a fitted turn puts the whole outline back, angle included', () => {
 const p = plan(), placed = [];
 const room = { config: { floorPlan: p }, moveFootprint() { assert.fail('a turn is undone by its outline, not a shift'); },
   placeFootprint(name, points, by) { placed.push([name, points, by]); return p; } };
 const w = new World({ file: '/nonexistent/memory.json', room }), now = 1e12;
 const before = [[1, 1], [3, 1], [3, 2], [1, 2]];
 const e = w.moved({ name: 'Small stool', from: [2, 1.5], to: [2.1, 1.6], delta: [0.1, 0.1], by: 'camera', before, turnedDeg: 11.6, now });
 assert.equal(e.turnedDeg, 12);
 w.undo(e.id, now);
 assert.deepEqual(placed, [['Small stool', before, 'undo']]);
});

test('a move says which way it went, and old checks read in hours', () => {
  const p = plan(), room = { config: { floorPlan: p } };
  const w = new World({ file: '/nonexistent/memory.json', room }), now = 1e12;
  const e = w.moved({ name: 'Small stool', from: [2, 1.5], to: [2, 1.8], delta: [0, 0.3], now });
  assert.match(e.way, /^towards the /);
  w.confirmed('Work bench', now - 21.6 * 3600000);
  assert.match(w.note(now), /22 h ago/);
  assert.match(w.note(now), new RegExp(`Small stool moved 0.3 m ${e.way}`));
});
