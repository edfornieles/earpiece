// Earpiece — command system
// Phones (participants) <-> control room (director), two-way audio over WebSocket.
// An AI director runs each phone on its own (OpenAI + the Watercooler voice); the human director can cut in.
// Cameras are recorded at full quality and shown live. Each session is one folder with audio, video,
// transcript, log and edit-ready exports (subtitles, markers, a timeline for Resolve/Premiere).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------- .env ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const ai = require('./ai');
const { loadConfig, Camera } = require('./cameras');
const { exportSession } = require('./exports');

const PORT = Number(process.env.PORT || 8080);
const RATE = 24000;
const MAX_PHONES = Number(process.env.MAX_PHONES || 4);
const IDLE_SECS = Number(process.env.AI_IDLE_SECS || 20);
const DEFAULT_MODE = process.env.AI_MODE || 'auto';
const BRIEF_FILE = path.join(__dirname, 'brief.txt');
const REC_ROOT = path.join(__dirname, 'recordings');

// Keys stay the same between runs, so dedicated phones and bookmarks keep working.
const KEYS_FILE = path.join(__dirname, '.keys.json');
let keys = {};
try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch {}
keys.phone = process.env.PHONE_KEY || keys.phone || crypto.randomBytes(4).toString('hex');
keys.control = process.env.CONTROL_KEY || keys.control || crypto.randomBytes(4).toString('hex');
if (!process.env.PHONE_KEY) fs.writeFileSync(KEYS_FILE, JSON.stringify({ phone: keys.phone, control: keys.control }));
const PHONE_KEY = keys.phone, CONTROL_KEY = keys.control;

// ---------- session folder ----------
const T0 = Date.now();
const stamp = new Date(T0 - new Date(T0).getTimezoneOffset() * 60000).toISOString().replace(/[:T]/g, '-').slice(0, 19);
const SESSION_DIR = path.join(REC_ROOT, stamp);
const AUDIO_DIR = path.join(SESSION_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });
const clock = () => ((Date.now() - T0) / 1000).toFixed(2);
const session = { name: stamp, title: '', start_iso: new Date(T0).toISOString(), start_epoch_ms: T0, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, participants: [], cameras: [] };
const saveSession = () => fs.writeFileSync(path.join(SESSION_DIR, 'session.json'), JSON.stringify(session, null, 2));
saveSession();
const events = fs.createWriteStream(path.join(SESSION_DIR, 'events.jsonl'), { flags: 'a' });
const transcriptFile = fs.createWriteStream(path.join(SESSION_DIR, 'transcript.txt'), { flags: 'a' });
function logEvent(type, data = {}) { events.write(JSON.stringify({ t: clock(), type, ...data }) + '\n'); }

class WavTrack {
  constructor(name) {
    this.fd = fs.openSync(path.join(AUDIO_DIR, name + '.wav'), 'w');
    this.samples = 0; this.lastHeader = 0; this.writeHeader();
  }
  writeHeader() {
    const h = Buffer.alloc(44), dataBytes = this.samples * 2;
    h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
    fs.writeSync(this.fd, h, 0, 44, 0); this.lastHeader = Date.now();
  }
  write(pcm) {   // pads silence so every track starts at the session start and stays on its clock
    const n = pcm.length >> 1, now = Date.now();
    const gap = Math.floor(((now - T0) / 1000) * RATE) - n - this.samples;
    if (gap > RATE * 0.15) { fs.writeSync(this.fd, Buffer.alloc(gap * 2), 0, gap * 2, 44 + this.samples * 2); this.samples += gap; }
    fs.writeSync(this.fd, pcm, 0, n * 2, 44 + this.samples * 2); this.samples += n;
    if (now - this.lastHeader > 2000) this.writeHeader();
  }
  close() { this.writeHeader(); fs.closeSync(this.fd); }
}
const tracks = new Map();
const track = (name) => { if (!tracks.has(name)) tracks.set(name, new WavTrack(name)); return tracks.get(name); };

// ---------- cameras ----------
const cameras = loadConfig(__dirname).map((c) => new Camera(c, SESSION_DIR, T0, (type, data, loud) => {
  logEvent(type, data);
  if (loud) console.log(`  ! ${data.name || data.cam}: ${type.replace('_', ' ')} ${data.detail || data.message || ''}`);
}));
session.cameras = cameras.map((c) => ({ id: c.id, name: c.name }));
saveSession();

