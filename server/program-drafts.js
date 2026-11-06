// Program writing uses its own structured-output request; live direction stays short.
// API format: https://developers.openai.com/api/docs/guides/structured-outputs
const { validateProgram } = require('./programs');
const string = { type:'string' }, number = { type:'number' }, boolean = { type:'boolean' };
const object = properties => ({ type:'object', properties, required:Object.keys(properties), additionalProperties:false });
const array = items => ({ type:'array', items });
const cueSchema = object({
  id:string, type:{type:'string',enum:['speak','pause','wait','reply','conversation','await']},
  text:string, delivery:string, adapt:boolean, seconds:number, turns:number, role:string, cue:string
});
function schemaFor(count) {
  const ids=Array.from({length:count},(_,i)=>`role_${i+1}`);
  const cueFor=id=>{
    const regular=object({...cueSchema.properties,type:{type:'string',enum:['speak','pause','wait','reply','conversation']},role:{type:'string',enum:['']},cue:{type:'string',enum:['']}});
    const others=ids.filter(other=>other!==id);
    if(!others.length)return regular;
    const dependency=object({...cueSchema.properties,type:{type:'string',enum:['await']},role:{type:'string',enum:others}});
    return {anyOf:[regular,dependency]};
  };
  return object({
    title:string,description:string,
    roles:{...array(object({id:{type:'string',enum:ids},name:string,brief:string})),minItems:count,maxItems:count},
    scenes:array(object({id:string,name:string,together:boolean,tracks:object(Object.fromEntries(ids.map(id=>[id,array(cueFor(id))])))}))
  });
}

