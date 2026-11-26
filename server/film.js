#!/usr/bin/env node
// Performance film: builds a draft edit of one session as text, ready to render and comment on.
// See docs/performance-film.md. Never changes the session's own files.
//
//   node film.js recordings/<session>            → edits/performance-film/v<next>/{score,cut,debrief}.json + notes.md
//   node film.js recordings/<session> --render   → … and renders preview.mp4 (film_render.py)
//   node film.js recordings/<session> --next     → v<next> starts as a copy of the latest draft, to be revised from
//                                                  the comments (then write changes.md and run --render-only)
//   node film.js recordings/<session> --render-only v2   → render that version's preview.mp4
//
// The three parts:
//   score.json    the opening screens: date, booth, participants, the instructions as performed (+ written score)
//   cut.json      the footage: clips on the session clock, each with camera, sound layers, captions and a reason
//   debrief.json  optional: debrief audio over the portraits' carousel, turning to whoever speaks
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const INSTRUCTION = new Set(['ai', 'typed', 'voiced', 'director']);   // what the participants were told
const GAP = 6;          // seconds of quiet that end a scene
const PAD = 1.5;        // seconds kept either side of a scene
const MIN_WORDS = 6;    // a scene with no instruction needs at least this much said by a participant

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const r2 = (n) => Math.round(n * 100) / 100;

function load(dir) {
  const session = readJson(path.join(dir, 'session.json'), {});
  const manifest = readJson(path.join(dir, 'catalogue', 'manifest.json'), null);
  if (!manifest) throw Error(`No catalogue for ${dir}: run  node catalogue.js ${dir}  first.`);
  return { session, manifest, people: readJson(path.join(dir, 'people.json'), []), utter: readLines(path.join(dir, 'catalogue', 'utterances.jsonl')), events: readLines(path.join(dir, 'events.jsonl')) };
}

// Participants in the order they started, labelled by name only where their release allows it.
function participants({ manifest, people }) {
  const list = (manifest.participants || []).slice().sort((a, b) => a.start - b.start);
  return list.map((p, i) => {
    const rec = people.find((x) => x.pid === p.pid) || {};
    const named = !!(rec.release && rec.name);
    return { pid: p.pid, phone: p.phone, label: named ? rec.name : `Participant ${i + 1}`, named, start: p.start, end: p.end,
      photo: rec.portrait || rec.photo || null, portrait: !!rec.portrait };
  });
}

function score(dir, d, folk) {
  const { session, utter, events } = d;
  const booth = [...new Set(events.filter((e) => e.type === 'desk_join' && e.who).map((e) => e.who === 'studio desk' ? 'Studio desk' : e.who))];
  const label = (phone) => folk.find((p) => p.phone === phone)?.label || `Phone ${phone}`;
  const instructions = utter.filter((u) => INSTRUCTION.has(u.who)).map((u) => ({
    t: r2(u.start), to: label(u.phone), how: u.who === 'ai' ? 'Mother' : u.who === 'voiced' ? 'director, in Mother\'s voice' : u.who === 'typed' ? 'director, typed' : 'director, live', text: u.text }));
  const written = events.find((e) => e.type === 'program_start') ? { note: 'Ran from a written Program: see programs/ for the score as written.' } : null;
  return { title: session.title || '', date: session.start_iso, end: session.end_iso, timezone: session.timezone, booth,
    participants: folk.map((p) => p.label), instructions, written,
    look: { style: 'plain white type on black, one instruction per line with its time, scrolling', secondsPerCard: 6 } };
}

// Which camera holds the action at time t: the one tracking saw people on, else take turns.
function cameraAt(t, d, cams, turn) {
  const near = d.events.filter((e) => e.type === 'room_activity' && Math.abs(Number(e.t) - t) < 8);
  const ids = [...new Set(near.map((e) => e.cameraId))];
  const byId = cams.find((c) => ids.includes(c.cam));
  if (byId) return { camera: byId.camera, why: 'tracking saw people on it' };
  const pool = cams.filter((c) => !/mac/i.test(c.camera));
  const c = (pool.length ? pool : cams)[turn % (pool.length || cams.length)];
  return { camera: c.camera, why: 'no tracking here; taking turns between cameras' };
}

