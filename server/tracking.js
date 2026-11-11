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
  const fitPoints = pairs.length > 4 ? pairs.slice(0,-1) : pairs;
  const checkPoints = pairs.length > 4 ? pairs.slice(-1) : [];
  let spread=0;
  for(let i=0;i<fitPoints.length;i++)for(let j=i+1;j<fitPoints.length;j++)for(let k=j+1;k<fitPoints.length;k++){
    spread=Math.max(spread,Math.abs(cross(fitPoints[i].image,fitPoints[j].image,fitPoints[k].image)));
  }
  let H=fitHomography(fitPoints);
  if(!H||spread<0.01||!invert(H))throw Error('Spread the points out across the visible floor; they cannot all sit on one line.');
  // H is only defined up to scale. Flip its sign so floor points come out with w > 0; then w <= 0
  // means "above the horizon" (wall or ceiling), which apply() rejects.
  const ws=fitPoints.map(({image:[u,v]})=>H[6]*u+H[7]*v+H[8]);
  if(ws.every(w=>w<0))H=H.map(v=>-v);
  else if(!ws.every(w=>w>0))throw Error('These points do not describe a floor seen by this camera. Check that each pair matches.');
  const errors=(checkPoints.length ? checkPoints : fitPoints).map(p=>{const q=apply(H,p.image);return q?Math.hypot(q[0]-p.floor[0],q[1]-p.floor[1]):Infinity;});
  if(errors.some(e=>!Number.isFinite(e)))throw Error('These points do not describe a floor seen by this camera. Check that each pair matches.');
  const rmsM=Math.sqrt(errors.reduce((s,e)=>s+e*e,0)/errors.length);
  return {points:pairs,H,rmsM:Math.round(rmsM*1000)/1000,maxErrorM:Math.round(Math.max(...errors)*1000)/1000,checked:checkPoints.length>0,validation:checkPoints.length?'holdout':null,savedAt:new Date().toISOString()};
}

