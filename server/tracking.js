// Floor calibration and live person tracks.
// A calibration maps camera-image points (0..1) to floor-plan metres with a homography fitted to
// points the operator matched by hand. It is only valid for points on the floor (z = 0), so a
// person's floor position comes from the bottom of their box (their feet), never their head.
const text=(v,max=200)=>String(v??'').trim().slice(0,max);
const finite=v=>typeof v==='number'&&Number.isFinite(v);

// Solve A x = b by Gaussian elimination with partial pivoting. Returns null when singular.
function solve(A,b){
  const n=b.length,M=A.map((row,i)=>[...row,b[i]]);
  for(let c=0;c<n;c++){
    let p=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[p][c]))p=r;
    if(Math.abs(M[p][c])<1e-10)return null;
    [M[c],M[p]]=[M[p],M[c]];
    for(let r=0;r<n;r++){if(r===c)continue;const f=M[r][c]/M[c][c];for(let k=c;k<=n;k++)M[r][k]-=f*M[c][k];}
  }
  return M.map((row,i)=>row[n]/row[i]);
}
// Least-squares homography H (row-major, h33 = 1) from >= 4 point pairs [{image:[u,v],floor:[x,y]}].
function fitHomography(pairs){
  const A=[],b=[];
  for(const {image:[u,v],floor:[x,y]} of pairs){A.push([u,v,1,0,0,0,-u*x,-v*x]);b.push(x);A.push([0,0,0,u,v,1,-u*y,-v*y]);b.push(y);}
  const AtA=Array.from({length:8},(_,i)=>Array.from({length:8},(_,j)=>A.reduce((s,row)=>s+row[i]*row[j],0)));
  const Atb=Array.from({length:8},(_,i)=>A.reduce((s,row,k)=>s+row[i]*b[k],0));
  const h=solve(AtA,Atb);return h&&[...h,1];
}
function apply(H,[u,v]){
  const w=H[6]*u+H[7]*v+H[8];if(!(w>1e-9))return null;
  const x=(H[0]*u+H[1]*v+H[2])/w,y=(H[3]*u+H[4]*v+H[5])/w;return finite(x)&&finite(y)?[x,y]:null;
}
function invert(H){
  const [a,b,c,d,e,f,g,h,i]=H,A=e*i-f*h,B=-(d*i-f*g),C=d*h-e*g,det=a*A+b*B+c*C;
  if(Math.abs(det)<1e-12)return null;
  return [A,-(b*i-c*h),b*f-c*e,B,a*i-c*g,-(a*f-c*d),C,-(a*h-b*g),a*e-b*d].map(v=>v/det);
}
const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
function calibrate(input,plan){
  if(!plan)throw Error('Save the measured floor plan before calibrating a camera.');
  const points=input?.points;
  if(!Array.isArray(points)||points.length<4||points.length>24)throw Error('Match at least four floor points between the camera picture and the plan.');
  const pairs=points.map(p=>{
    const image=p?.image,floor=p?.floor;
    if(!Array.isArray(image)||image.length!==2||!image.every(finite)||image.some(v=>v<0||v>1))throw Error('Each camera point must be inside the picture.');
    if(!Array.isArray(floor)||floor.length!==2||!floor.every(finite)||floor[0]<0||floor[0]>plan.widthM||floor[1]<0||floor[1]>plan.depthM)throw Error('Each floor point must be inside the room.');
    return {image,floor,label:text(p.label,80)};
  });
  // Reject layouts where three of the first points are almost in a line: the fit would be unstable.
  let spread=0;for(let i=0;i<pairs.length;i++)for(let j=i+1;j<pairs.length;j++)for(let k=j+1;k<pairs.length;k++){spread=Math.max(spread,Math.abs(cross(pairs[i].image,pairs[j].image,pairs[k].image)));}
  let H=fitHomography(pairs);
  if(!H||spread<0.01||!invert(H))throw Error('Spread the points out across the visible floor; they cannot all sit on one line.');
  // H is only defined up to scale. Flip its sign so floor points come out with w > 0; then w <= 0
  // means "above the horizon" (wall or ceiling), which apply() rejects.
  const ws=pairs.map(({image:[u,v]})=>H[6]*u+H[7]*v+H[8]);
  if(ws.every(w=>w<0))H=H.map(v=>-v);
  else if(!ws.every(w=>w>0))throw Error('These points do not describe a floor seen by this camera. Check that each pair matches.');
  const errors=pairs.map(p=>{const q=apply(H,p.image);return q?Math.hypot(q[0]-p.floor[0],q[1]-p.floor[1]):Infinity;});
  if(errors.some(e=>!Number.isFinite(e)))throw Error('These points do not describe a floor seen by this camera. Check that each pair matches.');
  const rmsM=Math.sqrt(errors.reduce((s,e)=>s+e*e,0)/errors.length);
  return {points:pairs,H,rmsM:Math.round(rmsM*1000)/1000,maxErrorM:Math.round(Math.max(...errors)*1000)/1000,checked:pairs.length>4,savedAt:new Date().toISOString()};
}

