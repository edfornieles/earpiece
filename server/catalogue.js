#!/usr/bin/env node
// Builds an edit-ready catalogue for a finished session, in <session>/catalogue/:
//   EDIT_NOTES.md         start here: who, when, what was said, which file holds what (for a person or an AI editor)
//   manifest.json         every media file with its kind, source, start on the session clock and wall-clock time
//   utterances.jsonl      one line per thing said: speaker, text, start/end, voice settings, word timings,
//                         which file and where in it, and which cameras / room mics were rolling
//   mixes/phoneN-conversation.wav   stereo: participant on the left, what they heard (AI + you) on the right
//   proxies/<camera>/…    light 720p copies of the camera files, for fast scrubbing and AI viewing
//   thumbs/<camera>/…     one still every 10 s, named by session time (00h12m30s.jpg)
//   sheets/<camera>/…     contact sheets: 6 stills per row = 1 minute, 10 rows = 10 minutes per sheet
//   status.json           progress, so the library can show it
// Runs by itself after each session; run again any time with:  node catalogue.js recordings/<session>

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { tc } = require('./exports');

// .env, when run by hand
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const dir = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(dir, 'session.json'))) { console.error('usage: node catalogue.js recordings/<session>'); process.exit(1); }
const C = path.join(dir, 'catalogue');
fs.mkdirSync(C, { recursive: true });
const rel = (f) => path.relative(dir, f);
const r2 = (n) => Math.round(n * 100) / 100;
const hms = (sec) => { const s = Math.max(0, Math.floor(sec)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`; };

const status = { state: 'running', step: 'starting', started: new Date().toISOString(), notes: [] };
const setStatus = (step, extra = {}) => { Object.assign(status, { step }, extra); fs.writeFileSync(path.join(C, 'status.json'), JSON.stringify(status, null, 2)); console.log('  catalogue: ' + step); };

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels', '-of', 'json', file]);
  try {
    const j = JSON.parse(r.stdout.toString());
    const v = j.streams.find((s) => s.codec_type === 'video'), a = j.streams.find((s) => s.codec_type === 'audio');
    return { duration: r2(Number(j.format.duration) || 0), video: v ? `${v.codec_name} ${v.width}x${v.height}` : null, audio: a ? `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch` : null };
  } catch { return { duration: 0 }; }
}
const ffmpeg = (args, opts = {}) => new Promise((res) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
  let err = ''; p.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
  p.on('exit', (code) => res({ ok: code === 0, err }));
  p.on('error', (e) => res({ ok: false, err: e.message }));
});

async function main() {
  const session = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  const events = (() => { try { return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  const T0 = session.start_epoch_ms || Date.parse(session.start_iso);
  // names and release status only — contact details in people.json stay out of the catalogue
  const folk = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'people.json'), 'utf8')); } catch { return []; } })();
  const byPid = Object.fromEntries(folk.map((x) => [x.pid, x]));
  for (const v of session.participants || []) { const x = byPid[v.pid]; if (x) { if (x.name) v.name = x.name; v.release = !!x.release; v.documents = (x.files || []).length; } }
  const wall = (sec) => new Date(T0 + sec * 1000).toISOString();

  // ---------- manifest ----------
  setStatus('listing files');
  const files = [];
  const audioDir = path.join(dir, 'audio');
  const roomSet = new Set((session.room_audio || []).map((r) => path.join(dir, r.file)));
  for (const f of fs.existsSync(audioDir) ? fs.readdirSync(audioDir).filter((x) => x.endsWith('.wav')).sort() : []) {
    const full = path.join(audioDir, f);
    if (roomSet.has(full)) continue;
    const m = f.match(/^phone(\d+)-(mic|heard|ai)\.wav$/);
    const kind = f === 'director-mic.wav' ? 'director_mic' : m ? { mic: 'participant_mic', heard: 'participant_heard', ai: 'ai_voice' }[m[2]] : 'audio';
    const what = {
      director_mic: 'your microphone in the control room (everything you said, to anyone)',
      participant_mic: `phone ${m && m[1]}: the participant's microphone (headset or phone)`,
      participant_heard: `phone ${m && m[1]}: everything played into the participant's ear (AI voice + your own voice)`,
      ai_voice: `phone ${m && m[1]}: only the AI voice (AI lines, typed lines, your words re-voiced)`
    }[kind] || 'audio';
    files.push({ file: rel(full), kind, phone: m ? Number(m[1]) : null, description: what, offset: 0, start_wall: wall(0), ...probe(full) });
  }
  for (const r of session.room_audio || []) files.push({ file: r.file, kind: 'room_mic', name: r.name, description: `room microphone "${r.name}"`, offset: r.offset, start_wall: wall(r.offset), ...probe(path.join(dir, r.file)) });
  for (const v of session.video || []) files.push({ file: v.file, kind: 'camera', camera: v.name, cam: v.cam, description: `camera "${v.name}"`, offset: v.offset, start_wall: wall(v.offset), ...probe(path.join(dir, v.file)) });
  const manifest = {
    session: session.name, title: session.title || '', notes: session.notes || '', start: session.start_iso, end: session.end_iso || null, timezone: session.timezone,
    clock: 'All times are seconds from the start of the session ("session clock"). A file with offset 12.5 began 12.5 s in; to find session time T inside it, seek to T - offset.',
    participants: session.participants || [], files,
    exports: { timeline: 'exports/timeline.fcpxml', markers: 'exports/markers.csv', subtitles: (session.exports?.subtitles || []).map((s) => 'exports/' + s) }
  };

  // ---------- utterances ----------
  setStatus('lining up what was said');
  const play = {};
  for (const e of events) {
    if (e.u == null) continue;
    const p = (play[e.u] = play[e.u] || {});
    if (e.type === 'play_start') p.start = Number(e.t);
    if (e.type === 'play_end' || (e.type === 'ai_cut' && e.played)) { p.end = Number(e.t); if (e.type === 'ai_cut') p.cut = e.why; }
  }
  const names = {};
  const utts = [];
  for (const e of events) {
    if (e.type === 'participant_start') names[e.id] = (e.pid && byPid[e.pid]?.name) || e.name || `Participant ${e.id}`;
    if (e.type !== 'say') continue;
    const p = e.u != null ? play[e.u] || {} : {};
    const speaker = e.who === 'participant' ? (names[e.id] || `Participant ${e.id}`) : e.who === 'ai' ? 'AI' : e.who === 'director' ? 'Director (own voice)' : e.who === 'typed' ? 'AI voice (typed by director)' : 'AI voice (spoken by director)';
    const source = e.who === 'participant' ? `audio/phone${e.id}-mic.wav` : e.who === 'director' ? 'audio/director-mic.wav' : `audio/phone${e.id}-ai.wav`;
    const u = {
      n: utts.length + 1, phone: e.id, participant: names[e.id] || null, who: e.who, speaker, text: e.text,
      start: e.start ?? p.start ?? Number(e.t), end: e.end ?? p.end ?? null,
      played: e.u != null ? p.start != null : undefined, cut_off: p.cut || undefined,
      voice: e.voice ? { name: e.voice, emotion: e.emotion, pitch: e.pitch, speed: e.speed } : undefined,
      source
    };
    if (u.played === false) u.note = 'generated but cut off before it was heard';
    utts.push(u);
  }
  utts.sort((a, b) => a.start - b.start);
  utts.forEach((u, i) => {
    u.n = i + 1;
    if (u.end == null) {
      const next = utts.slice(i + 1).find((x) => x.phone === u.phone);
      u.end = r2(Math.min(next ? next.start : Infinity, u.start + Math.max(1.5, u.text.split(/\s+/).length / 2.6)));
      u.end_estimated = true;
    }
    u.timecode = tc(u.start);
    u.start_wall = wall(u.start);
    const inside = (f) => f.offset <= u.start && u.start < f.offset + (f.duration || 0);
    u.cameras = files.filter((f) => f.kind === 'camera' && inside(f)).map((f) => ({ camera: f.camera, file: f.file, at: r2(u.start - f.offset) }));
    u.room = files.filter((f) => f.kind === 'room_mic' && inside(f)).map((f) => ({ mic: f.name, file: f.file, at: r2(u.start - f.offset) }));
  });

  // ---------- word timings (Whisper) ----------
  const key = process.env.OPENAI_API_KEY;
  if (process.env.MOCK_AI === '1' || !key || process.env.CATALOGUE_WORDS === '0') {
    status.notes.push(process.env.MOCK_AI === '1' ? 'word timings skipped (test mode)' : !key ? 'word timings skipped: no OPENAI_API_KEY' : 'word timings skipped');
  } else {
    let done = 0;
    const todo = utts.filter((u) => u.played !== false && fs.existsSync(path.join(dir, u.source)));
    const one = async (u) => {
      const a = Math.max(0, u.start - 0.3), d = u.end - u.start + 0.8;
      const clip = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(a), '-t', String(d), '-i', path.join(dir, u.source), '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'], { maxBuffer: 64 << 20 }).stdout;
      if (!clip || clip.length < 2000) return;
      const fd = new FormData();
      fd.set('model', 'whisper-1'); fd.set('response_format', 'verbose_json'); fd.append('timestamp_granularities[]', 'word');
      fd.set('file', new Blob([clip], { type: 'audio/wav' }), 'clip.wav');
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(60000) });
          if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); continue; }
          if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
          const j = await r.json();
          u.words = (j.words || []).map((w) => ({ w: w.word, start: r2(a + w.start), end: r2(a + w.end) }));
          if (u.who === 'participant' && j.text && j.text.trim() !== u.text) u.whisper_text = j.text.trim();
          if (u.words.length && u.end_estimated) { u.end = u.words[u.words.length - 1].end; delete u.end_estimated; }
          return;
        } catch (e) { if (attempt === 2) status.notes.push(`word timings failed for #${u.n}: ${e.message}`); }
      }
    };
    const queue = todo.slice();
    await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) { await one(queue.shift()); done++; if (done % 5 === 0) setStatus(`word timings ${done}/${todo.length}`); } }));
  }
  fs.writeFileSync(path.join(C, 'utterances.jsonl'), utts.map((u) => JSON.stringify(u)).join('\n') + (utts.length ? '\n' : ''));
  fs.writeFileSync(path.join(C, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ---------- conversation mixes ----------
  setStatus('mixing conversations');
  const mixes = [];
  const phones = [...new Set(files.filter((f) => f.phone).map((f) => f.phone))].sort();
  fs.mkdirSync(path.join(C, 'mixes'), { recursive: true });
  for (const n of phones) {
    const mic = path.join(audioDir, `phone${n}-mic.wav`), heard = path.join(audioDir, `phone${n}-heard.wav`);
    if (!fs.existsSync(mic) && !fs.existsSync(heard)) continue;
    const ins = [mic, heard].map((f) => fs.existsSync(f) ? ['-i', f] : ['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono']).flat();
    const len = Math.max(...[mic, heard].filter(fs.existsSync).map((f) => probe(f).duration));
    const out = path.join(C, 'mixes', `phone${n}-conversation.wav`);
    const r = await ffmpeg([...ins, '-filter_complex', '[0:a]apad[l];[1:a]apad[r];[l][r]join=inputs=2:channel_layout=stereo[a]', '-map', '[a]', '-t', String(len), '-c:a', 'pcm_s16le', out]);
    if (r.ok) mixes.push(rel(out)); else status.notes.push(`mix phone ${n} failed: ${r.err.trim().split('\n').pop()}`);
  }
  manifest.mixes = mixes.map((m) => ({ file: m, description: 'stereo: participant on the LEFT, what they heard (AI + director) on the RIGHT; starts at session time 0' }));

  // ---------- camera proxies, stills, contact sheets ----------
  const cams = files.filter((f) => f.kind === 'camera' && f.duration > 0);
  const venc = process.platform === 'darwin' ? ['-c:v', 'h264_videotoolbox', '-b:v', '2500k'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'];
  manifest.proxies = []; manifest.sheets = [];
  for (const [i, f] of cams.entries()) {
    setStatus(`camera copies ${i + 1}/${cams.length}`);
    const slug = path.basename(path.dirname(f.file));
    const base = path.basename(f.file, path.extname(f.file));
    const pd = path.join(C, 'proxies', slug), td = path.join(C, 'thumbs', slug), sd = path.join(C, 'sheets', slug), tmp = path.join(C, 'thumbs', `.${base}`);
    for (const d of [pd, td, sd, tmp]) fs.mkdirSync(d, { recursive: true });
    const proxy = path.join(pd, base + '.mp4');
    const hasAudio = !!f.audio;
    const r = await ffmpeg(['-i', path.join(dir, f.file), '-filter_complex', '[0:v]split=3[a][b][c];[a]scale=-2:720,format=yuv420p[p];[b]fps=1/10:start_time=0,scale=480:-2[t];[c]fps=1/10:start_time=0,scale=320:-2,tile=6x10[s]',
      '-map', '[p]', ...(hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '96k'] : []), ...venc, '-movflags', '+faststart', proxy,
      '-map', '[t]', '-q:v', '4', path.join(tmp, '%05d.jpg'),
      '-map', '[s]', '-q:v', '4', path.join(sd, `${base}_sheet%02d.jpg`)], { env: process.env });
    if (!r.ok) { status.notes.push(`camera copy failed for ${f.file}: ${r.err.trim().split('\n').pop()}`); continue; }
    for (const t of fs.readdirSync(tmp).sort()) fs.renameSync(path.join(tmp, t), path.join(td, `${hms(f.offset + (Number(t.slice(0, 5)) - 1) * 10)}.jpg`));
    fs.rmSync(tmp, { recursive: true, force: true });
    manifest.proxies.push({ camera: f.camera, original: f.file, proxy: rel(proxy), offset: f.offset });
    fs.readdirSync(sd).filter((x) => x.startsWith(base)).sort().forEach((x, k) => manifest.sheets.push({ camera: f.camera, file: rel(path.join(sd, x)), covers_from: r2(f.offset + k * 600), covers_to: r2(Math.min(f.offset + f.duration, f.offset + (k + 1) * 600)) }));
  }
  fs.writeFileSync(path.join(C, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ---------- notes ----------
  setStatus('writing edit notes');
  fs.writeFileSync(path.join(C, 'EDIT_NOTES.md'), notes(session, manifest, utts, events));
  setStatus('done', { state: 'done', finished: new Date().toISOString(), utterances: utts.length, files: files.length });
}

function notes(session, m, utts, events) {
  const L = [];
  const dur = Math.max(0, ...m.files.map((f) => f.offset + (f.duration || 0)));
  L.push(`# ${session.title || 'Earpiece session'} — ${session.name}`, '');
  L.push(`Started ${new Date(session.start_iso).toString()}${session.end_iso ? `, ended ${new Date(session.end_iso).toTimeString().slice(0, 8)}` : ''} · about ${dur < 90 ? Math.round(dur) + ' s' : Math.round(dur / 60) + ' min'} recorded.`, '');
  if (session.notes) L.push('## Session notes', '', session.notes.trim(), '');
  if ((session.documents || []).length) L.push('Documents attached to the session: ' + session.documents.map((d) => '`' + d.file + '`').join(', '), '');
  L.push('## How this session is organised', '');
  L.push('Every recording shares one clock: seconds from the start of the session. Timecodes below (HH:MM:SS:FF at 25 fps) are on that clock, as are the markers and the timeline in `exports/`. A file with offset 12.5 began 12.5 s into the session.', '');
  L.push('- **Fastest start:** import `exports/timeline.fcpxml` into DaVinci Resolve or Final Cut — every file is already placed, with markers. `exports/people/` has one timeline per participant, trimmed to their visit.');
  L.push('- **Script:** `catalogue/utterances.jsonl` — one line per thing said, with start/end, word timings where available, the file it lives in, and which cameras and room mics were rolling.');
  L.push('- **Listening:** `catalogue/mixes/phoneN-conversation.wav` — participant left, what they heard right.');
  L.push('- **Looking:** `catalogue/sheets/` contact sheets (each row is one minute, 10 s per still) and `catalogue/thumbs/` stills named by session time; `catalogue/proxies/` light 720p copies.', '');
  L.push('## Participants', '');
  const noRelease = (session.participants || []).filter((p) => p.release === false || p.release === undefined);
  if (noRelease.length) L.push(`> ⚠ No signed release on file for: ${[...new Set(noRelease.map((p) => p.name || 'unnamed (phone ' + p.phone + ')'))].join(', ')}. Check before using their footage or voice.`, '');
  if (!(session.participants || []).length) L.push('_No participants were started in this session._');
  for (const p of session.participants || []) {
    const said = utts.filter((u) => u.phone === p.phone && u.start >= p.start && (p.end == null || u.start <= p.end + 1));
    L.push(`- **${p.name || 'Unnamed'}**${p.release ? ' (release ✓)' : ' (no release on file)'} on phone ${p.phone}: ${tc(p.start)} → ${p.end != null ? tc(p.end) : 'end'} (${Math.round(((p.end ?? dur) - p.start) / 60 * 10) / 10} min) · ${said.filter((u) => u.who === 'participant').length} things said by them, ${said.filter((u) => u.who !== 'participant').length} directions`);
  }
  L.push('', '## Files', '', '| file | what | starts at | length |', '|---|---|---|---|');
  for (const f of m.files) L.push(`| \`${f.file}\` | ${f.description} | ${tc(f.offset)} | ${Math.round(f.duration)} s |`);
  for (const x of m.mixes || []) L.push(`| \`${x.file}\` | ${x.description} | 00:00:00:00 | |`);
  L.push('', '## What was said', '');
  L.push('Speakers: the participant by name; **AI** = the AI directing on its own; **AI voice (typed)** / **AI voice (spoken by director)** = your words in the AI voice; **Director (own voice)** = you, unaltered.', '');
  const byPhone = [...new Set(utts.map((u) => u.phone))].sort();
  for (const n of byPhone) {
    L.push(`### Phone ${n}`, '');
    for (const u of utts.filter((x) => x.phone === n)) {
      const v = u.voice ? ` _(${u.voice.name}${u.voice.emotion && u.voice.emotion !== 'neutral' ? ', ' + u.voice.emotion : ''})_` : '';
      L.push(`- \`${u.timecode}\` **${u.speaker}**${v}: ${u.text}${u.played === false ? ' _(never heard — cut off)_' : u.cut_off ? ' _(cut off)_' : ''}`);
    }
    L.push('');
  }
  const marks = events.filter((e) => ['mark', 'instruct', 'ai_cut', 'phone_hidden', 'phone_disconnected', 'camera_dropped', 'roommics_dropped', 'headset_lost', 'sync'].includes(e.type));
  if (marks.length) {
    L.push('## Marks and incidents', '');
    for (const e of marks) L.push(`- \`${tc(Number(e.t))}\` ${e.type === 'mark' ? '**Mark**' + (e.text ? ': ' + e.text : '') : e.type === 'instruct' ? `Private note to the AI (phone ${e.id}): ${e.text}` : e.type === 'ai_cut' ? `AI cut off on phone ${e.id} (${e.why})` : e.type.replace(/_/g, ' ') + (e.id ? ` (phone ${e.id})` : e.name ? ` (${e.name})` : '')}`);
    L.push('');
  }
  if (status.notes.length) L.push('## Catalogue notes', '', ...status.notes.map((n) => '- ' + n), '');
  return L.join('\n');
}

main().catch((e) => { setStatus('failed', { state: 'failed', error: e.message }); console.error(e); process.exit(1); });