function cut(dir, d, folk) {
  const cams = [...new Map(d.manifest.files.filter((f) => f.kind === 'camera').map((f) => [f.camera, { camera: f.camera, cam: f.cam }])).values()];
  const label = (phone) => folk.find((p) => p.phone === phone)?.label || `Phone ${phone}`;
  const u = d.utter.slice().sort((a, b) => a.start - b.start);
  // scenes: runs of speech with less than GAP seconds of quiet between them
  const scenes = [];
  for (const x of u) {
    const last = scenes[scenes.length - 1];
    if (last && x.start - last.end < GAP) { last.items.push(x); last.end = Math.max(last.end, x.end); }
    else scenes.push({ start: x.start, end: x.end, items: [x] });
  }
  const kept = scenes.filter((s) => s.items.some((x) => INSTRUCTION.has(x.who)) || s.items.filter((x) => x.who === 'participant').reduce((n, x) => n + words(x.text), 0) >= MIN_WORDS);
  const clips = kept.map((s, i) => {
    const phones = [...new Set(s.items.map((x) => x.phone).filter(Boolean))];
    const first = s.items.find((x) => INSTRUCTION.has(x.who));
    const cam = cameraAt((s.start + s.end) / 2, d, cams, i);
    return {
      n: i + 1, in: r2(Math.max(0, s.start - PAD)), out: r2(s.end + PAD), camera: cam.camera,
      sound: { earpiece: phones, participant: phones, room: 0.35 },
      // the same line sent to several phones at once is one caption, not a stack of repeats
      captions: s.items.map((x) => ({ start: r2(x.start), end: r2(x.end), layer: x.who === 'participant' ? 'participant' : 'earpiece',
        speaker: x.who === 'participant' ? label(x.phone) : (x.who === 'ai' ? 'Mother' : 'Director'), text: x.text }))
        .filter((c, i, all) => c.layer === 'participant' || !all.slice(0, i).some((p) => p.layer === 'earpiece' && p.text === c.text && Math.abs(p.start - c.start) < 1.5)),
      reason: first ? `${first.who === 'ai' ? 'Mother' : 'The director'} to ${label(first.phone)}: “${String(first.text).slice(0, 70)}${first.text.length > 70 ? '…' : ''}”`
        : `${label(phones[0])} talks (${s.items.length} lines)`,
      cameraWhy: cam.why,
    };
  });
  return { clips, length: r2(clips.reduce((n, c) => n + c.out - c.in, 0)), session_length: r2(d.manifest.end ? (Date.parse(d.manifest.end) - Date.parse(d.manifest.start)) / 1000 : 0),
    rules: { gap: GAP, pad: PAD, minWords: MIN_WORDS } };
}

// Debriefs recorded about this session, found in other sessions' people.json (visit.debriefOf.session).
function debrief(dir, folk) {
  const name = path.basename(dir), recs = path.dirname(dir), found = [];
  for (const s of fs.readdirSync(recs)) {
    const people = readJson(path.join(recs, s, 'people.json'), []);
    for (const p of people) for (const v of p.visits || []) if (v.debriefOf?.session === name) {
      const utter = readLines(path.join(recs, s, 'catalogue', 'utterances.jsonl')).filter((x) => x.phone === v.phone && x.start >= v.start - 1 && x.start <= (v.end ?? Infinity));
      found.push({ pid: v.debriefOf.pid || p.pid, session: s, phone: v.phone, start: v.start, end: v.end,
        turns: utter.map((x) => ({ start: r2(x.start), end: r2(x.end), who: x.who === 'participant' ? 'participant' : 'interviewer', text: x.text })) });
    }
  }
  if (!found.length) return { included: false, why: 'No debriefs recorded for this performance: the film ends on a closing card.', ring: folk.map((p) => ({ pid: p.pid, label: p.label, photo: p.photo })) };
  const order = folk.map((p) => p.pid);
  found.sort((a, b) => order.indexOf(a.pid) - order.indexOf(b.pid));
  return { included: true, title: 'DEBRIEF', ring: folk.map((p) => ({ pid: p.pid, label: p.label, photo: p.photo, portrait: p.portrait })),
    clips: found.map((f) => ({ ...f, in: f.start, out: f.end, trim: null })), look: { carousel: 'turns to whoever speaks, then holds', hold: 'while they speak' } };
}