// ---- named areas from the plan ----
function inside([x,y],pts){let c=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const [xi,yi]=pts[i],[xj,yj]=pts[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)c=!c;}return c;}
function segDist([x,y],[ax,ay],[bx,by]){const dx=bx-ax,dy=by-ay,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/l)):0;return Math.hypot(x-ax-t*dx,y-ay-t*dy);}
function polyDist(p,pts){return inside(p,pts)?0:Math.min(...pts.map((a,i)=>segDist(p,a,pts[(i+1)%pts.length])));}
const BESIDE_M=0.6,DOOR_M=0.8,WALL_M=0.5;
function areaFor(plan,p){
  if(!plan||!p)return 'unknown';
  const {widthM:w,depthM:d}=plan;
  const doors=(plan.doors||[]).filter(o=>o.offsetM!==null).map(o=>{const a=o.offsetM,b=a+o.widthM,e=o.wall==='bottom'?d:o.wall==='right'?w:0,h=o.wall==='top'||o.wall==='bottom';return {name:o.name,dist:segDist(p,h?[a,e]:[e,a],h?[b,e]:[e,b])};});
  const objects=(plan.footprints||[]).map(o=>({name:o.name,low:o.heightM!=null&&o.heightM<0.05,dist:polyDist(p,o.points)}));
  const door=doors.sort((a,b)=>a.dist-b.dist)[0],object=objects.sort((a,b)=>a.dist-b.dist)[0];
  if(door&&door.dist<=DOOR_M&&(!object||door.dist<=object.dist))return `at the ${door.name}`;
  // Floor-level items (rugs, mats) are stood on, not stood at.
  if(object&&object.dist===0)return `${object.low?'on':'at'} the ${object.name}`;
  if(object&&object.dist<=BESIDE_M)return `beside the ${object.name}`;
  const names=plan.wallNames||{},wall=(k,def)=>names[k]||`${def} wall`;
  const walls=[[wall('left','left'),p[0]],[wall('right','right'),w-p[0]],[wall('top','far'),p[1]],[wall('bottom','near'),d-p[1]]].sort((a,b)=>a[1]-b[1]);
  if(walls[0][1]<=WALL_M)return `by the ${walls[0][0]}`;
  return 'open floor';
}