// ---------- http ----------
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.png': 'image/png', '.wav': 'audio/wav', '.srt': 'text/plain', '.csv': 'text/csv', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.fcpxml': 'application/xml', '.webmanifest': 'application/manifest+json' };
let phoneBase = null;
const phoneUrl = (device) => phoneBase && `${phoneBase}/p?k=${PHONE_KEY}${device ? '&device=' + device : ''}`;
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sessionDirOf = (name) => { const d = path.join(REC_ROOT, path.basename(String(name || ''))); return fs.existsSync(d) ? d : null; };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  const ctl = u.searchParams.get('k') === CONTROL_KEY;

  if (p === '/manifest.webmanifest') {   // makes the phone page installable as a full-screen app
    const dev = u.searchParams.get('device');
    res.writeHead(200, { 'content-type': TYPES['.webmanifest'] });
    return res.end(JSON.stringify({
      name: dev ? `Earpiece ${dev}` : 'Earpiece', short_name: dev ? `Earpiece ${dev}` : 'Earpiece',
      start_url: `/p?k=${u.searchParams.get('k') || ''}${dev ? '&device=' + dev : ''}`, scope: '/', display: 'fullscreen',
      orientation: 'portrait', background_color: '#0b0b0b', theme_color: '#0b0b0b',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }]
    }));
  }
  if (p === '/app' || p === '/earpiece.apk') {   // the Android app, for installing on a phone without a cable
    const apk = path.join(__dirname, 'earpiece.apk');
    if (!fs.existsSync(apk)) { res.writeHead(404); return res.end('no app built yet'); }
    res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': 'attachment; filename="earpiece.apk"', 'content-length': fs.statSync(apk).size });
    return fs.createReadStream(apk).pipe(res);
  }
  if (p.startsWith('/cam/')) {
    if (!ctl) { res.writeHead(403); return res.end(); }
    const cam = cameras.find((c) => c.id === p.slice(5).replace('.mjpg', ''));
    if (!cam) { res.writeHead(404); return res.end(); }
    return cam.serve(res);
  }
  if (p.startsWith('/api/')) {
    if (!ctl) { res.writeHead(403); return res.end(); }
    if (p === '/api/info') {
      const devices = [];
      for (let i = 1; i <= MAX_PHONES; i++) devices.push({ device: i, url: phoneUrl(i), qr: phoneBase ? await QRCode.toString(phoneUrl(i), { type: 'svg', margin: 1 }) : null });
      return json(res, { phoneUrl: phoneUrl(), devices, session: SESSION_DIR, name: stamp, mock: ai.MOCK, cameras: cameras.map((c) => c.status()) });
    }
    if (p === '/api/sessions') {
      const list = fs.existsSync(REC_ROOT) ? fs.readdirSync(REC_ROOT).filter((d) => fs.existsSync(path.join(REC_ROOT, d, 'session.json'))).sort().reverse() : [];
      return json(res, list.map((d) => {
        let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(REC_ROOT, d, 'session.json'), 'utf8')); } catch {}
        return { name: d, title: s.title || '', start: s.start_iso, participants: (s.participants || []).map((x) => x.name || `Phone ${x.phone}`), duration: s.exports?.duration || null, cameras: (s.cameras || []).length, live: d === stamp };
      }));
    }
    const dir = sessionDirOf(u.searchParams.get('s'));
    if (!dir) return json(res, { error: 'no such session' }, 404);
    if (p === '/api/session') {
      let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); } catch {}
      let transcript = ''; try { transcript = fs.readFileSync(path.join(dir, 'transcript.txt'), 'utf8'); } catch {}
      const files = [];
      (function walk(d) { for (const f of fs.readdirSync(d)) { if (f.startsWith('.')) continue; const full = path.join(d, f); if (fs.statSync(full).isDirectory()) walk(full); else files.push({ path: path.relative(dir, full), size: fs.statSync(full).size }); } })(dir);
      return json(res, { session: s, transcript, files });
    }
    if (p === '/api/open') { if (process.platform === 'darwin') spawn('open', [dir]); return json(res, { ok: true }); }
    if (p === '/api/export') {
      if (path.basename(dir) === stamp) return json(res, { error: 'This session is still recording — it exports when you stop the server.' }, 409);
      return json(res, exportSession(dir));
    }
    if (p === '/api/title' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const f = path.join(dir, 'session.json'); const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.title = String(JSON.parse(body).title || '').slice(0, 120);
      fs.writeFileSync(f, JSON.stringify(s, null, 2)); if (path.basename(dir) === stamp) session.title = s.title;
      return json(res, { ok: true });
    }
    return json(res, { error: 'unknown' }, 404);
  }
  if (p.startsWith('/files/')) {   // play recordings in the library
    if (!ctl) { res.writeHead(403); return res.end(); }
    const [, , s, ...rest] = p.split('/');
    const dir = sessionDirOf(decodeURIComponent(s));
    const file = dir && path.join(dir, path.normalize(decodeURIComponent(rest.join('/'))).replace(/^(\.\.[\/\\])+/, ''));
    if (!file || !file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(file).size, range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (range) {
      const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/' || p === '/p') p = '/phone.html';
  if (p === '/control') p = '/control.html';
  if (p === '/library') p = '/library.html';
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// ---------- phones ----------
const sessions = new Map();   // phone slot -> Session
const controls = new Set();
const toControls = (obj) => { const s = JSON.stringify(obj); for (const c of controls) if (c.readyState === 1) c.send(s); };
const send = (ws, obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));
const list = () => [...sessions.values()].filter((s) => s.ws).map((s) => ({ id: s.id, name: s.name, mode: s.mode, waiting: s.waiting }));

function transcript(s, who, text) {
  const label = who === 'participant' ? (s.name || `PHONE ${s.id}`).toUpperCase() : who.toUpperCase();
  transcriptFile.write(`[${clock()}] #${s.id} ${label}: ${text}\n`);
  logEvent('say', { id: s.id, who, text });
  toControls({ type: 'transcript', id: s.id, who, text, t: clock() });
}
function state(s) {
  toControls({ type: 'state', id: s.id, mode: s.mode, speaking: s.speaking, thinking: s.thinking, listening: s.vad.speaking, held: s.edHold, hidden: !!s.hidden, headset: s.headset, headsetName: s.headsetName, waiting: s.waiting, name: s.name });
}
function report(s, err) {
  console.error(`  #${s.id} ${err.message}`);
  logEvent('error', { id: s.id, message: err.message });
  toControls({ type: 'error', id: s.id, text: err.message });
}

class Session {
  constructor(id) {
    this.id = id; this.ws = null; this.name = ''; this.mode = DEFAULT_MODE; this.waiting = true;
    this.history = []; this.speaking = false; this.thinking = false; this.again = false;
    this.edHold = false; this.lastActivity = Date.now(); this.turn = 0;
    this.pending = Buffer.alloc(0); this.ttsDone = true; this.playT0 = 0; this.playSent = 0; this.abort = null;
    this.vad = new ai.Vad({
      onStart: () => { if (this.speaking && this.mode === 'auto') stopAi(this, 'participant interrupted'); state(this); },
      onUtterance: (pcm) => { if (!this.waiting) heard(this, pcm); }
    });
  }
}

async function heard(s, pcm) {
  state(s);
  let text;
  try { text = (await ai.transcribe(pcm)).trim(); } catch (e) { return report(s, e); }
  if (!text || text.replace(/[^a-z]/gi, '').length < 2 || s.waiting) return;
  transcript(s, 'participant', text);
  s.history.push({ role: 'user', content: `Participant: "${text}"` });
  s.lastActivity = Date.now();
  if (s.mode === 'auto' && !s.edHold) aiTurn(s);
}

function systemPrompt(s) {
  let brief = ''; try { brief = fs.readFileSync(BRIEF_FILE, 'utf8'); } catch {}
  const el = Math.floor((Date.now() - (s.startedAt || Date.now())) / 1000);
  return `${brief}\n\n---\nParticipant's name: ${s.name || 'unknown'}. Time since they started: ${Math.floor(el / 60)}m ${el % 60}s.\n` +
    `Lines in square brackets are stage information from the system, not speech. ` +
    `Lines marked as the human director are things a person in the control room said to the participant directly; stay consistent with them.`;
}

async function aiTurn(s) {
  if (s.hidden || s.waiting || s.headset === false) return;
  if (s.thinking || s.speaking) { s.again = true; return; }
  const turn = ++s.turn;
  s.thinking = true; s.again = false; state(s);
  let reply;
  try { reply = await ai.think([{ role: 'system', content: systemPrompt(s) }, ...s.history.slice(-40)]); }
  catch (e) { s.thinking = false; state(s); return report(s, e); }
  s.thinking = false;
  if (turn !== s.turn || s.edHold || s.mode !== 'auto' || !s.ws || s.waiting) { state(s); return; }
  reply = reply.replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();
  if (!reply || /^\[?silence\]?$/i.test(reply)) { state(s); s.lastActivity = Date.now(); return; }
  s.history.push({ role: 'assistant', content: reply });
  transcript(s, 'ai', reply);
  say(s, reply, turn);
}

function say(s, text, turn) {
  s.speaking = true; s.ttsDone = false; s.vad.strict = true;
  s.abort = new AbortController();
  state(s);
  ai.speak(text, (pcm) => { if (turn === s.turn) s.pending = Buffer.concat([s.pending, pcm]); }, s.abort.signal)
    .catch((e) => { if (e.name !== 'AbortError') report(s, e); })
    .finally(() => { if (turn === s.turn) s.ttsDone = true; });
}

function stopAi(s, why) {
  s.turn++;
  if (s.abort) s.abort.abort();
  const wasSpeaking = s.speaking;
  s.pending = Buffer.alloc(0); s.speaking = false; s.ttsDone = true; s.thinking = false; s.playT0 = 0; s.vad.strict = false;
  send(s.ws, { type: 'flush' });
  if (wasSpeaking) {
    const last = s.history[s.history.length - 1];
    if (last && last.role === 'assistant') last.content += ' [cut off: ' + why + ']';
    logEvent('ai_cut', { id: s.id, why });
  }
}

function beginParticipant(s, name) {
  if (!s.waiting) endParticipant(s, 'new participant');
  s.waiting = false; s.name = name || ''; s.history = []; s.startedAt = Date.now(); s.lastActivity = Date.now();
  logEvent('participant_start', { id: s.id, name: s.name });
  session.participants.push({ phone: s.id, name: s.name, start: Number(clock()) }); saveSession();
  toControls({ type: 'participants', list: list() }); state(s);
  toControls({ type: 'transcript', id: s.id, who: 'note', text: `— ${s.name || 'new participant'} started —`, t: clock() });
  if (s.mode === 'auto') {
    s.history.push({ role: 'user', content: `[A participant has just arrived and put the earpiece in. Their name is ${s.name || 'not given'}. Begin.]` });
    setTimeout(() => aiTurn(s), 1500);
  }
}
function endParticipant(s, why) {
  if (s.waiting) return;
  stopAi(s, why);
  logEvent('participant_end', { id: s.id, name: s.name, why });
  const rec = [...session.participants].reverse().find((x) => x.phone === s.id && x.end == null);
  if (rec) { rec.end = Number(clock()); saveSession(); }
  s.waiting = true; s.history = [];
  send(s.ws, { type: 'reset' });
  toControls({ type: 'participants', list: list() }); state(s);
}

// plays queued AI audio to the phone in real time (a little ahead, so the phone never runs dry)
const FRAME = RATE * 0.02 * 2;
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.speaking) continue;
    if (!s.playT0) { if (s.pending.length < RATE * 0.3 * 2 && !s.ttsDone) continue; s.playT0 = now; s.playSent = 0; }
    let lead = s.playSent / RATE - (now - s.playT0) / 1000;
    if (lead < 0 && s.pending.length) { s.playT0 = now - (s.playSent / RATE) * 1000; lead = 0; }
    while (lead < 0.25 && s.pending.length >= (s.ttsDone ? 1 : FRAME)) {
      const chunk = s.pending.subarray(0, FRAME); s.pending = s.pending.subarray(chunk.length);
      if (s.ws && s.ws.readyState === 1) s.ws.send(chunk);
      track(`phone${s.id}-heard`).write(chunk);
      track(`phone${s.id}-ai`).write(chunk);
      s.playSent += chunk.length / 2; lead = s.playSent / RATE - (now - s.playT0) / 1000;
    }
    if (s.ttsDone && !s.pending.length && lead <= 0) {
      s.speaking = false; s.playT0 = 0; s.vad.strict = false; s.lastActivity = now; state(s);
      if (s.again && s.mode === 'auto' && !s.edHold) setTimeout(() => aiTurn(s), 300);
    }
  }
}, 20);