function notes(score, cut, deb, folk) {
  const m = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return `# Draft notes

**Parts:** score (${score.instructions.length} instructions) · footage (${cut.clips.length} clips, ${m(cut.length)} from a ${m(cut.session_length)} session) · ${deb.included ? `debrief (${deb.clips.length})` : 'no debrief'}

## What this draft is trying to do
- Keep everything meaningful: every scene with an instruction, and any scene where a participant says more than a few words.
- Show the earpiece: what Mother and the director said is captioned in a different style from what participants said.

## Choices I'm unsure of (comment on these first)
- **Camera choice.** ${cut.clips.filter((c) => /turns/.test(c.cameraWhy)).length} of ${cut.clips.length} clips had no tracking to go by, so the camera just alternates there.
- **Names.** ${folk.filter((p) => !p.named).length} of ${folk.length} participants are shown as “Participant N” because their release doesn't allow names.
- **Length.** Scenes split after ${GAP}s of quiet, with ${PAD}s kept either side. Tell me if it feels too choppy or too slack.
${deb.included ? '' : `- **Debrief.** ${deb.why}\n`}`;
}

function build(dir, { render = false } = {}) {
  dir = path.resolve(dir);
  const d = load(dir), folk = participants(d);
  const base = path.join(dir, 'edits', 'performance-film');
  fs.mkdirSync(base, { recursive: true });
  const n = 1 + Math.max(0, ...fs.readdirSync(base).map((f) => Number((/^v(\d+)$/.exec(f) || [])[1]) || 0));
  const out = path.join(base, `v${n}`); fs.mkdirSync(out);
  const sc = score(dir, d, folk), ct = cut(dir, d, folk), db = debrief(dir, folk);
  fs.writeFileSync(path.join(out, 'score.json'), JSON.stringify(sc, null, 2));
  fs.writeFileSync(path.join(out, 'cut.json'), JSON.stringify(ct, null, 2));
  fs.writeFileSync(path.join(out, 'debrief.json'), JSON.stringify(db, null, 2));
  fs.writeFileSync(path.join(out, 'notes.md'), notes(sc, ct, db, folk));
  if (!fs.existsSync(path.join(base, 'comments.json'))) fs.writeFileSync(path.join(base, 'comments.json'), '[]\n');
  if (render) {
    const py = fs.existsSync(path.join(ROOT, '.faces-venv', 'bin', 'python')) ? path.join(ROOT, '.faces-venv', 'bin', 'python') : 'python3';
    const r = spawnSync(py, [path.join(ROOT, 'film_render.py'), dir, out], { stdio: 'inherit' });
    if (r.status !== 0) throw Error('render failed');
  }
  return out;
}

function render(dir, out) {
  const py = fs.existsSync(path.join(ROOT, '.faces-venv', 'bin', 'python')) ? path.join(ROOT, '.faces-venv', 'bin', 'python') : 'python3';
  const r = spawnSync(py, [path.join(ROOT, 'film_render.py'), path.resolve(dir), out], { stdio: 'inherit' });
  if (r.status !== 0) throw Error('render failed');
}

// The next draft starts from the latest one: its three files are copied, then revised from the open comments.
function next(dir) {
  dir = path.resolve(dir);
  const base = path.join(dir, 'edits', 'performance-film');
  const vs = fs.readdirSync(base).map((f) => Number((/^v(\d+)$/.exec(f) || [])[1]) || 0).filter(Boolean);
  if (!vs.length) return build(dir);
  const last = path.join(base, `v${Math.max(...vs)}`), out = path.join(base, `v${Math.max(...vs) + 1}`);
  fs.mkdirSync(out);
  for (const f of ['score.json', 'cut.json', 'debrief.json', 'notes.md']) if (fs.existsSync(path.join(last, f))) fs.copyFileSync(path.join(last, f), path.join(out, f));
  const open = (readJson(path.join(base, 'comments.json'), [])).filter((c) => c.status === 'open');
  fs.writeFileSync(path.join(out, 'changes.md'), `# Changes from ${path.basename(last)}\n\n` + (open.map((c) => `- **${c.v}${c.at != null ? ' ' + c.at + 's' : ''}** “${c.text}” → _(to do)_`).join('\n') || '_No open comments._') + '\n');
  return out;
}

module.exports = { build, next, render };
if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node film.js recordings/<session> [--render]'); process.exit(1); }
  const i = process.argv.indexOf('--render-only');
  if (i > 0) { const out = path.join(path.resolve(dir), 'edits', 'performance-film', process.argv[i + 1]); render(dir, out); console.log(out); }
  else if (process.argv.includes('--next')) console.log(next(dir));
  else console.log(build(dir, { render: process.argv.includes('--render') }));
}