// Where a person stands, worked out from their head when their feet are hidden. Needs the camera's
// position (x, y on the plan, z above the floor): the head lies on the line from the camera to the floor
// point "behind" it, at head height, so the person stands at camera + (that floor point - camera) * (z - h) / z.
const HEAD_HEIGHT_M=1.7;
function fromHead(H,cam,box,h=HEAD_HEIGHT_M){
  if(!cam||!(cam.z>h))return null;
  const p=apply(H,[box.x+box.w/2,box.y]);if(!p)return null;
  const k=(cam.z-h)/cam.z;return [cam.x+(p[0]-cam.x)*k,cam.y+(p[1]-cam.y)*k];
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
const LOST_AFTER_MS=1500,FORGET_AFTER_MS=60000,REJOIN_MS=4000,REJOIN_GAP=0.15,SUGGEST_WITHIN_MS=15000,SUGGEST_WITHIN_M=1.2,FRESH_MS=5000;
// Compare a short history of fresh floor positions. Require motion to exceed the position error.
function activityFor(samples,now){
  const first=samples[0], last=samples.at(-1);
  if(first && last.at-first.at>=800 && now-last.at<=500){
    const metres=Math.hypot(last.floor[0]-first.floor[0],last.floor[1]-first.floor[1]);
    if(metres>Math.max(0.45,first.radius+last.radius))return {label:'moving',source:'floor history',observedAt:last.at};
    if(first.seated && samples.every(sample=>sample.seated))return {label:'appears seated',source:'pose history',observedAt:last.at};
    if(metres<0.2)return {label:'staying in place',source:'floor history',observedAt:last.at};
  }
  return null;
}
class Tracking{
  constructor(hooks={}){this.h=hooks;this.reset();}
  reset(){this.owner='';this.cameraId='';this.at=0;this.tracks=new Map();this.bindings=new Map();this.movement=[];this.serial=0;this.objects=this.objects||new Map();this.nextObject=this.nextObject||1;this.animals=this.animals||new Map();this.smoothers=new Map();this.activitySamples=new Map();this.alias=new Map();}
  // Positions: feet-on-floor estimate from the calibration; null when uncalibrated, feet hidden, or off the plan.
  update(input,{calibration,plan,now=Date.now()}){
    const tracker=text(input?.tracker,64);if(!tracker)throw Error('Tracking needs a tracker id.');
    if(this.owner&&this.owner!==tracker&&now-this.at<FRESH_MS)throw Error('Tracking is already running on another screen. Stop it there first.');
    const cameraId=text(input.cameraId,40);
    if(this.owner!==tracker||this.cameraId!==cameraId){this.reset();this.owner=tracker;this.cameraId=cameraId;}
    const list=Array.isArray(input.tracks)?input.tracks.slice(0,12):[];
    const seen=new Set(),present=new Set(list.map(t=>{const r=text(t?.id,24);return this.alias.get(r)||r;})),claimed=new Set();
    for(const t of list){
      const raw=text(t?.id,24),b=t?.box;
      if(!raw||!b||![b.x,b.y,b.w,b.h].every(finite))continue;
      // The detector gives someone a new number after they are briefly hidden. Someone appearing where a
      // person was just lost, at a similar size, is that person: keep their number, phone and name.
      let id=this.alias.get(raw)||raw;
      if(!this.tracks.has(id)){
        const cx=b.x+b.w/2,cy=b.y+b.h/2;let best=null;
        for(const [oid,o] of this.tracks){
          if(present.has(oid)||claimed.has(oid)||!o.box||now-o.lastSeenAt>REJOIN_MS||now-o.lastSeenAt<200||/door/i.test(o.area||''))continue;   // at a door it may be someone new: the desk is asked instead
          const d=Math.hypot(o.box.x+o.box.w/2-cx,o.box.y+o.box.h/2-cy),size=b.h/Math.max(0.01,o.box.h);
          if(d<=REJOIN_GAP&&size>0.6&&size<1.6&&(!best||d<best.d))best={oid,d};
        }
        if(best){this.alias.set(raw,best.oid);id=best.oid;claimed.add(id);this.h.event?.('room_track_rejoined',{from:raw,to:id});}
      }
      seen.add(id);
      const prev=this.tracks.get(id),feetVisible=!!t.feetVisible,foot=[b.x+b.w/2,b.y+b.h];
      let floor=calibration?apply(calibration.H,foot):null,how=feetVisible?'feet':'';
      // Feet hidden (off the picture, or "standing" inside a table or bench): place them from the head instead.
      const onFurniture=floor&&plan&&(plan.footprints||[]).some(f=>f.heightM!=null&&f.heightM>=0.5&&inside(floor,f.points));
      let seat=null;
      if(!feetVisible||onFurniture){
        // Sitting: their lower body overlaps a seat the object finder has placed. They are on that seat.
        const lower={x:b.x,y:b.y+b.h*0.4,w:b.w,h:b.h*0.6};
        seat=(calibration?this.finderStatus?.(now)?.objects||[]:[]).filter(o=>o.visible&&o.floor&&o.box&&/stool|chair|armchair|sofa/i.test(o.name)).find(o=>{const x=Math.max(0,Math.min(lower.x+lower.w,o.box.x+o.box.w)-Math.max(lower.x,o.box.x)),y=Math.max(0,Math.min(lower.y+lower.h,o.box.y+o.box.h)-Math.max(lower.y,o.box.y));return x*y>0.2*o.box.w*o.box.h;})||null;
        // Otherwise from the head; with a low camera this is sensitive to height, so only accept it inside the room.
        floor=seat?seat.floor.slice():calibration?.camera?fromHead(calibration.H,calibration.camera,b):null;
        if(!seat&&floor&&plan&&(floor[0]<0||floor[1]<0||floor[0]>plan.widthM||floor[1]>plan.depthM))floor=null;
        how=seat?'seat':floor?'head':'';
      }
      if(floor&&plan&&(floor[0]<-0.3||floor[1]<-0.3||floor[0]>plan.widthM+0.3||floor[1]>plan.depthM+0.3))floor=null;
      if(floor&&plan)floor=[Math.max(0,Math.min(plan.widthM,floor[0])),Math.max(0,Math.min(plan.depthM,floor[1]))];
      // Body points (ankles, hips, head), when the detector gives them, beat the box: each gives a position
      // with an honest error radius, and the smallest wins (positioning.js).
      let radius=how==='feet'?0.3:how==='seat'?0.25:how==='head'?0.8:null;
      const kp=Array.isArray(t.kp)&&t.kp.length===17&&t.kp.every(q=>Array.isArray(q)&&q.length===3&&q.every(finite))?t.kp:null;
      if(kp&&calibration&&!seat){
        seat=require('./positioning').reviewedSeat(calibration,plan,kp,b,now,prev);
        if(seat){floor=seat.floor;radius=.35;how='seat';}
      }
      if(kp&&calibration&&!seat){const P=require('./positioning'),best=P.place({H:calibration.H,cam:calibration.camera,plan,kp});if(best){floor=best.floor;radius=best.radius;how=best.how;}}
      // Smoothed over time and weighted by radius; held for a moment through brief blocking.
      if(calibration){
        const P=require('./positioning');let sm=this.smoothers.get(id);if(!sm || (how==='seat' && prev?.area!==`seated on the ${seat?.name}`)){sm=new P.Smoother();this.smoothers.set(id,sm);}
        const out=sm.step(floor&&radius?{floor,radius,how}:null,now);
        if(out){floor=out.floor;radius=out.radius;how=out.how;}
      }
      const conf=floor&&radius!=null?require('./positioning').confidence(radius,how):'unsure';
      // An unsure position does not change the named area: that would make Mother act on a guess.
      const area=seat?`seated on the ${seat.name}`:!floor?'unknown':conf==='unsure'&&prev?.area&&prev.area!=='unknown'?prev.area:areaFor(plan,floor);
      const certainty={feet:'estimate',seat:'seated',head:'from head',hips:'from hips','hips (seated)':'seated',held:'last seen'}[how]||(floor?'estimate':'uncertain');
      const track={id,box:{x:b.x,y:b.y,w:b.w,h:b.h},score:finite(t.score)?Math.round(t.score*100)/100:null,feetVisible:how==='feet'||feetVisible,floor:floor&&floor.map(v=>Math.round(v*100)/100),area,certainty,how:how||null,radiusM:radius!=null&&floor?Math.round(radius*100)/100:null,confidence:conf,firstSeenAt:prev?.firstSeenAt||now,lastSeenAt:now,visible:true};
      if(kp)track.kp=kp;
      track.positionAt=floor?now:null;
      if(!floor&&calibration&&prev?.floor){
        track.floor=prev.floor;track.area=prev.area;track.certainty='last seen';track.confidence='unsure';track.radiusM=prev.radiusM;
        track.positionAt=prev.positionAt;
      }
      const samples=(this.activitySamples.get(id)||[]).filter(sample=>now-sample.at<=1800);
      if(!prev?.visible || now-prev.lastSeenAt>900) samples.length=0;
      if(track.floor && track.confidence!=='unsure' && track.how!=='held'){
        samples.push({at:now,floor:track.floor,radius:track.radiusM,seated:!!seat||!!(kp&&require('./positioning').looksSeated(kp))});
      } else samples.length=0;
      this.activitySamples.set(id,samples);
      track.activity=activityFor(samples,now);
      if(track.activity && track.activity.label!==prev?.activity?.label){
        this.h.event?.('room_activity',{track:id,cameraId,label:track.activity.label,source:track.activity.source});
      }
      this.tracks.set(id,track);
      if(prev&&prev.area!==track.area&&track.area!=='unknown')this.moved(id,prev.area,track.area,now);
      else if(!prev)this.moved(id,null,track.area,now);
    }
    for(const [id,t] of this.tracks){
      if(seen.has(id))continue;
      if(t.visible&&now-t.lastSeenAt>LOST_AFTER_MS){t.visible=false;this.moved(id,t.area,'out of sight',now);}
      if(now-t.lastSeenAt>FORGET_AFTER_MS){for(const [r,a] of this.alias)if(a===id)this.alias.delete(r);this.tracks.delete(id);this.bindings.delete(id);this.smoothers.delete(id);this.activitySamples.delete(id);}
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
      if(blocked){o.proposal=null;o.samples=[];continue;}   // a person in front shifts the box: keep the last clean position
      o.sightings++;o.floor=o.sightings===1||Math.hypot(o.floor[0]-base[0],o.floor[1]-base[1])>MOVE_M?base:[o.floor[0]*0.8+base[0]*0.2,o.floor[1]*0.8+base[1]*0.2];o.boxW=o.boxW*0.9+b.w*0.1;
      o.samples.push({at:now,p:base,w:b.w});o.samples=o.samples.filter(q=>now-q.at<=MOVE_SETTLE_MS);
      if(o.binding)this.checkMove(o,plan,now);
    }
    for(const o of this.objects.values()){
      if(seen.has(o.id))continue;
      if(o.visible&&now-o.lastSeenAt>OBJECT_LOST_MS){o.visible=false;o.proposal=null;}
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
    if(s.length<4||now-s[0].at<MOVE_SETTLE_MS*0.75){o.proposal=null;return;}
    // All recent sightings agree with each other, are a similar size to when it was matched, and are well away from where it was.
    const mx=s.reduce((a,q)=>a+q.p[0],0)/s.length,my=s.reduce((a,q)=>a+q.p[1],0)/s.length;
    const spread=Math.max(...s.map(q=>Math.hypot(q.p[0]-mx,q.p[1]-my)));
    const sizeOk=s.every(q=>Math.abs(q.w-b.boxW)/b.boxW<0.4);
    const delta=[mx-b.ref[0],my-b.ref[1]],dist=Math.hypot(...delta);
    if(spread>MOVE_SPREAD_M||!sizeOk||dist<MOVE_M){o.proposal=null;return;}
    if(!o.proposal||Math.hypot(mx-o.proposal.to[0],my-o.proposal.to[1])>0.15){
      o.proposal={at:now,from:b.ref.slice(),to:[mx,my],delta,distanceM:Math.round(dist*100)/100,geometry:JSON.stringify(plan.footprints?.find(f=>f.name===b.footprint)?.points)};
    }
  }
  acceptObjectMove(input,plan,now=Date.now()){
    const o=this.objects.get(text(input?.objectId,24)),proposal=o?.proposal;
    if(!this.viewIsFresh(now)||!o?.binding||!o.visible||o.blocked||!proposal||proposal.at!==input.at)
      throw Error('That furniture move is no longer current.');
    const b=o.binding,{delta,to:[mx,my]}=proposal,dist=Math.hypot(...delta);
    if(proposal.geometry!==JSON.stringify(plan?.footprints?.find(f=>f.name===b.footprint)?.points)){
      o.proposal=null;
      throw Error('The plan changed. Wait for a fresh furniture proposal.');
    }
    const from=areaFor(plan,b.ref);
    const moved=this.h.moveFootprint?.(b.footprint,delta);
    if(!moved)return;
    b.ref=[mx,my];o.floor=[mx,my];o.samples=[];o.proposal=null;
    const to=areaFor(moved,[mx,my]);
    const entry={at:now,track:o.id,who:b.footprint,from,to,object:true,distanceM:Math.round(dist*10)/10};
    this.movement.push(entry);this.movement=this.movement.slice(-40);
    this.h.event?.('room_object_moved',{object:o.id,footprint:b.footprint,deltaM:delta.map(v=>Math.round(v*100)/100)});
  }
  // The operator says which plan item a detected object is ("this is the Armchair").
  bindObject(input,plan){
    const o=this.objects.get(text(input?.objectId,24));if(!o)throw Error('That object is no longer tracked.');
    o.proposal=null;
    if(input.footprint===null){o.binding=null;return;}
    const name=text(input.footprint,100),fp=(plan?.footprints||[]).find(f=>f.name===name);
    if(!fp)throw Error('Choose an item on the floor plan.');
    for(const other of this.objects.values())if(other.binding?.footprint===name){other.binding=null;other.proposal=null;}
    o.binding={footprint:name,ref:o.floor.slice(),boxW:o.boxW,confirmedAt:Date.now()};o.samples=[];
  }
  objectSuggestions(plan){
    // Only suggest like for like: a detected chair can be a stool or the Armchair, never the Work bench; a TV never the Shelves.
    const kind=(t)=>/tv|screen|monitor|laptop/i.test(t)?'screen':/stool|chair|sofa|couch|seat|bench(?!.*work)|armchair/i.test(t)&&!/work ?bench/i.test(t)?'seat':/table|desk|bench/i.test(t)?'table':/shel|cabinet|cupboard|drawer|book/i.test(t)?'storage':/bed/i.test(t)?'bed':null;
    const fits=(cls,name)=>{const a=kind(cls),b=kind(name);return !a||!b||a===b;};
    const bound=new Set([...this.objects.values()].filter(o=>o.binding).map(o=>o.binding.footprint)),out=[];
    for(const o of this.objects.values()){
      if(o.binding||o.sightings<OBJECT_CONFIRM)continue;
      let best=null;for(const f of plan?.footprints||[]){if(bound.has(f.name)||(f.heightM!=null&&f.heightM<0.05)||!fits(o.cls,f.name))continue;const d=polyDist(o.floor,f.points);if(d<=SUGGEST_OBJECT_M&&(!best||d<best.d))best={f,d};}
      if(best)out.push({objectId:o.id,cls:o.cls,footprint:best.f.name,distanceM:Math.round(best.d*10)/10});
    }
    return out;
  }
  // Face recognition named this track (a registered person who agreed to face matching).
  // A person can only be one track; an operator's own naming of the track is kept as its label.
  identify(trackId,person){
    const t=this.tracks.get(trackId);if(!t||!person?.pid)return;
    for(const [k,b] of this.bindings)if(k!==trackId&&b.person?.pid===person.pid){if(b.phone===null&&b.by==='face')this.bindings.delete(k);else delete b.person;}
    const by=person.by==='desk'?'desk':'face',label=`${person.name}${person.number?` #${person.number}`:''}`,b=this.bindings.get(trackId);
    if(b){
      if(b.by==='desk'&&by==='face'&&b.person?.pid!==person.pid)return;   // the desk's choice wins over a face match
      const changed=b.person?.pid!==person.pid,keep=b.by==='desk'&&by==='face';   // a face match agreeing with the desk keeps it the desk's
      b.person={...person,by:keep?'desk':by,score:person.score??b.person?.score};
      if(b.phone===null&&(b.by==='face'||b.by==='desk'||!b.by)){b.label=label;if(!keep)b.by=by;}
      if(changed)this.h.event?.('room_identified',{track:trackId,pid:person.pid,name:person.name,by});return;
    }
    this.bindings.set(trackId,{phone:null,role:'',label,person:{...person,by},by,confirmedAt:Date.now()});
    this.h.event?.('room_identified',{track:trackId,pid:person.pid,name:person.name});
  }
  // The operator says which phone/role a track is. Moves the binding off any other track.
  bind(input){
    const id=text(input?.trackId,24),t=this.tracks.get(id);if(!t)throw Error('That person is no longer tracked. Choose a visible track.');
    const name=text(input.name,100);
    if(name){
      if(!t.visible||Date.now()-t.lastSeenAt>FRESH_MS)throw Error('Choose a person currently in view.');
      for(const [key,binding] of this.bindings){
        if(binding.phone===null&&binding.label===name)this.bindings.delete(key);
      }
      this.bindings.set(id,{phone:null,role:'',label:name,confirmedAt:Date.now()});
      return;
    }
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
      const lost=this.tracks.get(lostId);if(b.phone===null||!lost||lost.visible||now-lost.lastSeenAt>SUGGEST_WITHIN_MS||!lost.floor)continue;
      for(const t of this.tracks.values()){
        if(!t.visible||this.bindings.has(t.id)||!t.floor||t.firstSeenAt<lost.lastSeenAt-500)continue;
        const dist=Math.hypot(t.floor[0]-lost.floor[0],t.floor[1]-lost.floor[1]);
        if(dist<=SUGGEST_WITHIN_M)out.push({trackId:t.id,fromTrack:lostId,phone:b.phone,role:b.role,label:b.label,distanceM:Math.round(dist*10)/10});
      }
    }
    return out.sort((a,b)=>a.distanceM-b.distanceM);
  }
  viewIsFresh(now){return !!this.owner&&now-this.at<FRESH_MS;}
  view(now=Date.now()){
    return {running:this.viewIsFresh(now),owner:this.owner,cameraId:this.cameraId,at:this.at,
      tracks:[...this.tracks.values()].map(t=>({...t,activity:this.viewIsFresh(now)&&t.visible&&now-t.lastSeenAt<=1000?t.activity:null,binding:this.bindings.get(t.id)||null})),
      movement:this.movement.slice(-20),suggestions:this.suggestions(now),faces:this.faceStatus?.(now)||null,finder:this.finderStatus?.(now)||null,pose:this.poseStatus?.()||null,cameraControl:this.cameraStatus?.()||null,
      animals:[...this.animals.values()],
      objects:[...this.objects.values()].filter(o=>o.binding||o.sightings>=OBJECT_CONFIRM).map(o=>({id:o.id,cls:o.cls,floor:o.floor.map(v=>Math.round(v*100)/100),visible:!!o.visible,blocked:!!o.blocked,score:o.score,box:o.box,lastSeenAt:o.lastSeenAt,proposal:this.viewIsFresh(now)&&o.visible&&o.binding?o.proposal:null,binding:o.binding&&{footprint:o.binding.footprint}})),
      objectSuggestions:this.plan?this.objectSuggestions(this.plan):[]};
  }
  stop(tracker){if(!tracker||tracker===this.owner){this.owner='';this.at=0;}}
  // What the directors may read: only bound roles, only while tracking is fresh.
  context(now=Date.now()){
    if(!this.owner||now-this.at>FRESH_MS)return null;
    const people=[...this.tracks.values()].filter(t=>this.bindings.has(t.id)).map(t=>{const b=this.bindings.get(t.id);return {who:b.label,phone:b.phone,role:b.role,visible:t.visible,area:t.area,floorM:t.floor,certainty:t.visible?t.certainty:'last seen',confidence:t.visible?t.confidence||'unsure':'unsure',radiusM:t.radiusM??null,secondsSinceSeen:Math.round((now-t.lastSeenAt)/1000),secondsSincePosition:t.positionAt==null?null:Math.round((now-t.positionAt)/1000)};});
    const unassigned=[...this.tracks.values()].filter(t=>t.visible&&!this.bindings.has(t.id)).length;
    const recent=this.movement.filter(m=>!m.object&&!m.animal&&this.bindings.has(m.track)&&now-m.at<120000).slice(-8).map(m=>({who:m.who,from:m.from,to:m.to,secondsAgo:Math.round((now-m.at)/1000)}));
    const furniture=[...this.objects.values()].filter(o=>o.binding).map(o=>({name:o.binding.footprint,seen:o.visible?'now':`${Math.round((now-o.lastSeenAt)/1000)} s ago`}));
    const furnitureMoves=this.movement.filter(m=>m.object&&now-m.at<300000).slice(-5).map(m=>({item:m.who,from:m.from,to:m.to,metres:m.distanceM,secondsAgo:Math.round((now-m.at)/1000)}));
    const animals=[...this.animals.values()].map(a=>({name:a.name,kind:a.cls,visible:a.visible,area:a.area,secondsSinceSeen:Math.round((now-a.lastSeenAt)/1000)}));
    return {people,unassignedPeopleVisible:unassigned,recentMovement:recent,furniture,furnitureMoves,animals};
  }
}
module.exports={fromHead,ANIMAL_CLASSES,OBJECT_CLASSES,fitHomography,apply,invert,calibrate,areaFor,Tracking,solve};
