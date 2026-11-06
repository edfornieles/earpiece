const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function desk(){
 const html=fs.readFileSync(path.join(__dirname,'../public/control.html'),'utf8');
 const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
 const elements=new Map(),sockets=[];
 const classList={add(){},remove(){},toggle(){},contains:()=>false};
 const element=id=>{if(!elements.has(id))elements.set(id,{style:{},classList,value:'',children:[],dataset:{},addEventListener(){},querySelectorAll:()=>[],querySelector:()=>null,setAttribute(){},appendChild(){}});return elements.get(id);};
 const sandbox={document:{getElementById:element,querySelectorAll:()=>[],addEventListener(){},body:{classList}},window:{addEventListener(){}},location:{search:'?k=test',protocol:'http:',host:'localhost'},URLSearchParams,requestAnimationFrame(){},setInterval(){},clearTimeout(){},setTimeout(){},fetch:()=>new Promise(()=>{}),
 WebSocket:class{constructor(){this.readyState=1;this.sent=[];sockets.push(this);}send(v){this.sent.push(v);}},
 AudioContext:class{constructor(){this.state='running';this.destination={};this.audioWorklet={addModule:async()=>{}};}async resume(){}createGain(){return{gain:{},connect(){}};}},
 makePlayer:()=>({push(){},flush(){},level:()=>0}),openMic:async()=>{throw Error('Permission denied');},rms:()=>0};
 vm.createContext(sandbox);vm.runInContext(script,sandbox);
 return{html,sockets,element,run:code=>vm.runInContext(code,sandbox)};
}
test('desk connects without a gate or microphone permission and accepts phone state',()=>{
 const d=desk();assert.equal(d.sockets.length,1);assert.equal(d.html.includes('id="gate"'),false);
 d.sockets[0].onmessage({data:JSON.stringify({type:'state',id:1,waiting:true})});
 assert.equal(d.run('people.get(1).waiting'),true);assert.equal(d.run('people.get(1).player'),null);
 d.run('setTalk(1)');assert.equal(d.sockets[0].sent.length,0);
});
test('microphone denial leaves monitoring and control usable',async()=>{
 const d=desk();await d.element('enable-sound').onclick();assert.equal(d.run('audioReady'),true);
 await d.element('enable-mic').onclick();assert.match(d.element('audio-label').textContent,/Microphone unavailable/);
 assert.equal(d.run('mic'),undefined);assert.equal(d.sockets[0].readyState,1);assert.equal(d.run('audioReady'),true);
 d.sockets[0].onmessage({data:JSON.stringify({type:'state',id:2,waiting:true})});assert.ok(d.run('people.get(2).player'));
});
