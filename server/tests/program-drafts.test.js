const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generateProgram,validateRequest}=require('../program-drafts');
const request={brief:'Two people move from uncertainty into trust, then meet.',roles:2,minutes:8};
const cue=(id,type='speak',extras={})=>({id,type,text:'Walk slowly towards the wall.',delivery:'Quietly.',adapt:true,seconds:0,turns:2,role:'',cue:'',...extras});
function result(){return {title:'A distance between us',description:'An arc from separation to recognition.',roles:[{id:'role_1',name:'Observer',brief:'Notice small gestures.'},{id:'role_2',name:'Listener',brief:'Attend to the room.'}],scenes:[{id:'arrival',name:'Arrival',together:true,tracks:[{role:'role_1',cues:[cue('a1'),cue('a2','pause',{text:'',seconds:8})]},{role:'role_2',cues:[cue('b1')]}]}]};}
function fake(contents) {
  const calls=[];
  return { calls, fetchImpl:async(url,options)=>{
    calls.push({url,...options,body:JSON.parse(options.body)});
    const value=contents.shift();
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}]})};
  }};
}

test('writing uses a separate structured output budget and returns an unsaved validated program',async()=>{
 const f=fake([result()]);const generated=await generateProgram(request,{key:'test-key',model:'test-model',brief:'Private director context',fetchImpl:f.fetchImpl});
 assert.equal(f.calls.length,1);const sent=f.calls[0].body;assert.equal(sent.max_completion_tokens,14000);assert.equal(sent.response_format.json_schema.strict,true);assert.equal(sent.model,'test-model');assert.equal(sent.messages.at(-1).content,request.brief);assert.match(sent.messages[0].content,/Private director context/);
 assert.equal(generated.program.scenes[0].tracks.role_1[1].seconds,8);assert.equal(generated.program.id,undefined);assert.equal(generated.program.revision,undefined);assert.equal(generated.request.brief,request.brief);
});
test('generation repairs an invalid dependency rather than returning an unplayable draft',async()=>{
 const bad=result();bad.scenes[0].tracks[0].cues=[cue('a1','await',{role:'role_2',cue:'missing'})];const f=fake([bad,result()]);const generated=await generateProgram(request,{key:'test-key',fetchImpl:f.fetchImpl});assert.equal(f.calls.length,2);assert.match(f.calls[1].body.messages.at(-1).content,/does not exist/);assert.equal(generated.program.roles.length,2);
});
test('missing role tracks and persistent invalid output fail without creating a program',async()=>{
 const bad=result();bad.scenes[0].tracks.pop();const f=fake([bad,bad]);await assert.rejects(generateProgram(request,{key:'test-key',fetchImpl:f.fetchImpl}),/valid role score/);assert.equal(f.calls.length,2);
});
test('invalid requests and a missing API key make no network calls',async()=>{
 let calls=0;const options={key:'',fetchImpl:()=>calls++};await assert.rejects(generateProgram(request,options),/API key/);assert.throws(()=>validateRequest({...request,roles:0}),/roles/);assert.throws(()=>validateRequest({...request,brief:' '}),/Describe/);assert.throws(()=>validateRequest({...request,minutes:500}),/duration/);assert.equal(calls,0);
});
test('refusals, truncated output and unavailable service are explicit failures',async()=>{
 for(const [response,pattern] of [[{ok:false,status:429},/limit/],[{ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})},/writing limit/],[{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{refusal:'Cannot comply'}}]})},/Adjust the brief/]])await assert.rejects(generateProgram(request,{key:'test-key',fetchImpl:async()=>response}),pattern);
});
test('cancelling generation reaches the API request',async()=>{
 const controller=new AbortController();const promise=generateProgram(request,{key:'test-key',signal:controller.signal,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});controller.abort();await assert.rejects(promise,{name:'AbortError'});
});

test('a role inactive in one scene gets an empty track without losing its other scenes',async()=>{
 const raw=result();raw.scenes.push({id:'pair',name:'Observer alone',together:false,tracks:[{role:'role_1',cues:[cue('a3')]}]});const f=fake([raw]);const generated=await generateProgram(request,{key:'test-key',fetchImpl:f.fetchImpl});assert.deepEqual(generated.program.scenes[1].tracks.role_2,[]);const tracksSchema=f.calls[0].body.response_format.json_schema.schema.properties.scenes.items.properties.tracks;assert.deepEqual(tracksSchema.required,['role_1','role_2']);assert.equal(f.calls.length,1);
});

test('structured cue types keep desk holds separate from dependencies on other roles',async()=>{
 const f=fake([result()]);await generateProgram(request,{key:'test-key',fetchImpl:f.fetchImpl});
 const tracks=f.calls[0].body.response_format.json_schema.schema.properties.scenes.items.properties.tracks;
 const [regular,dependency]=tracks.properties.role_1.items.anyOf;
 assert.equal(regular.properties.type.enum.includes('wait'),true);
 assert.equal(regular.properties.type.enum.includes('await'),false);
 assert.deepEqual(regular.properties.role.enum,['']);
 assert.deepEqual(dependency.properties.type.enum,['await']);
 assert.deepEqual(dependency.properties.role.enum,['role_2']);
});
