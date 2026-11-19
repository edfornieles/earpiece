const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const d = require('../debrief');

function session(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mother-debrief-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '2026-11-20-10-00-00'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ title: 'Opening night', start_iso: '2026-11-20T10:00:00.000Z', program: { snapshot: { title: 'Step Piece', description: 'Steps.' } },
    participants: [{ phone: 1, pid: 'pa', name: 'Ana', start: 5 }, { phone: 2, pid: 'pb', name: 'Bo', start: 5 }] }));
  fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify([
    { pid: 'pa', name: 'Ana', notes: 'nervous at first', visits: [{ phone: 1, start: 5, end: 300 }] },
    { pid: 'pb', name: 'Bo', visits: [{ phone: 2, start: 5, end: 300 }] },
    { pid: 'pc', name: 'Never started', visits: [] }]));
  fs.writeFileSync(path.join(dir, 'transcript.txt'), [
    '[6.0] #1 AI: Hello Ana, step onto the stool.', '[9.5] #1 PHONE 1: I do not want to.', '[10.0] #2 AI: Hello Bo.',
    '[20.0] #1 TYPED: it is safe, take your time', '[400.0] #1 AI: after the visit, not hers'].join('\n'));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [
    { t: '12.0', type: 'mark', text: 'Ana refuses' }, { t: '13.0', type: 'ai_cut', id: 2 }, { t: '14.0', type: 'talk_start', target: 1, id: 1 }, { t: '500', type: 'mark', text: 'later' }]
    .map((e) => JSON.stringify(e)).join('\n'));
  return { root, dir };
}

test('finds past visits newest first, skipping people who never started', (t) => {
  const { root } = session(t);
  const v = d.recentVisits(root);
  assert.deepEqual(v.map((x) => x.name), ['Ana', 'Bo']);
  assert.equal(v[0].program, 'Step Piece'); assert.equal(v[0].minutes, 4.9);
});

test("reads back only that person's visit: their phone, their time, labelled by who spoke", (t) => {
  const { dir } = session(t);
  const r = d.visitRecord(dir, 'pa');
  assert.deepEqual(r.lines.map((l) => l.who), ['Mother', 'Ana', "Director (typed, spoken in Mother's voice)"]);
  assert.deepEqual(r.moments.map((m) => m.what), ['Marked on the desk: Ana refuses', 'The director spoke to them live']);
  assert.match(d.visitText(r), /Ana: I do not want to\./);
  assert.match(d.visitText(r), /nervous at first/);
  assert.throws(() => d.visitRecord(dir, 'nobody'), /not in this session/);
});

test('the briefing is written from the record by the text model; with no transcript it says so', async (t) => {
  const { dir } = session(t);
  let sent = null;
  const fetchImpl = async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'Ana refused the stool at first.' } }] }) }; };
  assert.equal(await d.writeDossier(d.visitRecord(dir, 'pa'), { key: 'k', fetchImpl }), 'Ana refused the stool at first.');
  assert.match(sent.messages[1].content, /I do not want to/);
  assert.match(await d.writeDossier({ name: 'Zed', lines: [], moments: [] }, { key: 'k', fetchImpl }), /No transcript/);
});

test('the interviewer is not Mother, asks one question at a time, and carries the guide and briefing', () => {
  const p = d.interviewerPrompt({ name: 'Ana', guide: 'Ask about the stool.', dossier: 'Ana refused the stool at first.', minutes: 5 });
  assert.match(p, /NOT Mother/); assert.match(p, /exactly ONE question/);
  assert.match(p, /Ask about the stool\./); assert.match(p, /Ana refused the stool at first\./);
  assert.match(d.interviewerPrompt(), /No briefing is available/);
});
