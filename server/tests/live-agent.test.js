const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveAgent } = require('../live-agent');

function setup(t, see = async () => ({ images: [], note: 'Room state' })) {
  const sent = [], audio = [], failures = [];
  const agent = new LiveAgent({hooks:{
    see, audio:pcm=>audio.push(pcm), fallback:reason=>failures.push(reason),
    log(){}, responseDone(){}, speechStarted(){}, playedMs(){return 0;}
  }});
  agent.ws = {readyState:1,send:body=>sent.push(JSON.parse(body)),close(){}};
  agent.ready = true;
  t.after(()=>agent.close());
  return {agent,sent,audio,failures};
}

test('Realtime waits for committed speech and forwards output PCM',async t=>{
  const {agent,sent,audio,failures}=setup(t);
  agent.onEvent({type:'input_audio_buffer.speech_started'});
  agent.onEvent({type:'input_audio_buffer.speech_stopped'});
  assert.equal(sent.length,0);
  agent.onEvent({type:'input_audio_buffer.committed'});
  await new Promise(setImmediate);
  assert.equal(sent.at(-1).type,'response.create');
  agent.onEvent({type:'response.output_audio.delta',delta:'AQACAA=='});
  agent.onEvent({type:'response.done',response:{status:'completed'}});
  assert.deepEqual(audio,[Buffer.from([1,0,2,0])]);
  assert.deepEqual(failures,[]);
});

test('a silent Realtime response hands off to the standard voice only once',async t=>{
  const {agent,failures}=setup(t);
  await agent.respond('start');
  agent.onEvent({type:'response.done',response:{status:'completed'}});
  agent.onEvent({type:'error',error:{message:'later error'}});
  assert.deepEqual(failures,['Realtime reply contained no audio.']);
  assert.equal(agent.closed,true);
});

test('interruption while capturing vision prevents a late spoken reply',async t=>{
  let finish;
  const {agent,sent}=setup(t,()=>new Promise(resolve=>{finish=resolve;}));
  const pending=agent.respond('start');
  agent.onEvent({type:'input_audio_buffer.speech_started'});
  finish({images:[],note:'Old frame'});
  await pending;
  assert.equal(sent.some(event=>event.type==='response.create'),false);
});

test('Realtime receives the camera name alongside each view', async t => {
  const { agent, sent } = setup(t, async () => ({
    images: [
      { label: 'Mac camera', jpeg: Buffer.from([1]) },
      { label: 'mother_eye_1', jpeg: Buffer.from([2]) },
    ],
  }));
  await agent.respond('start');
  const views = sent.filter(event => event.item?.content.some(part => part.type === 'input_image'));
  assert.deepEqual(views.map(event => event.item.content[0].text), [
    'Camera view: Mac camera',
    'Camera view: mother_eye_1',
  ]);
});

test('a desk line typed while Mother is talking cuts in, then is spoken', async t => {
  const { agent, sent } = setup(t);
  agent.request();
  agent.onEvent({ type: 'response.created' });
  agent.say('Stop and look at the door.');
  assert.ok(sent.some(m => m.type === 'response.cancel'), 'current answer cancelled');
  agent.onEvent({ type: 'response.done', response: { status: 'cancelled' } });
  const last = sent.at(-1);
  assert.equal(last.type, 'response.create');
  assert.match(last.response.instructions, /Stop and look at the door/);
});

test('a dropped or expired session reconnects quietly instead of falling back', async t => {
  const { agent, failures } = setup(t);
  let opened = 0; agent.open = () => { opened++; };
  agent.wasReady = true;
  agent.fail('Realtime voice disconnected (1006).', true);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(opened, 1); assert.equal(failures.length, 0); assert.equal(agent.ready, false);
  agent.reconnects = 3;
  agent.fail('Realtime voice disconnected (1006).', true);
  assert.equal(failures.length, 1, 'after three tries it hands back to the standard voice');
});

test('the map goes in as a captioned PNG, and a changed room replaces the instructions',async t=>{
  const {agent,sent}=setup(t,async()=>({images:[{jpeg:Buffer.from('a'),label:'cam2'},{data:Buffer.from('b'),mime:'image/png',caption:'Map of the room from above.'}],note:''}));
  agent.onEvent({type:'input_audio_buffer.committed'});
  await new Promise(setImmediate);
  const items=sent.filter(m=>m.type==='conversation.item.create').map(m=>m.item.content);
  assert.equal(items[0][0].text,'Camera view: cam2');assert.match(items[0][1].image_url,/^data:image\/jpeg;base64,/);
  assert.equal(items[1][0].text,'Map of the room from above.');assert.match(items[1][1].image_url,/^data:image\/png;base64,/);
  agent.setInstructions('new room');
  assert.deepEqual(sent.at(-1),{type:'session.update',session:{type:'realtime',instructions:'new room'}});
});