// ---- live tracks reported by the desk's tracking page ----
// Furniture: smoothed slowly, confirmed only after steady sightings, never moved on the plan while a person blocks it.
const OBJECT_CLASSES=new Set(['chair','couch','bench','dining table','suitcase','backpack','handbag','potted plant','tv']);
// The detector often swaps between these labels for one object, so they are matched as one kind.
const FAMILY={chair:'seat',couch:'seat',bench:'seat',backpack:'bag',handbag:'bag',suitcase:'bag'},family=c=>FAMILY[c]||c;
const OBJECT_MATCH_M=0.7,OBJECT_CONFIRM=5,OBJECT_LOST_MS=3000,OBJECT_FORGET_MS=120000,MOVE_M=0.35,MOVE_SETTLE_MS=4000,MOVE_SPREAD_M=0.25,SUGGEST_OBJECT_M=1.0;
const centroid=pts=>[pts.reduce((a,p)=>a+p[0],0)/pts.length,pts.reduce((a,p)=>a+p[1],0)/pts.length];
const overlap=(a,b)=>{const x=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),y=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));return x*y/(a.w*a.h||1);};
// Animals (Yuri the studio dog): one track per named animal, followed like a person but never matched to a phone.
const ANIMAL_CLASSES=new Set(['dog','cat']),ANIMAL_LOST_MS=2500,ANIMAL_MIN_SCORE=0.35;
const LOST_AFTER_MS=1500,FORGET_AFTER_MS=60000,SUGGEST_WITHIN_MS=15000,SUGGEST_WITHIN_M=1.2,FRESH_MS=5000;
class Tracking{
  constructor(hooks={}){this.h=hooks;this.reset();}
  reset(){this.owner='';this.cameraId='';this.at=0;this.tracks=new Map();this.bindings=new Map();this.movement=[];this.serial=0;this.objects=this.objects||new Map();this.nextObject=this.nextObject||1;this.animals=this.animals||new Map();}
  // Positions: feet-on-floor estimate from the calibration; null when uncalibrated, feet hidden, or off the plan.
  update(input,{calibration,plan,now=Date.now()}){
    const tracker=text(input?.tracker,64);if(!tracker)throw Error('Tracking needs a tracker id.');
    if(this.owner&&this.owner!==tracker&&now-this.at<FRESH_MS)throw Error('Tracking is already running on another screen. Stop it there first.');
    const cameraId=text(input.cameraId,40);
    if(this.owner!==tracker||this.cameraId!==cameraId){this.reset();this.owner=tracker;this.cameraId=cameraId;}
    const list=Array.isArray(input.tracks)?input.tracks.slice(0,12):[];
    const seen=new Set();
    for(const t of list){
      const id=text(t?.id,24),b=t?.box;
      if(!id||!b||![b.x,b.y,b.w,b.h].every(finite))continue;
      seen.add(id);
      const prev=this.tracks.get(id),feetVisible=!!t.feetVisible,foot=[b.x+b.w/2,b.y+b.h];
      let floor=calibration?apply(calibration.H,foot):null;
      if(floor&&plan&&(floor[0]<-0.3||floor[1]<-0.3||floor[0]>plan.widthM+0.3||floor[1]>plan.depthM+0.3))floor=null;
      if(floor&&plan)floor=[Math.max(0,Math.min(plan.widthM,floor[0])),Math.max(0,Math.min(plan.depthM,floor[1]))];
      const area=floor?areaFor(plan,floor):'unknown';
      const track={id,box:{x:b.x,y:b.y,w:b.w,h:b.h},score:finite(t.score)?Math.round(t.score*100)/100:null,feetVisible,floor:floor&&floor.map(v=>Math.round(v*100)/100),area,certainty:floor&&feetVisible?'estimate':'uncertain',firstSeenAt:prev?.firstSeenAt||now,lastSeenAt:now,visible:true};
      if(track.certainty==='uncertain'&&prev?.floor&&!floor){track.floor=prev.floor;track.area=prev.area;}
      this.tracks.set(id,track);
      if(prev&&prev.area!==track.area&&track.area!=='unknown')this.moved(id,prev.area,track.area,now);
      else if(!prev)this.moved(id,null,track.area,now);
    }
    for(const [id,t] of this.tracks){
      if(seen.has(id))continue;
      if(t.visible&&now-t.lastSeenAt>LOST_AFTER_MS){t.visible=false;this.moved(id,t.area,'out of sight',now);}
      if(now-t.lastSeenAt>FORGET_AFTER_MS){this.tracks.delete(id);this.bindings.delete(id);}
    }
    this.plan=plan;
    this.updateAnimals(Array.isArray(input.animals)?input.animals.slice(0,6):[],input.animalNames||{},{calibration,plan,now});
    this.updateObjects(Array.isArray(input.objects)?input.objects.slice(0,20):[],list.map(t=>t?.box).filter(Boolean),{calibration,plan,now});
    this.at=now;return this.view(now);
  }
  moved(id,from,to,at){
    const b=this.bindings.get(id),who=b?b.label:`Track ${id}`;
    const entry={at,track:id,who,from,to};
    this.movement.push(entry);this.movement=this.movement.slice(-40);
    if(b)this.h.event?.('room_track',{track:id,phone:b.phone,role:b.role,from,to});
  }
  // Objects are matched by class and floor position, so they keep their identity even when the
  // browser's detector loses and re-finds them. Bound objects carry a plan footprint with them.
  updateObjects(list,people,{calibration,plan,now}){
    if(!calibration||!plan){for(const o of this.objects.values())o.visible=false;return;}
    const seen=new Set();
    for(const d of list){
      const cls=text(d?.cls,30),b=d?.box;
      if(!OBJECT_CLASSES.has(cls)||!b||![b.x,b.y,b.w,b.h].every(finite)||b.w<=0||b.h<=0)continue;
      const base=apply(calibration.H,[b.x+b.w/2,b.y+b.h]);
      if(!base||base[0]<-0.3||base[1]<-0.3||base[0]>plan.widthM+0.3||base[1]>plan.depthM+0.3)continue;
      const blocked=people.some(p=>overlap(b,p)>0.15||overlap(p,b)>0.3);
      // Match against where it was last seen (o.at), which keeps following it while someone carries it.
      let best=null;for(const o of this.objects.values()){if(family(o.cls)!==family(cls)||seen.has(o.id))continue;const dd=Math.hypot(o.at[0]-base[0],o.at[1]-base[1]);if(dd<=OBJECT_MATCH_M&&(!best||dd<best.dd))best={o,dd};}
      let o=best?.o;
      // It jumped (moved while out of view): if exactly one matched object of this kind is missing, it is that one.
      if(!o){const missing=[...this.objects.values()].filter(x=>family(x.cls)===family(cls)&&x.binding&&!seen.has(x.id)&&now-x.lastSeenAt>OBJECT_LOST_MS/2);if(missing.length===1)o=missing[0];}
      if(!o){o={id:'F'+this.nextObject++,cls,floor:base,at:base,firstSeenAt:now,sightings:0,samples:[],boxW:b.w,binding:null};this.objects.set(o.id,o);}
      seen.add(o.id);
      o.at=base;o.lastSeenAt=now;o.visible=true;o.blocked=blocked;o.score=finite(d.score)?Math.round(d.score*100)/100:null;o.box={x:b.x,y:b.y,w:b.w,h:b.h};
      if(blocked)continue;   // a person in front shifts the box: keep the last clean position
      o.sightings++;o.floor=o.sightings===1||Math.hypot(o.floor[0]-base[0],o.floor[1]-base[1])>MOVE_M?base:[o.floor[0]*0.8+base[0]*0.2,o.floor[1]*0.8+base[1]*0.2];o.boxW=o.boxW*0.9+b.w*0.1;
      o.samples.push({at:now,p:base,w:b.w});o.samples=o.samples.filter(q=>now-q.at<=MOVE_SETTLE_MS);
      if(o.binding)this.checkMove(o,plan,now);
    }
    for(const o of this.objects.values()){
      if(seen.has(o.id))continue;
      if(o.visible&&now-o.lastSeenAt>OBJECT_LOST_MS)o.visible=false;
      if(!o.binding&&now-o.lastSeenAt>OBJECT_FORGET_MS)this.objects.delete(o.id);
    }
  }
  // Each kind of animal is one track: the most confident sighting this frame. Names come from the room setup.
  updateAnimals(list,names,{calibration,plan,now}){
    const best=new Map();
    for(const d of list){const cls=text(d?.cls,20),b=d?.box;if(!ANIMAL_CLASSES.has(cls)||!b||![b.x,b.y,b.w,b.h].every(finite)||!(d.score>=ANIMAL_MIN_SCORE))continue;if(!best.has(cls)||best.get(cls).score<d.score)best.set(cls,{...d,cls});}
    for(const [cls,d] of best){
      const b=d.box,base=calibration?apply(calibration.H,[b.x+b.w/2,b.y+b.h]):null;
      let floor=base&&plan&&base[0]>=-0.3&&base[1]>=-0.3&&base[0]<=plan.widthM+0.3&&base[1]<=plan.depthM+0.3?[Math.max(0,Math.min(plan.widthM,base[0])),Math.max(0,Math.min(plan.depthM,base[1]))]:null;
      const prev=this.animals.get(cls),name=text(names[cls],60)||cls[0].toUpperCase()+cls.slice(1);
      if(floor&&prev?.floor&&prev.visible)floor=[prev.floor[0]*0.5+floor[0]*0.5,prev.floor[1]*0.5+floor[1]*0.5];
      const area=floor?areaFor(plan,floor):'unknown';
      const a={id:cls,cls,name,box:b,score:Math.round(d.score*100)/100,floor:floor&&floor.map(v=>Math.round(v*100)/100),area,visible:true,lastSeenAt:now,firstSeenAt:prev?.firstSeenAt||now};
      this.animals.set(cls,a);
      if(!prev||!prev.visible)this.animalMoved(a,prev?.visible===false?'out of sight':null,area,now);
      else if(prev.area!==area&&area!=='unknown')this.animalMoved(a,prev.area,area,now);
    }
    for(const a of this.animals.values())if(!best.has(a.cls)&&a.visible&&now-a.lastSeenAt>ANIMAL_LOST_MS){a.visible=false;this.animalMoved(a,a.area,'out of sight',now);}
  }
  animalMoved(a,from,to,at){this.movement.push({at,track:a.id,who:a.name,from,to,animal:true});this.movement=this.movement.slice(-40);this.h.event?.('room_animal',{name:a.name,from,to});}
  checkMove(o,plan,now){
    const b=o.binding,s=o.samples;
    if(s.length<4||now-s[0].at<MOVE_SETTLE_MS*0.75)return;
    // All recent sightings agree with each other, are a similar size to when it was matched, and are well away from where it was.
    const mx=s.reduce((a,q)=>a+q.p[0],0)/s.length,my=s.reduce((a,q)=>a+q.p[1],0)/s.length;
    const spread=Math.max(...s.map(q=>Math.hypot(q.p[0]-mx,q.p[1]-my)));
    const sizeOk=s.every(q=>Math.abs(q.w-b.boxW)/b.boxW<0.4);
    const delta=[mx-b.ref[0],my-b.ref[1]],dist=Math.hypot(...delta);
    if(spread>MOVE_SPREAD_M||!sizeOk||dist<MOVE_M)return;
    const from=areaFor(plan,b.ref);
    const moved=this.h.moveFootprint?.(b.footprint,delta);
    if(!moved)return;
    b.ref=[mx,my];o.floor=[mx,my];o.samples=[];
    const to=areaFor(moved,[mx,my]);
    const entry={at:now,track:o.id,who:b.footprint,from,to,object:true,distanceM:Math.round(dist*10)/10};
    this.movement.push(entry);this.movement=this.movement.slice(-40);
    this.h.event?.('room_object_moved',{object:o.id,footprint:b.footprint,deltaM:delta.map(v=>Math.round(v*100)/100)});
  }
  // The operator says which plan item a detected object is ("this is the Armchair").
  bindObject(input,plan){
    const o=this.objects.get(text(input?.objectId,24));if(!o)throw Error('That object is no longer tracked.');
    if(input.footprint===null){o.binding=null;return;}
    const name=text(input.footprint,100),fp=(plan?.footprints||[]).find(f=>f.name===name);
    if(!fp)throw Error('Choose an item on the floor plan.');
    for(const other of this.objects.values())if(other.binding?.footprint===name)other.binding=null;
    o.binding={footprint:name,ref:o.floor.slice(),boxW:o.boxW,confirmedAt:Date.now()};o.samples=[];
  }
  objectSuggestions(plan){
    const bound=new Set([...this.objects.values()].filter(o=>o.binding).map(o=>o.binding.footprint)),out=[];
    for(const o of this.objects.values()){
      if(o.binding||o.sightings<OBJECT_CONFIRM)continue;
      let best=null;for(const f of plan?.footprints||[]){if(bound.has(f.name)||(f.heightM!=null&&f.heightM<0.05))continue;const d=polyDist(o.floor,f.points);if(d<=SUGGEST_OBJECT_M&&(!best||d<best.d))best={f,d};}
      if(best)out.push({objectId:o.id,cls:o.cls,footprint:best.f.name,distanceM:Math.round(best.d*10)/10});
    }
    return out;
  }
  // The operator says which phone/role a track is. Moves the binding off any other track.
  bind(input){
    const id=text(input?.trackId,24),t=this.tracks.get(id);if(!t)throw Error('That person is no longer tracked. Choose a visible track.');
    if(input.phone===null){this.bindings.delete(id);return;}
    const phone=Number(input.phone);if(!Number.isInteger(phone)||phone<1||phone>(this.h.maxPhones?.()||8))throw Error('Choose a valid phone slot.');
    for(const [k,b] of this.bindings)if(b.phone===phone)this.bindings.delete(k);
    const role=text(input.role,100);
    this.bindings.set(id,{phone,role,label:role?`${role} (phone ${phone})`:`Phone ${phone}`,confirmedAt:Date.now()});
  }
  // A role whose track was lost recently, and a new unbound track appeared near where it was last seen.
  suggestions(now=Date.now()){
    const out=[];
    for(const [lostId,b] of this.bindings){
      const lost=this.tracks.get(lostId);if(!lost||lost.visible||now-lost.lastSeenAt>SUGGEST_WITHIN_MS||!lost.floor)continue;
      for(const t of this.tracks.values()){
        if(!t.visible||this.bindings.has(t.id)||!t.floor||t.firstSeenAt<lost.lastSeenAt-500)continue;
        const dist=Math.hypot(t.floor[0]-lost.floor[0],t.floor[1]-lost.floor[1]);
        if(dist<=SUGGEST_WITHIN_M)out.push({trackId:t.id,fromTrack:lostId,phone:b.phone,role:b.role,label:b.label,distanceM:Math.round(dist*10)/10});
      }
    }
    return out.sort((a,b)=>a.distanceM-b.distanceM);
  }
  view(now=Date.now()){
    return {running:!!this.owner&&now-this.at<FRESH_MS,owner:this.owner,cameraId:this.cameraId,at:this.at,
      tracks:[...this.tracks.values()].map(t=>({...t,binding:this.bindings.get(t.id)||null})),
      movement:this.movement.slice(-20),suggestions:this.suggestions(now),
      animals:[...this.animals.values()],
      objects:[...this.objects.values()].filter(o=>o.binding||o.sightings>=OBJECT_CONFIRM).map(o=>({id:o.id,cls:o.cls,floor:o.floor.map(v=>Math.round(v*100)/100),visible:!!o.visible,blocked:!!o.blocked,score:o.score,box:o.box,lastSeenAt:o.lastSeenAt,binding:o.binding&&{footprint:o.binding.footprint}})),
      objectSuggestions:this.plan?this.objectSuggestions(this.plan):[]};
  }
  stop(tracker){if(!tracker||tracker===this.owner){this.owner='';this.at=0;}}
  // What the directors may read: only bound roles, only while tracking is fresh.
  context(now=Date.now()){
    if(!this.owner||now-this.at>FRESH_MS)return null;
    const people=[...this.tracks.values()].filter(t=>this.bindings.has(t.id)).map(t=>{const b=this.bindings.get(t.id);return {who:b.label,phone:b.phone,role:b.role,visible:t.visible,area:t.area,floorM:t.floor,certainty:t.visible?t.certainty:'last seen',secondsSinceSeen:Math.round((now-t.lastSeenAt)/1000)};});
    const unassigned=[...this.tracks.values()].filter(t=>t.visible&&!this.bindings.has(t.id)).length;
    const recent=this.movement.filter(m=>!m.object&&!m.animal&&this.bindings.has(m.track)&&now-m.at<120000).slice(-8).map(m=>({who:m.who,from:m.from,to:m.to,secondsAgo:Math.round((now-m.at)/1000)}));
    const furniture=[...this.objects.values()].filter(o=>o.binding).map(o=>({name:o.binding.footprint,seen:o.visible?'now':`${Math.round((now-o.lastSeenAt)/1000)} s ago`}));
    const furnitureMoves=this.movement.filter(m=>m.object&&now-m.at<300000).slice(-5).map(m=>({item:m.who,from:m.from,to:m.to,metres:m.distanceM,secondsAgo:Math.round((now-m.at)/1000)}));
    const animals=[...this.animals.values()].map(a=>({name:a.name,kind:a.cls,visible:a.visible,area:a.area,secondsSinceSeen:Math.round((now-a.lastSeenAt)/1000)}));
    return {people,unassignedPeopleVisible:unassigned,recentMovement:recent,furniture,furnitureMoves,animals};
  }
}
module.exports={ANIMAL_CLASSES,OBJECT_CLASSES,fitHomography,apply,invert,calibrate,areaFor,Tracking,solve};
