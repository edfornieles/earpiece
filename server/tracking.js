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
  const objects=(plan.footprints||[]).map(o=>({name:o.name,dist:polyDist(p,o.points)}));
  const door=doors.sort((a,b)=>a.dist-b.dist)[0],object=objects.sort((a,b)=>a.dist-b.dist)[0];
  if(door&&door.dist<=DOOR_M&&(!object||door.dist<=object.dist))return `at the ${door.name}`;
  if(object&&object.dist===0)return `at the ${object.name}`;
  if(object&&object.dist<=BESIDE_M)return `beside the ${object.name}`;
  const walls=[['left',p[0]],['right',w-p[0]],['far',p[1]],['near',d-p[1]]].sort((a,b)=>a[1]-b[1]);
  if(walls[0][1]<=WALL_M)return `by the ${walls[0][0]} wall`;
  return 'open floor';
}

// ---- live tracks reported by the desk's tracking page ----
const LOST_AFTER_MS=1500,FORGET_AFTER_MS=60000,SUGGEST_WITHIN_MS=15000,SUGGEST_WITHIN_M=1.2,FRESH_MS=5000;
class Tracking{
  constructor(hooks={}){this.h=hooks;this.reset();}
  reset(){this.owner='';this.cameraId='';this.at=0;this.tracks=new Map();this.bindings=new Map();this.movement=[];this.serial=0;}
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
    this.at=now;return this.view(now);
  }
  moved(id,from,to,at){
    const b=this.bindings.get(id),who=b?b.label:`Track ${id}`;
    const entry={at,track:id,who,from,to};
    this.movement.push(entry);this.movement=this.movement.slice(-40);
    if(b)this.h.event?.('room_track',{track:id,phone:b.phone,role:b.role,from,to});
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
      movement:this.movement.slice(-20),suggestions:this.suggestions(now)};
  }
  stop(tracker){if(!tracker||tracker===this.owner){this.owner='';this.at=0;}}
  // What the directors may read: only bound roles, only while tracking is fresh.
  context(now=Date.now()){
    if(!this.owner||now-this.at>FRESH_MS)return null;
    const people=[...this.tracks.values()].filter(t=>this.bindings.has(t.id)).map(t=>{const b=this.bindings.get(t.id);return {who:b.label,phone:b.phone,role:b.role,visible:t.visible,area:t.area,floorM:t.floor,certainty:t.visible?t.certainty:'last seen',secondsSinceSeen:Math.round((now-t.lastSeenAt)/1000)};});
    const unassigned=[...this.tracks.values()].filter(t=>t.visible&&!this.bindings.has(t.id)).length;
    const recent=this.movement.filter(m=>this.bindings.has(m.track)&&now-m.at<120000).slice(-8).map(m=>({who:m.who,from:m.from,to:m.to,secondsAgo:Math.round((now-m.at)/1000)}));
    return {people,unassignedPeopleVisible:unassigned,recentMovement:recent};
  }
}
module.exports={fitHomography,apply,invert,calibrate,areaFor,Tracking,solve};
