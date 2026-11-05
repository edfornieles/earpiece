const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const sample=()=>({title:'Generated score',description:'Two strangers learn to notice each other.',roles:[{id:'role_1',name:'Observer',brief:''}],scenes:[{id:'one',name:'Arrival',together:true,tracks:{role_1:[{id:'c1',type:'speak',text:'Look around.'}]}}]});
function page(){
 const elements=new Map(),calls=[],cached=new Map();let answer,confirmation=true;
 function el(id){if(!elements.has(id))elements.set(id,{value:id==='draft-roles'?'1':id==='draft-minutes'?'10':'',style:{},dataset:{},hidden:false,children:[],querySelectorAll:()=>[],addEventListener(){},focus(){}});return elements.get(id);}
 const context={Setup:{$:el,esc:String,url:x=>x,toast(){},api:async(route,body,options)=>{calls.push(route);if(route==='programs')return{programs:[]};return answer(body,options);}},crypto:{randomUUID:()=> 'sample-uuid'},structuredClone,AbortController,sessionStorage:{getItem:k=>cached.get(k),setItem:(k,v)=>cached.set(k,v)},window:{addEventListener(){}},confirm:()=>confirmation};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/program-editor.js'),'utf8'),context);
 return{el,calls,run:s=>vm.runInContext(s,context),answer:fn=>answer=fn,confirm:v=>confirmation=v};
}
test('generation opens an editable unsaved draft without changing a session or saving a program',async()=>{
 const p=page();p.el('draft-brief').value='Start separately, then slowly come together.';p.answer(async()=>({program:sample()}));await p.el('generate-draft').onclick();assert.equal(p.run('draft.title'),'Generated score');assert.equal(p.run('draft.id'),undefined);assert.equal(p.run('dirty'),true);assert.equal(p.el('choose').hidden,true);assert.deepEqual(p.calls,['programs','program-draft']);
});
test('a generated result waits for explicit opening when an editor draft already exists',async()=>{
 const p=page();p.run('draft={title:"My ongoing edits"};dirty=true;');p.el('draft-brief').value='An alternative performance';p.answer(async()=>({program:sample()}));await p.el('generate-draft').onclick();assert.equal(p.run('draft.title'),'My ongoing edits');assert.equal(p.el('open-generated').hidden,false);p.confirm(false);p.el('open-generated').onclick();assert.equal(p.run('draft.title'),'My ongoing edits');p.confirm(true);p.el('open-generated').onclick();assert.equal(p.run('draft.title'),'Generated score');assert.equal(p.run('dirty'),true);
});
test('failed and cancelled writing preserve both the prompt and existing edits',async()=>{
 const p=page();p.run('draft={title:"Keep this"};dirty=true;');p.el('draft-brief').value='My description';p.answer(async()=>{throw Error('Service unavailable');});await p.el('generate-draft').onclick();assert.match(p.el('generation-state').textContent,/Service unavailable/);assert.equal(p.el('draft-brief').value,'My description');assert.equal(p.run('draft.title'),'Keep this');
 p.answer((body,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));const writing=p.el('generate-draft').onclick();p.el('cancel-draft').onclick();await writing;assert.match(p.el('generation-state').textContent,/cancelled/);assert.equal(p.run('draft.title'),'Keep this');assert.equal(p.el('generate-draft').disabled,false);
});
