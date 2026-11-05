const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('analysed-frame overlays use SVG attributes and are hidden on the live video',()=>{
 const elements=new Map();
 function el(id){if(!elements.has(id)){const attrs=new Set(id==='overlay'?['hidden']:[]);elements.set(id,{value:id==='camera'?'cam1':'',style:{},dataset:{},classList:{add(){},remove(){}},children:[],innerHTML:'',querySelectorAll:()=>[],getAttribute:()=>null,setAttribute(){},toggleAttribute(name,on){if(on)attrs.add(name);else attrs.delete(name);},hasAttribute:name=>attrs.has(name),addEventListener(){}});}return elements.get(id);}
 const sandbox={Setup:{$:el,esc:String,url:v=>v,toast(){},api:()=>new Promise(()=>{})},window:{addEventListener(){}},document:{getElementById:el},setInterval(){},Date};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/room.js'),'utf8'),sandbox);
 const state={name:'Studio',notes:'',landmarks:[{id:'chair',name:'Chair',cameraId:'cam1',box:{x:.3,y:.4,w:.2,h:.2}}],cameras:[{id:'cam1',name:'Camera',live:true}],latest:{id:'frame',cameraId:'cam1',cameraName:'Camera',capturedAt:Date.now(),analysedAt:Date.now(),summary:'A chair',answer:'',changes:[],uncertainties:[],objects:[{id:'object_1',landmarkId:'chair',name:'Chair',box:{x:.1,y:.1,w:.4,h:.4}}],people:[]},history:[],bindings:[]};
 vm.runInContext('room='+JSON.stringify(state)+';view="analysed";render()',sandbox);assert.equal(el('overlay').hasAttribute('hidden'),false);assert.match(el('overlay').innerHTML,/class="landmark" x="300" y="400"/);assert.equal(el('live-picture').hidden,true);assert.equal(el('analysed-picture').hidden,false);
 vm.runInContext('view="live";render()',sandbox);assert.equal(el('overlay').hasAttribute('hidden'),true);assert.equal(el('live-picture').hidden,false);
});