function validateRequest(input) {
  if(typeof input?.brief!=='string' || !input.brief.trim())throw Error('Describe what you want the performance to achieve.');
  if(input.brief.length>12000)throw Error('Keep the description under 12,000 characters.');
  const roles=Number(input.roles), minutes=Number(input.minutes);
  if(!Number.isInteger(roles)||roles<1||roles>16)throw Error('Choose between 1 and 16 roles for the first draft.');
  if(!Number.isFinite(minutes)||minutes<1||minutes>120)throw Error('Choose an approximate duration between 1 and 120 minutes.');
  return {brief:input.brief.trim(),roles,minutes};
}
function normalizeDraft(raw,request) {
  if(!raw || raw.roles?.length!==request.roles)throw Error(`Write exactly ${request.roles} roles.`);
  const ids=Array.from({length:request.roles},(_,i)=>`role_${i+1}`);
  if(new Set(raw.roles.map(r=>r.id)).size!==request.roles || raw.roles.some(r=>!ids.includes(r.id)))throw Error('Use each required role identifier exactly once.');
  const roles=ids.map(id=>raw.roles.find(r=>r.id===id));
  if(!Array.isArray(raw.scenes)||!raw.scenes.length)throw Error('Include at least one scene.');
  const scenes=raw.scenes.map(scene=>{
    const entries=Array.isArray(scene.tracks)?scene.tracks:Object.entries(scene.tracks || {}).map(([role,cues])=>({role,cues}));
    const tracks=Object.create(null);
    for(const track of entries){
      if(!ids.includes(track.role)||Object.hasOwn(tracks,track.role))throw Error('Use each role at most once per scene.');
      if(!Array.isArray(track.cues))throw Error('Every role track must contain a cue list.');
      tracks[track.role]=track.cues;
    }
    // A role can be intentionally inactive in a scene; preserve that as an empty track.
    for(const id of ids)tracks[id] ||= [];
    return {...scene,tracks};
  });
  const program=validateProgram({...raw,roles,scenes});
  for(const role of program.roles)if(!program.scenes.some(scene=>scene.tracks[role.id].some(c=>['speak','reply','conversation'].includes(c.type))))throw Error(`Give ${role.name} at least one spoken passage.`);
  return program;
}
function messagesFor(request,brief) {
  return [
    {role:'system',content:`You write first drafts of Mother, an intimate gallery performance heard through individual earpieces. Return a complete editable score in the required JSON schema, never an outline or commentary. Give the work a specific, evocative title rather than the platform name. Every spoken cue is Mother addressing the wearer through their earpiece, usually as you. Roles describe the people receiving direction, not separate voices in a radio play. Write concrete directions for movement and action. If a participant should speak dialogue aloud, explicitly tell them what to say; if they should think a particular thought, frame it as an instruction to think. A reply or conversation opening must genuinely invite the wearer to answer. A wait cue must contain a clear private instruction telling the desk what readiness or action to confirm. Phones remain at the control desk; participants have only an earpiece and microphone. Each role hears only its own track. Do not instruct participants to operate phones.
Write exactly ${request.roles} named roles, with identifiers role_1 through role_${request.roles}, in that order. Give each a distinct dramatic function and private brief. Produce a manageable first draft of 2–4 scenes with a beginning, development and ending, aiming for approximately ${request.minutes} minutes. Use concise spoken passages and deliberate silences, not endless text. Duration is approximate because replies and desk holds vary. Every scene tracks object must include a property for every role identifier, containing that role’s cue array; an inactive role has an empty array. Use simple unique scene IDs and unique cue IDs within each track.
Cue types: speak (spoken text); pause (exact seconds, 0–600); wait (private desk instruction awaiting controller confirmation); reply (speak a question then await one participant reply); conversation (opening words then 1–6 exchanges constrained by delivery); await (wait for another role's cue ID or the end of their current scene if cue is empty). All fields must be present. Unused text/delivery/role/cue fields are empty strings; unused seconds is 0 and turns is 2. Set adapt true where rephrasing fits, false for important exact lines. Delivery contains private pacing and adaptation boundaries, never text to read aloud. Represent exact hesitation between passages with pause cues.
Mix independent and interacting roles as the user's description calls for. Set together true at shared scene boundaries, false for passages that can overlap. For desk confirmation use wait, NEVER await. An await cue must name a DIFFERENT role identifier and a valid cue in the SAME scene (or an empty cue for that other role’s scene end). Never await your own cue. Dependencies must exist and be acyclic. Do not infer physical readiness from elapsed time or speech playback: use a wait cue for the desk, or ask for a reply, then let other roles await that completed cue. Avoid dependencies unless they serve the scene. Participants may converse with Mother and the human director can interrupt; include bounded conversation moments and clear places to return to the score. Never forward a participant's microphone to another earpiece; characters can speak aloud in the gallery.
Follow the creative description closely, including emotional effect, movement, pacing, hesitations and constraints. Do not invent facts about the gallery layout or artworks; use adaptable landmarks unless supplied. Preserve consent and a participant's ability to stop. No unsafe actions, touching artworks or pressuring uninvolved visitors. Program description should explain the dramatic arc, shared coordination and what may adapt. Existing direction brief is background context, not a limit on the total script length:\n${brief.slice(0,16000)}`},
    {role:'user',content:request.brief}
  ];
}
async function generateProgram(input,{key=process.env.OPENAI_API_KEY,model=process.env.OPENAI_PROGRAM_MODEL||process.env.OPENAI_TEXT_MODEL||'gpt-4o-mini',fetchImpl=fetch,signal,brief=''}={}) {
  const request=validateRequest(input);
  if(!key)throw Error('The server needs its OpenAI API key before Mother can write a draft.');
  const messages=messagesFor(request,brief);
  const timeout=AbortSignal.timeout(180000), combined=signal?AbortSignal.any([signal,timeout]):timeout;
  for(let attempt=0;attempt<2;attempt++) {
    const response=await fetchImpl('https://api.openai.com/v1/chat/completions',{
      method:'POST',signal:combined,headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},
      body:JSON.stringify({model,messages,max_completion_tokens:14000,response_format:{type:'json_schema',json_schema:{name:'mother_program_draft',strict:true,schema:schemaFor(request.roles)}}})
    });
    if(!response.ok){
      if(response.status===401)throw Error('The server’s OpenAI API key was not accepted.');
      if(response.status===429)throw Error('OpenAI is busy or the account limit was reached. Try again shortly.');
      throw Error(`Mother could not generate a draft (OpenAI ${response.status}). Check the configured program model and try again.`);
    }
    const choice=(await response.json()).choices?.[0];
    if(choice?.message?.refusal)throw Error('Mother could not write that description. Adjust the brief and try again.');
    if(choice?.finish_reason==='length')throw Error('The draft exceeded its writing limit. Try fewer roles or a more focused description.');
    if(!choice?.message?.content || choice.finish_reason!=='stop')throw Error('Mother did not finish the draft. Try again.');
    const raw=choice.message.content;
    try {return {program:normalizeDraft(JSON.parse(raw),request),request,model};}
    catch(error){
      if(attempt===1)throw Error('Mother could not produce a valid role score. Your description is still here; try again.');
      messages.push({role:'assistant',content:raw},{role:'user',content:`Repair the complete JSON draft. Validation failed: ${error.message}. Keep the creative content and required role count. Return the full corrected score.`});
    }
  }
}
module.exports={generateProgram,validateRequest,normalizeDraft};