// keeps the AI directing when nothing is happening
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.ws || s.hidden || s.headset === false || s.waiting || s.mode !== 'auto' || s.speaking || s.thinking || s.edHold || s.vad.speaking) continue;
    if (now - s.lastActivity > IDLE_SECS * 1000) {
      s.lastActivity = now;
      s.history.push({ role: 'user', content: `[No reply from the participant for ${IDLE_SECS} seconds. Continue directing.]` });
      aiTurn(s);
    }
  }
}, 1000);

// camera status to the control room
setInterval(() => toControls({ type: 'cameras', list: cameras.map((c) => c.status()) }), 2000);

// ---------- human director talk ----------
let talk = null;
function talkStart(target) {
  talk = { targets: new Set(), pcm: [] };
  for (const s of sessions.values()) {
    if (!s.ws || (target !== 0 && target !== s.id)) continue;
    talk.targets.add(s.id); stopAi(s, 'human director cut in'); s.edHold = true; state(s);
  }
}
async function talkStop() {
  if (!talk) return;
  const t = talk; talk = null;
  for (const id of t.targets) { const s = sessions.get(id); if (s) { s.edHold = false; s.lastActivity = Date.now(); state(s); } }
  if (!t.pcm.length) return;
  let text = '';
  try { text = (await ai.transcribe(Buffer.concat(t.pcm))).trim(); } catch (e) { return console.error('  director transcription: ' + e.message); }
  if (!text) return;
  for (const id of t.targets) {
    const s = sessions.get(id); if (!s) continue;
    transcript(s, 'director', text);
    s.history.push({ role: 'user', content: `[The human director spoke to the participant directly: "${text}"]` });
  }
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
const freeId = (w) => {
  const busy = (i) => sessions.get(i)?.ws;
  if (w >= 1 && w <= MAX_PHONES && !busy(w)) return w;
  if (w >= 1 && w <= MAX_PHONES) { const old = sessions.get(w).ws; old.close(4000, 'replaced'); return w; }   // a dedicated phone reclaims its slot
  for (let i = 1; i <= MAX_PHONES; i++) if (!busy(i)) return i;
  return 0;
};

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const role = u.searchParams.get('role'), key = u.searchParams.get('k');
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));

  if (role === 'control' && key === CONTROL_KEY) {
    controls.add(ws);
    send(ws, { type: 'participants', list: list() });
    for (const s of sessions.values()) if (s.ws) state(s);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data), target = buf.readUInt16LE(0), pcm = buf.subarray(2);
        if (!talk) talkStart(target);
        talk.pcm.push(pcm);
        track('director-mic').write(pcm);
        for (const id of talk.targets) {
          const s = sessions.get(id);
          if (s && s.ws && s.ws.readyState === 1) s.ws.send(pcm);
          track(`phone${id}-heard`).write(pcm);
        }
        return;
      }
      let m; try { m = JSON.parse(data); } catch { return; }
      const s = sessions.get(m.id);
      if (m.type === 'talk') { logEvent(m.on ? 'talk_start' : 'talk_stop', { target: m.target }); if (m.on) talkStart(m.target); else talkStop(); }
      if (m.type === 'mode' && s) { s.mode = m.mode === 'auto' ? 'auto' : 'off'; if (s.mode === 'off') stopAi(s, 'AI switched off'); s.lastActivity = Date.now(); logEvent('mode', { id: s.id, mode: s.mode }); state(s); toControls({ type: 'participants', list: list() }); }
      if (m.type === 'nudge' && s && !s.waiting) { s.history.push({ role: 'user', content: '[Give the next direction now.]' }); logEvent('nudge', { id: s.id }); if (s.mode !== 'auto') { s.mode = 'auto'; state(s); } aiTurn(s); }
      if (m.type === 'end' && s) endParticipant(s, 'ended by director');
      if (m.type === 'mark') { logEvent('mark', { text: String(m.text || 'Mark').slice(0, 200) }); toControls({ type: 'marked', t: clock(), text: m.text || 'Mark' }); }
      if (m.type === 'instruct' && s && m.text && !s.waiting) {
        logEvent('instruct', { id: s.id, text: m.text });
        toControls({ type: 'transcript', id: s.id, who: 'note', text: '→ AI: ' + m.text, t: clock() });
        transcriptFile.write(`[${clock()}] #${s.id} PRIVATE NOTE TO AI: ${m.text}\n`);
        s.history.push({ role: 'user', content: `[Private instruction from the human director — the participant did not hear this. Act on it now, in your own words: ${m.text}]` });
        if (s.mode !== 'auto') { s.mode = 'auto'; state(s); }
        stopAi(s, 'new instruction'); aiTurn(s);
      }
      if (m.type === 'getBrief') { let b = ''; try { b = fs.readFileSync(BRIEF_FILE, 'utf8'); } catch {} send(ws, { type: 'brief', text: b }); }
      if (m.type === 'saveBrief' && typeof m.text === 'string') {
        fs.writeFileSync(BRIEF_FILE, m.text);
        fs.writeFileSync(path.join(SESSION_DIR, `brief-${clock()}s.txt`), m.text);
        logEvent('brief_saved'); toControls({ type: 'brief', text: m.text, saved: true });
      }
    });
    ws.on('close', () => controls.delete(ws));
    return;
  }

  if (role === 'phone' && key === PHONE_KEY) {
    const id = freeId(Number(u.searchParams.get('device') || u.searchParams.get('id')));
    if (!id) { send(ws, { type: 'full' }); return ws.close(); }
    let s = sessions.get(id);
    if (!s) { s = new Session(id); sessions.set(id, s); }
    s.ws = ws; s.hidden = false;
    send(ws, { type: 'welcome', id, waiting: s.waiting, name: s.name });
    logEvent('phone_connected', { id });
    toControls({ type: 'participants', list: list() });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const pcm = Buffer.from(data);
        track(`phone${id}-mic`).write(pcm);
        s.vad.push(pcm);
        const out = Buffer.alloc(pcm.length + 2); out.writeUInt16LE(id, 0); pcm.copy(out, 2);
        for (const c of controls) if (c.readyState === 1) c.send(out);
        return;
      }
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.type === 'begin') beginParticipant(s, String(m.name || '').slice(0, 40));
      if (m.type === 'hello' && !s.waiting && s.mode === 'auto') {   // came back after a dropout
        s.history.push({ role: 'user', content: '[The participant reconnected after a dropout. Pick up where you left off, briefly.]' });
        setTimeout(() => aiTurn(s), 1200);
      }
      if (m.type === 'headset') {   // native app: the participant's earpiece came or went (e.g. walked out of Bluetooth range)
        const was = s.headset; s.headset = !!m.connected; s.headsetName = String(m.name || '');
        if (was !== s.headset || was === undefined) {
          logEvent(s.headset ? 'headset_connected' : 'headset_lost', { id, name: s.headsetName });
          if (!s.headset) stopAi(s, 'headset out of range');
          else if (was === false && s.mode === 'auto' && !s.waiting) { s.history.push({ role: 'user', content: '[The participant\'s earpiece dropped out for a moment and is back. Repeat or continue the last direction briefly.]' }); setTimeout(() => aiTurn(s), 1000); }
          state(s);
        }
      }
      if (m.type === 'hidden') { s.hidden = true; stopAi(s, 'phone screen went off'); logEvent('phone_hidden', { id }); state(s); }
      if (m.type === 'visible') {
        s.hidden = false; s.lastActivity = Date.now(); logEvent('phone_visible', { id }); state(s);
        if (s.mode === 'auto' && !s.waiting) { s.history.push({ role: 'user', content: '[The participant\'s phone was off for a moment and is back. Repeat or continue the last direction briefly.]' }); setTimeout(() => aiTurn(s), 800); }
      }
    });
    ws.on('close', () => {
      if (s.ws === ws) { s.ws = null; stopAi(s, 'phone disconnected'); }
      logEvent('phone_disconnected', { id });
      toControls({ type: 'participants', list: list() });
    });
    return;
  }
  console.log(`  ! a ${role || 'device'} tried to connect with an old or wrong key — give it the current link from the control room`);
  send(ws, { type: 'error', text: 'This phone has an old link. Hold “Phone” in the corner for 3 s and enter the current link.' });
  ws.close(4001, 'bad key');
});

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 15000);

