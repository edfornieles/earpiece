const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Identity}=require('../identity');
const {Tracking}=require('../tracking');
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mother-id-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const people=[{pid:'p450031',number:1,name:'Ed Fornieles',face:true,photo:'participants/p450031/photo.jpg'},{pid:'p999999',number:2,name:'No Consent',face:false,photo:'x'}];
 const registry={list:people,get:pid=>people.find(p=>p.pid===pid)};
 const tracking=new Tracking();let now=Date.now();
 tracking.update({tracker:'desk',cameraId:'cam2',tracks:[{id:'T1',box:{x:.6,y:.3,w:.2,h:.6},feetVisible:true},{id:'T2',box:{x:.1,y:.3,w:.2,h:.6},feetVisible:true}]},{calibration:null,plan:null,now});
 const id=new Identity({root,registry,cameras:[],tracking});   // no face models in a temp folder: worker not started
 assert.equal(id.ready,false);id.enrolled.set('p450031',true);id.sent=[];id.send=o=>id.sent.push(o);
 return {id,tracking,root};
}
const face=(pid,score,x=0.7,y=0.35,emb=[1,0,0])=>({box:[x*960-15,y*540-15,30,30],pid,score,emb});
test('a recognised face names the track that contains it, after two matches',t=>{
 const {id,tracking}=setup(t);
 id.assign([face('p450031',0.55)],960,540);assert.equal(tracking.bindings.get('T1'),undefined,'one match is not enough');
 id.assign([face('p450031',0.57)],960,540);
 const b=tracking.bindings.get('T1');assert.equal(b.label,'Ed Fornieles #1');assert.equal(b.by,'face');assert.equal(b.person.pid,'p450031');
 assert.equal(tracking.bindings.get('T2'),undefined);
 // A face below the head area of a box, or outside every box, names nobody.
 id.assign([face('p450031',0.6,0.7,0.85),face('p450031',0.6,0.45,0.35)],960,540);assert.equal(tracking.view().tracks.find(x=>x.id==='T1').binding.label,'Ed Fornieles #1');
});
test('the desk can name a track from registered people; a face match never overrides it, and its views are learned',t=>{
 const {id,tracking,root}=setup(t);
 id.name('T2','p450031');
 assert.equal(tracking.bindings.get('T2').by,'desk');assert.throws(()=>id.name('T2','nobody'),/registered person/);
 id.assign([face('p450031',0.3,0.2,0.35,[0,1,0])],960,540);   // weak match, but the desk said who this is
 const saved=JSON.parse(fs.readFileSync(path.join(root,'participants/p450031/face-templates.json'),'utf8'));
 assert.equal(saved.length,1);assert.deepEqual(id.sent.at(-1),{op:'learn',pid:'p450031',emb:[0,1,0]});
 id.assign([face('p450031',0.3,0.2,0.35,[0,1,0])],960,540);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'participants/p450031/face-templates.json'),'utf8')).length,1,'a view like one already saved is not saved again');
 tracking.identify('T2',{pid:'pother',name:'Someone',number:9,by:'face'});assert.equal(tracking.bindings.get('T2').person.pid,'p450031');
});
test('people without face consent are never enrolled, and status lists who is enrolled',t=>{
 const {id}=setup(t);id.ready=true;id.proc={};id.sync();
 assert.ok(!id.sent.some(o=>o.pid==='p999999'));
 const s=id.status();assert.deepEqual(s.registered.map(p=>[p.name,p.face,p.enrolled]),[['Ed Fornieles',true,true],['No Consent',false,false]]);
});
