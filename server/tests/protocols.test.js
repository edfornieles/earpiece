const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ProtocolStore, motherPrompt, VOICES } = require('../protocols');
const d = require('../debrief');

const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mother-protocols-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('protocols are saved tidily, kept across a restart, and protected from overwriting a newer save', (t) => {
  const file = path.join(tmp(t), 'protocols.json'), store = new ProtocolStore(file);
  assert.throws(() => store.save({ title: '  ' }), /title/);
  const p = store.save({ title: 'The Stool', description: 'Step up.', people: { min: '4', max: '2' }, tags: 'Pairs, touch, pairs', voices: { 'warm-selfish': 'Mother wants to be thanked.', bogus: 'x' }, more: { care: 'Stop if dizzy.', minutes: '12', junk: 'x' } });
  assert.deepEqual(p.people, { min: 2, max: 4 }, 'min and max put the right way round');
  assert.deepEqual(p.tags, ['pairs', 'touch']); assert.deepEqual(Object.keys(p.voices), ['warm-selfish']); assert.deepEqual(p.more, { care: 'Stop if dizzy.', minutes: 12 });
  const p2 = store.save({ ...p, title: 'The Stool II' });
  assert.equal(p2.revision, 2); assert.equal(p2.id, p.id);
  assert.throws(() => store.save({ ...p, title: 'stale' }), /meanwhile/);
  assert.equal(new ProtocolStore(file).get(p.id).title, 'The Stool II');
  store.remove(p.id); assert.equal(store.list().length, 0);
});

test('four voices with starting definitions the team can rewrite and reset', (t) => {
  const store = new ProtocolStore(path.join(tmp(t), 'p.json'));
  assert.deepEqual(store.voices().map((v) => v.name), ['Warm / Selfless', 'Cold / Selfless', 'Warm / Selfish', 'Cold / Selfish']);
  store.setVoiceText('cold-selfish', 'Withholding. Wants obedience.');
  assert.equal(store.voice('cold-selfish').text, 'Withholding. Wants obedience.');
  store.setVoiceText('cold-selfish', ''); assert.equal(store.voice('cold-selfish').text, store.voice('cold-selfish').defaultText);
  assert.throws(() => store.setVoiceText('lukewarm', 'x'), /four voices/);
  assert.equal(VOICES.length, 4);
});

test("Mother is told the session's voice and the running action as it plays under that voice", () => {
  const voice = { id: 'warm-selfish', name: 'Warm / Selfish', text: 'Affectionate; wants to be needed.' };
  const action = { snapshot: { title: 'The Stool', description: 'Step up.', people: { min: 2, max: 4 }, voices: { 'warm-selfish': 'Coax them up for your own pride.', 'cold-selfless': 'not this one' }, more: { care: 'Stop if dizzy.', mother: 'Count down from five.' } } };
  const p = motherPrompt({ voice, action });
  assert.match(p, /CAREGIVER VOICE FOR THIS SESSION: Warm \/ Selfish/); assert.match(p, /wants to be needed/);
  assert.match(p, /CURRENT ACTION: The Stool/); assert.match(p, /Coax them up for your own pride/); assert.doesNotMatch(p, /not this one/);
  assert.match(p, /Stop if dizzy/); assert.match(p, /Count down from five/); assert.match(p, /2–4 people/);
  assert.equal(motherPrompt({}), '');
});

test('the debrief briefing knows the voice and the actions of the session it is about', (t) => {
  const dir = path.join(tmp(t), '2026-11-20-10-00-00'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ caregiver: { name: 'Cold / Selfless' }, actions: [{ snapshot: { title: 'The Stool', description: 'Step up.', more: { debrief: 'Did you want to get down?' } }, runs: [] }] }));
  fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify([{ pid: 'pa', name: 'Ana', visits: [{ phone: 1, start: 5, end: 300 }] }]));
  fs.writeFileSync(path.join(dir, 'transcript.txt'), '[6.0] #1 AI: Up you go.');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ t: '10', type: 'action_start', title: 'The Stool' }));
  const text = d.visitText(d.visitRecord(dir, 'pa'));
  assert.match(text, /Cold \/ Selfless/); assert.match(text, /Action deployed: The Stool/); assert.match(text, /Did you want to get down\?/); assert.match(text, /Action began: The Stool/);
});