// ---------- tunnel ----------
async function announce(base) {
  phoneBase = base.replace(/\/+$/, '');
  console.log('\n  PHONE — scan this, or open the link on the phone:\n');
  console.log(await QRCode.toString(phoneUrl(), { type: 'terminal', small: true }));
  console.log('  ' + phoneUrl());
  console.log('  dedicated phones: add &device=1, &device=2 … (QR codes for each are on the control page)\n');
}
function startQuickTunnel() {
  const cfg = path.join(__dirname, '.cloudflared-earpiece.yml');
  fs.writeFileSync(cfg, 'no-autoupdate: true\n');
  const proc = spawn('cloudflared', ['tunnel', '--config', cfg, '--url', `http://localhost:${PORT}`]);
  proc.on('error', () => console.log('\n  cloudflared not found — install it with:  brew install cloudflared\n'));
  setTimeout(() => { if (!phoneBase) console.log('\n  ! no tunnel after 20s — the lines starting "cloudflared:" above say why\n'); }, 20000);
  const onData = (d) => {
    for (const line of String(d).split('\n')) if (/ ERR |error|failed/i.test(line)) console.log('  cloudflared: ' + line.trim());
    const m = String(d).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !phoneBase) announce(m[0]);
  };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  process.on('exit', () => proc.kill());
}

server.listen(PORT, async () => {
  const controlUrl = `http://localhost:${PORT}/control?k=${CONTROL_KEY}`;
  console.log('\n  EARPIECE' + (ai.MOCK ? '  (MOCK AI)' : ''));
  console.log('  session folder: ' + SESSION_DIR);
  if (!ai.MOCK && !process.env.OPENAI_API_KEY) console.log('  ! no OPENAI_API_KEY in .env — the AI will not work');
  if (!ai.MOCK) {
    try { await fetch((process.env.POCKET_TTS_URL || 'http://localhost:8123').replace(/\/+$/, '') + '/', { signal: AbortSignal.timeout(2000) }); console.log('  voice: Watercooler (Pocket-TTS) reachable'); }
    catch { console.log('  ! Watercooler voice server not reachable on :8123 — see README'); }
  }
  console.log(cameras.length ? `  cameras: ${cameras.map((c) => c.name).join(', ')}` : '  cameras: none (add them in cameras.json)');
  for (const c of cameras) c.start();
  console.log('\n  CONTROL ROOM (open on this computer, use headphones):\n  ' + controlUrl);
  console.log('  LIBRARY: http://localhost:' + PORT + '/library?k=' + CONTROL_KEY);
  if (process.platform === 'darwin' && !process.env.NO_OPEN) spawn('open', [controlUrl]);
  if (process.env.PUBLIC_URL) announce(process.env.PUBLIC_URL);
  else if (!process.env.NO_TUNNEL) startQuickTunnel();
  logEvent('session_start');
});

// ---------- shutdown: close everything, convert video, write exports ----------
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  console.log('\n  stopping — finishing recordings…');
  for (const s of sessions.values()) endParticipant(s, 'session ended');
  logEvent('session_end');
  for (const t of tracks.values()) t.close();
  for (const c of cameras) c.stop();
  await new Promise((r) => {   // let ffmpeg close its files
    const t0 = Date.now();
    const check = () => (cameras.every((c) => [c.rec, c.prev].every((p) => !p || p.exitCode !== null || p.signalCode)) || Date.now() - t0 > 8000) ? r() : setTimeout(check, 200);
    check();
  });
  if (cameras.length) console.log('  converting video for the editor…');
  const clips = cameras.flatMap((c) => c.finalize());
  session.video = clips.map((c) => ({ ...c, file: path.relative(SESSION_DIR, c.file) }));
  session.end_iso = new Date().toISOString();
  saveSession();
  await new Promise((r) => events.end(r));
  transcriptFile.end();
  try {
    const ex = exportSession(SESSION_DIR, clips);
    console.log(`  exports written: timeline.fcpxml, markers.csv (${ex.markers})${ex.subtitles.length ? ', ' + ex.subtitles.join(', ') : ''}`);
  } catch (e) { console.log('  ! export failed: ' + e.message); }
  console.log('\n  saved: ' + SESSION_DIR + '\n');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
