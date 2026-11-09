// Mother — command system
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
const { loadRoomMics, RoomMics } = require('./roommics');
const { Registry } = require('./registry');
const { ProgramStore, ProgramRunner } = require('./programs');
const { generateProgram } = require('./program-drafts');
const { RoomObserver } = require('./room');
let generatingProgram=false;
const programStore = new ProgramStore(path.join(__dirname, 'programs'));
let programRunner;

const PORT = Number(process.env.PORT || 8080);
const RATE = 24000;
const INITIAL_PHONE_COUNT = Math.max(1, Math.min(65535, Math.floor(Number(process.env.MAX_PHONES) || 4)));
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
keys.monitor = process.env.MONITOR_KEY || keys.monitor || crypto.randomBytes(4).toString('hex');   // camera screens: watch only
keys.join = process.env.JOIN_KEY || keys.join || crypto.randomBytes(4).toString('hex');            // registration: can only sign up
if (!process.env.PHONE_KEY) fs.writeFileSync(KEYS_FILE, JSON.stringify({ phone: keys.phone, control: keys.control, monitor: keys.monitor, join: keys.join }));
const PHONE_KEY = keys.phone, CONTROL_KEY = keys.control, MONITOR_KEY = keys.monitor, JOIN_KEY = keys.join;

// Voice choices persist between runs.
const SETTINGS_FILE = path.join(__dirname, '.settings.json');
let settings = { voices: {}, styles: {} };
try { settings = { voices: {}, styles: {}, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
let MAX_PHONES = Math.max(INITIAL_PHONE_COUNT, Math.min(65535, Math.floor(Number(settings.phoneCount) || 0)));
const voiceOf = (id) => settings.voices[id] || ai.VOICES[0].name;
const styleOf = (id) => ({ emotion: 'neutral', pitch: 0, speed: 1, ...(settings.styles[id] || {}) });

// ---------- session folder ----------
// Two modes, chosen by run.js. STANDBY: nothing is recorded; you prepare the next session (name, notes,
// documents, people), kept in recordings/_next. RECORDING: a new session folder, which takes over
// whatever was prepared. "Start session" and "End session" switch between them.
const STANDBY = process.env.EARPIECE_MODE !== 'record';
const NEXT_DIR = path.join(REC_ROOT, '_next');
const T0 = Date.now();
const stamp = STANDBY ? '_next' : new Date(T0 - new Date(T0).getTimezoneOffset() * 60000).toISOString().replace(/[:T]/g, '-').slice(0, 19);
const SESSION_DIR = STANDBY ? NEXT_DIR : path.join(REC_ROOT, stamp);
const AUDIO_DIR = path.join(SESSION_DIR, 'audio');
fs.mkdirSync(STANDBY ? NEXT_DIR : AUDIO_DIR, { recursive: true });
const clock = () => ((Date.now() - T0) / 1000).toFixed(2);
const session = { name: stamp, title: '', start_iso: new Date(T0).toISOString(), start_epoch_ms: T0, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, participants: [], cameras: [] };
const saveSession = () => fs.writeFileSync(path.join(SESSION_DIR, STANDBY ? 'next.json' : 'session.json'), JSON.stringify(session, null, 2));
// what was prepared in standby: title, notes, documents (people are adopted below)
const prepared = (() => { try { return JSON.parse(fs.readFileSync(path.join(NEXT_DIR, 'next.json'), 'utf8')); } catch { return null; } })();
if (prepared) for (const k of ['title', 'notes', 'documents', 'program']) if (prepared[k]) session[k] = prepared[k];
let adopted = false;
if (!STANDBY && fs.existsSync(NEXT_DIR)) {   // a new recording takes over the prepared documents and people
  try {
    if (fs.existsSync(path.join(NEXT_DIR, 'documents'))) fs.renameSync(path.join(NEXT_DIR, 'documents'), path.join(SESSION_DIR, 'documents'));
    if (fs.existsSync(path.join(NEXT_DIR, 'people.json'))) fs.copyFileSync(path.join(NEXT_DIR, 'people.json'), path.join(SESSION_DIR, 'people.json'));
    fs.rmSync(NEXT_DIR, { recursive: true, force: true });
    adopted = true;
  } catch (e) { console.log('  ! could not take over the prepared session: ' + e.message); }
}

// ---------- people: everyone who takes part, with their details and documents (release forms etc.) ----------
// Kept in people.json in the session folder. Contact details stay there: the catalogue only uses names
// and whether a release is on file.
const readPeople = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'people.json'), 'utf8')); } catch { return []; } };
const writePeople = (dir, list) => fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify(list, null, 2));
let people = readPeople(SESSION_DIR);
const newPid = () => 'p' + crypto.randomBytes(3).toString('hex');
const savePeople = () => { writePeople(SESSION_DIR, people); toControls({ type: 'people', list: people }); };
const personBy = (pid) => people.find((x) => x.pid === pid);
function upsertPerson(d) {
  let x = d.pid && personBy(d.pid);
  if (!x) { x = { pid: d.pid || newPid(), name: '', contact: '', notes: '', release: false, files: [], visits: [], added: new Date().toISOString() }; people.push(x); }
  for (const k of ['name', 'contact', 'notes']) if (typeof d[k] === 'string') x[k] = d[k].slice(0, k === 'notes' ? 4000 : 200);
  if (typeof d.release === 'boolean') x.release = d.release;
  if ('next' in d) x.next = Number(d.next) >= 1 && Number(d.next) <= MAX_PHONES ? Number(d.next) : null;   // the phone they're assigned to
  if (typeof d.name === 'string') {   // keep names in the session record in step
    for (const v of session.participants) if (v.pid === x.pid) v.name = x.name;
    saveSession();
  }
  // a registered person's name, email and notes live on their registration too, so they follow them to later sessions
  if (x.registered && typeof registry !== 'undefined') registry.update(x.pid, { name: x.name, email: x.contact, notes: x.notes });
  savePeople();
  return x;
}
const safeName = (s) => String(s || '').normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';

// ---------- registrations (welcome station) ----------
const registry = new Registry(__dirname);
if (adopted) {   // registrations added to "the next session" now belong to this one
  for (const x of registry.list) for (const s of x.sessions) if (s.session === '_next') s.session = stamp;
  registry.save();
}
const regView = (x) => ({ pid: x.pid, number: x.number, name: x.name, email: x.email, face: x.face, registered: x.registered, notes: x.notes || '', sessions: x.sessions, photo: `/participants/${x.pid}/photo.jpg` });
const recentRegs = () => registry.list.filter((x) => Date.now() - Date.parse(x.registered) < 36 * 3600e3).map(regView);
// Connect a registration to a session — live or finished — optionally to one phone visit in it.
// The visit's earlier, unregistered record (e.g. the name typed on the phone) is folded into the registration.
function linkPerson(dir, rid, visitIdx = -1, how = 'linked by hand') {
  const live = path.basename(dir) === stamp;
  const reg = registry.get(rid); if (!reg) throw new Error('no such registration');
  const sj = live ? session : JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  const plist = live ? people : readPeople(dir);
  const copied = registry.copyInto(dir, rid, safeName);
  let x = plist.find((y) => y.pid === rid);
  if (!x) { x = { pid: rid, name: '', contact: '', notes: '', release: false, files: [], visits: [], added: new Date().toISOString() }; plist.push(x); }
  Object.assign(x, { name: reg.name, contact: reg.email, release: true, registered: true, number: reg.number, face: reg.face, photo: copied.photo, consent: copied.files.find((f) => /consent/.test(f.name))?.file || null });
  if (reg.notes && !x.notes.includes(reg.notes)) x.notes = [reg.notes, x.notes].filter(Boolean).join('\n');
  for (const f of copied.files) if (!x.files.find((y) => y.file === f.file)) x.files.push(f);
  if (visitIdx >= 0) {
    const v = (sj.participants || [])[visitIdx]; if (!v) throw new Error('no such visit');
    const old = v.pid && v.pid !== rid ? plist.find((y) => y.pid === v.pid) : null;
    if (old) {
      const i = old.visits.findIndex((w) => w.phone === v.phone && Math.abs(w.start - v.start) < 1);
      if (i >= 0) x.visits.push(...old.visits.splice(i, 1));
      x.aliases = [...new Set([...(x.aliases || []), old.pid])];
      if (old.notes && !x.notes.includes(old.notes)) x.notes = [x.notes, old.notes].filter(Boolean).join('\n');
      for (const f of old.files) if (!x.files.find((y) => y.file === f.file)) x.files.push(f);
      if (!old.visits.length && !old.registered) plist.splice(plist.indexOf(old), 1);
      if (x.notes) registry.update(rid, { notes: x.notes });
      if (live) for (const ps of sessions.values()) if (ps.pid === old.pid) { ps.pid = rid; ps.name = reg.name; state(ps); }
    } else if (!x.visits.find((w) => w.phone === v.phone && Math.abs(w.start - v.start) < 1)) x.visits.push({ phone: v.phone, start: v.start, end: v.end });
    v.pid = rid; v.name = reg.name;
  }
  registry.noteSession(rid, path.basename(dir), how);
  if (live) { saveSession(); savePeople(); toControls({ type: 'participants', list: list() }); toControls({ type: 'registry', list: recentRegs() }); }
  else {
    writePeople(dir, plist); fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(sj, null, 2));
    try { exportSession(dir); startCatalogue(dir); } catch {}
  }
  return x;
}
function unlinkPerson(dir, pid) {   // undo a link that has no phone visit (someone added to the wrong session)
  const live = path.basename(dir) === stamp;
  const plist = live ? people : readPeople(dir), x = plist.find((y) => y.pid === pid);
  if (!x) throw new Error('not in this session');
  if (x.visits.length) throw new Error('They were on a phone in this session — link that visit to the right person instead.');
  plist.splice(plist.indexOf(x), 1);
  registry.forgetSession(pid, path.basename(dir));
  if (live) { savePeople(); toControls({ type: 'registry', list: recentRegs() }); } else writePeople(dir, plist);
}
// ---------- trash: deleted sessions, files and registrations wait here until you empty it ----------
const TRASH = path.join(REC_ROOT, '_trash');
const trashIndexFile = path.join(TRASH, 'index.json');
const readTrash = () => { try { return JSON.parse(fs.readFileSync(trashIndexFile, 'utf8')); } catch { return []; } };
const writeTrash = (list) => { fs.mkdirSync(TRASH, { recursive: true }); fs.writeFileSync(trashIndexFile, JSON.stringify(list, null, 2)); };
const sizeOf = (f) => { try { const st = fs.statSync(f); return st.isDirectory() ? fs.readdirSync(f).reduce((a, x) => a + sizeOf(path.join(f, x)), 0) : st.size; } catch { return 0; } };
// moves files into the trash; returns [{ from, to }] relative to the earpiece folder, for restoring
function trashMove(id, absPaths) {
  const moves = [];
  for (const a of absPaths) {
    if (!fs.existsSync(a)) continue;
    const rel = path.relative(__dirname, a), to = path.join(TRASH, id, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(a, to);
    moves.push({ from: rel, to: path.relative(__dirname, to) });
  }
  return moves;
}
const trashId = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
function deleteSession(name) {
  const dir = sessionDirOf(name);
  if (!dir || name.startsWith('_')) throw new Error('no such session');
  if (name === stamp) throw new Error('This session is recording — end it first.');
  let title = ''; try { title = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).title || ''; } catch {}
  const id = trashId(), size = sizeOf(dir);
  const reg = registry.list.filter((x) => x.sessions.some((y) => y.session === name)).map((x) => ({ pid: x.pid, entry: x.sessions.find((y) => y.session === name) }));
  for (const r of reg) registry.forgetSession(r.pid, name);
  const moves = trashMove(id, [dir]);
  writeTrash([...readTrash(), { id, kind: 'session', label: title ? `${title} (${name})` : name, session: name, size, at: new Date().toISOString(), moves, registry: reg }]);
}
// files inside a finished session (or documents in the live one); session.json and people.json are kept in step
function deleteFiles(dir, rels) {
  const name = path.basename(dir), live = name === stamp;
  const abs = rels.map((r) => path.join(dir, path.normalize(r).replace(/^(\.\.[\/\\])+/, ''))).filter((a) => a.startsWith(dir + path.sep) && fs.existsSync(a));
  if (live && abs.some((a) => !path.relative(dir, a).startsWith('documents' + path.sep))) throw new Error('This session is recording — only documents can be deleted until it ends.');
  if (abs.some((a) => /^(session\.json|people\.json|next\.json)$/.test(path.relative(dir, a)))) throw new Error('The session record itself can\'t be deleted — delete the whole session instead.');
  if (!abs.length) throw new Error('nothing to delete');
  const gone = new Set(abs.map((a) => path.relative(dir, a)));
  const size = abs.reduce((a, f) => a + sizeOf(f), 0), id = trashId();
  const moves = trashMove(id, abs);
  // keep the records in step
  const sj = live ? session : JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  const records = { session: {}, people: [] };   // what the records said about these files, to put back on restore
  for (const k of ['documents', 'video', 'room_audio']) if (Array.isArray(sj[k])) { records.session[k] = sj[k].filter((x) => gone.has(x.file)); sj[k] = sj[k].filter((x) => !gone.has(x.file)); }
  const plist = live ? people : readPeople(dir);
  for (const x of plist) {
    const r = { pid: x.pid, files: (x.files || []).filter((f) => gone.has(f.file)), photo: gone.has(x.photo) ? x.photo : null, consent: gone.has(x.consent) ? x.consent : null };
    if (r.files.length || r.photo || r.consent) records.people.push(r);
    x.files = (x.files || []).filter((f) => !gone.has(f.file)); if (gone.has(x.photo)) x.photo = null; if (gone.has(x.consent)) x.consent = null;
  }
  if (live) { saveSession(); savePeople(); toControls({ type: 'session', title: session.title, notes: session.notes || '', documents: session.documents || [] }); }
  else {
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(sj, null, 2)); writePeople(dir, plist);
    if ([...gone].some((r) => /^(audio|video)\//.test(r))) { try { exportSession(dir); } catch {} }   // timelines without the deleted media
  }
  writeTrash([...readTrash(), { id, kind: 'files', label: `${abs.length === 1 ? path.basename(abs[0]) : abs.length + ' files'} from ${sj.title || name}`, session: name, size, at: new Date().toISOString(), moves, records }]);
  return abs.length;
}
// a registration: their photo and signed consent, everywhere they were copied. Recordings of them stay.
function deleteRegistration(pid) {
  const x = registry.get(pid); if (!x) throw new Error('no such registration');
  const id = trashId(), paths = [path.join(registry.dir, pid)], snapshots = [];
  for (const sref of x.sessions) {
    const dir = sessionDirOf(sref.session); if (!dir) continue;
    const live = sref.session === stamp, plist = live ? people : readPeople(dir), rec = plist.find((y) => y.pid === pid);
    if (!rec) continue;
    snapshots.push({ session: sref.session, record: JSON.parse(JSON.stringify(rec)) });
    for (const f of rec.files || []) if (f.file.startsWith('documents/') && f.file.includes('_' + pid + '/')) paths.push(path.join(dir, path.dirname(f.file)));
    Object.assign(rec, { name: `Removed participant #${x.number}`, contact: '', notes: '', photo: null, consent: null, registered: false, removed: true, release: false,
      files: (rec.files || []).filter((f) => !f.file.includes('_' + pid + '/')) });
    if (live) savePeople(); else writePeople(dir, plist);
  }
  const moves = trashMove(id, [...new Set(paths)]);
  registry.list = registry.list.filter((y) => y.pid !== pid); registry.save();
  writeTrash([...readTrash(), { id, kind: 'registration', label: `Registration #${x.number} ${x.name}`, size: moves.reduce((a, m) => a + sizeOf(path.join(__dirname, m.to)), 0), at: new Date().toISOString(), moves, entry: x, snapshots }]);
  toControls({ type: 'registry', list: recentRegs() });
}
function restoreTrash(id) {
  const list = readTrash(), item = list.find((t) => t.id === id); if (!item) throw new Error('not in the trash');
  for (const m of item.moves) {
    const from = path.join(__dirname, m.to), to = path.join(__dirname, m.from);
    if (fs.existsSync(to) && !fs.statSync(to).isDirectory()) throw new Error(`Can't restore: ${m.from} already exists`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) { for (const f of fs.readdirSync(from)) fs.renameSync(path.join(from, f), path.join(to, f)); } else fs.renameSync(from, to);
  }
  if (item.kind === 'session') for (const r of item.registry || []) { const x = registry.get(r.pid); if (x && !x.sessions.find((y) => y.session === item.session)) { x.sessions.push(r.entry); registry.save(); } }
  if (item.kind === 'registration') {
    if (!registry.get(item.entry.pid)) { registry.list.push(item.entry); registry.save(); }
    for (const snap of item.snapshots || []) {
      const dir = sessionDirOf(snap.session); if (!dir) continue;
      const live = snap.session === stamp, plist = live ? people : readPeople(dir), i = plist.findIndex((y) => y.pid === snap.record.pid);
      if (i >= 0) plist[i] = snap.record; else plist.push(snap.record);
      if (live) savePeople(); else writePeople(dir, plist);
    }
    toControls({ type: 'registry', list: recentRegs() });
  }
  if (item.kind === 'files' && item.records) {   // put the files back in the records
    const dir = sessionDirOf(item.session);
    if (dir) {
      const live = item.session === stamp;
      const sj = live ? session : JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
      for (const [k, list] of Object.entries(item.records.session || {})) { sj[k] = sj[k] || []; for (const e of list) if (!sj[k].find((x) => x.file === e.file)) sj[k].push(e); }
      const plist = live ? people : readPeople(dir);
      for (const r of item.records.people || []) {
        const x = plist.find((y) => y.pid === r.pid); if (!x) continue;
        for (const f of r.files) if (!x.files.find((y) => y.file === f.file)) x.files.push(f);
        if (r.photo) x.photo = r.photo; if (r.consent) x.consent = r.consent;
      }
      if (live) { saveSession(); savePeople(); toControls({ type: 'session', title: session.title, notes: session.notes || '', documents: session.documents || [] }); }
      else { fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(sj, null, 2)); writePeople(dir, plist); try { exportSession(dir); } catch {} }
    }
  }
  fs.rmSync(path.join(TRASH, id), { recursive: true, force: true });
  writeTrash(list.filter((t) => t.id !== id));
}
function purgeTrash(id) {   // permanent
  const list = readTrash();
  for (const t of list.filter((t) => !id || t.id === id)) fs.rmSync(path.join(TRASH, t.id), { recursive: true, force: true });
  writeTrash(id ? list.filter((t) => t.id !== id) : []);
}
const joinHits = new Map();   // ip -> recent registration times (keeps the public form from being flooded)
saveSession();
const NULL_STREAM = { write() {}, end(cb) { if (cb) cb(); } };
const events = STANDBY ? NULL_STREAM : fs.createWriteStream(path.join(SESSION_DIR, 'events.jsonl'), { flags: 'a' });
const transcriptFile = STANDBY ? NULL_STREAM : fs.createWriteStream(path.join(SESSION_DIR, 'transcript.txt'), { flags: 'a' });
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
    if (this.closed) return;
    const n = pcm.length >> 1, now = Date.now();
    const gap = Math.floor(((now - T0) / 1000) * RATE) - n - this.samples;
    if (gap > RATE * 0.15) { fs.writeSync(this.fd, Buffer.alloc(gap * 2), 0, gap * 2, 44 + this.samples * 2); this.samples += gap; }
    fs.writeSync(this.fd, pcm, 0, n * 2, 44 + this.samples * 2); this.samples += n;
    if (now - this.lastHeader > 2000) this.writeHeader();
  }
  close() { if (this.closed) return; this.closed = true; this.writeHeader(); fs.closeSync(this.fd); }
}
const tracks = new Map();
let closing = false;
const NULL_TRACK = { write() {} };
const track = (name) => { if (closing || STANDBY) return NULL_TRACK; if (!tracks.has(name)) tracks.set(name, new WavTrack(name)); return tracks.get(name); };

// ---------- cameras ----------
const cameras = loadConfig(__dirname).map((c) => new Camera(c, SESSION_DIR, T0, (type, data, loud) => {
  logEvent(type, data);
  if (loud) console.log(`  ! ${data.name || data.cam}: ${type.replace('_', ' ')} ${data.detail || data.message || ''}`);
}, { previewOnly: STANDBY }));
session.cameras = cameras.map((c) => ({ id: c.id, name: c.name }));
// ---------- room microphones ----------
const roomCfg = loadRoomMics(__dirname);
const roomMics = roomCfg ? new RoomMics(roomCfg, SESSION_DIR, T0, (type, data, loud) => {
  logEvent(type, data);
  if (loud) console.log(`  ! room mics: ${type.replace('roommics_', '').replace('_', ' ')} ${data.detail || data.message || ''}`);
}) : null;
session.room_mics = roomCfg ? roomCfg.names : [];
saveSession();

const roomObserver=new RoomObserver(path.join(__dirname,'.room.json'),{
  cameras:()=>cameras,maxPhones:()=>MAX_PHONES,event:(type,data)=>logEvent(type,data)
});
setInterval(()=>roomObserver.tick(),1000);
// Live face recognition of registered people (face matching agreed) on the tracking camera.
const { Identity } = require('./identity');
const identity = new Identity({ root: __dirname, registry, cameras, tracking: roomObserver.tracking, log: (s) => console.log('  ' + s) });
roomObserver.tracking.faceStatus = (now) => identity.status(now);
// Named studio objects found by description in the tracking camera (local OWLv2), placed on the floor plan.
const { ObjectFinder } = require('./objects-finder');
const finder = new ObjectFinder({ root: __dirname, cameras, tracking: roomObserver.tracking, room: roomObserver, identity, log: (s) => console.log('  ' + s) });
roomObserver.tracking.finderStatus = (now) => finder.status(now);
const { PoseTracker } = require('./pose-tracker');
const pose = new PoseTracker({ root: __dirname, cameras, room: roomObserver, identity, log: (s) => console.log('  ' + s) });
roomObserver.tracking.poseStatus = () => pose.status();
process.on('exit', () => pose.stop());

// ---------- http ----------
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.png': 'image/png', '.wav': 'audio/wav', '.srt': 'text/plain', '.csv': 'text/csv', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.fcpxml': 'application/xml', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.gif': 'image/gif', '.heic': 'image/heic' };
let phoneBase = null;
const phoneUrl = (device) => phoneBase && `${phoneBase}/p?k=${PHONE_KEY}${device ? '&device=' + device : ''}`;
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const introFile = () => ['intro.mp4', 'intro.mov', 'intro.m4v'].map((f) => path.join(__dirname, f)).find((f) => fs.existsSync(f));
// this Mac's address on the local network, for camera screens on tablets / other computers
function lanAddress() {
  const all = Object.entries(require('os').networkInterfaces()).flatMap(([n, l]) => (l || []).map((a) => ({ n, ...a })));
  const v4 = all.filter((a) => a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address));
  return (v4.find((a) => a.n === 'en0') || v4.find((a) => /^(192\.168|10\.|172\.)/.test(a.address)) || v4[0])?.address || null;
}
const sessionDirOf = (name) => { const b = path.basename(String(name || '')); if (!b || (b.startsWith('_') && b !== '_next')) return null; const d = path.join(REC_ROOT, b); return fs.existsSync(d) ? d : null; };
const readBrief = () => { try { return fs.readFileSync(BRIEF_FILE, 'utf8'); } catch { return ''; } };
function updateSessionMeta(d) {
  if (typeof d.title === 'string') session.title = d.title.slice(0, 120);
  if (typeof d.notes === 'string') session.notes = d.notes.slice(0, 20000);
  saveSession(); logEvent('session_named', { title: session.title });
  toControls({ type: 'session', title: session.title, notes: session.notes || '', documents: session.documents || [] });
}
function saveBriefText(text) {
  fs.writeFileSync(BRIEF_FILE, text);
  fs.writeFileSync(path.join(SESSION_DIR, `brief-${clock()}s.txt`), text);
  logEvent('brief_saved'); toControls({ type: 'brief', text, saved: true });
}
async function readSetupBody(req) {
  let body = '', size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256000) throw new Error('This text is too long.'); body += chunk; }
  const d = JSON.parse(body || '{}');
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Expected an object.');
  return d;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  const ctl = u.searchParams.get('k') === CONTROL_KEY;
  const mon = ctl || u.searchParams.get('k') === MONITOR_KEY;

  if (p === '/manifest.webmanifest') {   // makes the phone page installable as a full-screen app
    const dev = u.searchParams.get('device');
    res.writeHead(200, { 'content-type': TYPES['.webmanifest'] });
    return res.end(JSON.stringify({
      name: dev ? `Mother ${dev}` : 'Mother', short_name: dev ? `Mother ${dev}` : 'Mother',
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
  if (p.startsWith('/join-api/')) {   // the public registration form (reached by the QR code)
    if (u.searchParams.get('j') !== JOIN_KEY) { res.writeHead(403); return res.end(); }
    if (p === '/join-api/info') { const c = registry.consent(); return json(res, { consent: c.text, version: c.version }); }
    if (p === '/join-api/submit' && req.method === 'POST') {
      const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const hits = (joinHits.get(ip) || []).filter((t) => Date.now() - t < 3600e3);
      if (hits.length >= 15) return json(res, { error: 'Too many registrations from this connection — please ask at the desk.' }, 429);
      let body = '', n = 0;
      for await (const c of req) { n += c.length; if (n > 12e6) return json(res, { error: 'The photo is too large.' }, 413); body += c; }
      let d; try { d = JSON.parse(body); } catch { return json(res, { error: 'Something went wrong — please try again.' }, 400); }
      const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 80), email = String(d.email || '').trim().slice(0, 120);
      const signature = String(d.signature || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (name.length < 2) return json(res, { error: 'Please give your name.' }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, { error: 'Please give a valid email address.' }, 400);
      if (d.adult !== true) return json(res, { error: 'You need to be 18 or over to take part.' }, 400);
      if (d.agree !== true || signature.length < 2) return json(res, { error: 'Please read the consent form, tick to agree and type your name to sign.' }, 400);
      if (d.version !== registry.consent().version) return json(res, { error: 'The consent form has just been updated — please reload the page and read it again.' }, 409);
      const photo = Buffer.from(String(d.photo || '').replace(/^data:image\/jpeg;base64,/, ''), 'base64');
      if (photo.length < 2000 || photo[0] !== 0xff || photo[1] !== 0xd8) return json(res, { error: 'Please take a photo.' }, 400);
      hits.push(Date.now()); joinHits.set(ip, hits);
      const x = registry.add({ name, email, face: d.face === true, signature, photo, ip });
      logEvent('registered', { pid: x.pid, number: x.number });
      toControls({ type: 'arrival', person: regView(x) }); toControls({ type: 'registry', list: recentRegs() });
      console.log(`  + registered: #${x.number} ${x.name}${x.face ? ' (face matching ok)' : ''}`);
      return json(res, { ok: true, number: x.number, name: x.name });
    }
    res.writeHead(404); return res.end();
  }
  if (p === '/welcome-api/info') {   // the welcome station: the join link as a QR code, and whether there's an intro film
    if (!mon) { res.writeHead(403); return res.end(); }
    const ip = lanAddress(), base = phoneBase || (ip && `http://${ip}:${PORT}`);
    const joinUrl = base && `${base}/join?j=${JOIN_KEY}`;
    return json(res, { joinUrl, qr: joinUrl ? await QRCode.toString(joinUrl, { type: 'svg', margin: 1 }) : null, public: !!phoneBase, video: !!introFile(), draft: registry.consent().draft });
  }
  if (p === '/intro-video') {   // intro.mp4 (or .mov / .m4v) in the earpiece folder
    const f = introFile();
    if (!mon || !f) { res.writeHead(f ? 403 : 404); return res.end(); }
    const size = fs.statSync(f).size, range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    const type = f.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
    if (range) { const a = Number(range[1] || 0), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1 }); return fs.createReadStream(f, { start: a, end: b }).pipe(res); }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' }); return fs.createReadStream(f).pipe(res);
  }
  if (p.startsWith('/participants/')) {   // registration photos and signed consent: control room only
    const [, , pid, f] = p.split('/');
    const file = registry.get(pid) && ['photo.jpg', 'consent.md'].includes(f) && path.join(registry.dir, pid, f);
    if (!ctl || !file || !fs.existsSync(file)) { res.writeHead(ctl ? 404 : 403); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store' }); return fs.createReadStream(file).pipe(res);
  }
  const fullPic = /^\/cam\/([\w-]+)\/full\.jpg$/.exec(p);
  if (fullPic) {   // newest full-resolution frame, for the follow view (only while tracking reads the main stream)
    if (!mon) { res.writeHead(403); return res.end(); }
    const f = identity.full;
    if (!f || f.camId !== fullPic[1] || !f.frame || Date.now() - f.at > 3000 || f.at <= Number(u.searchParams.get('after') || 0)) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-frame-at': String(f.at) });
    return res.end(f.frame);
  }
  if (p.startsWith('/cam/')) {
    if (!mon) { res.writeHead(403); return res.end(); }
    const cam = cameras.find((c) => c.id === p.slice(5).replace('.mjpg', ''));
    if (!cam) { res.writeHead(404); return res.end(); }
    return cam.serve(res);
  }
  if (p.startsWith('/api/')) {
    if (!ctl) { res.writeHead(403); return res.end(); }
    if(p==='/api/room-frame') {
      const frame=roomObserver.frames.get(u.searchParams.get('observation'));
      if(!frame){res.writeHead(404);return res.end('Analysed frame expired. Analyse again.');}
      res.writeHead(200,{'content-type':'image/jpeg','cache-control':'no-store'});return res.end(frame);
    }
    if(p==='/api/room') {
      try {
        if(req.method==='POST'){
          const d=await readSetupBody(req);
          if(d.action==='observe')await roomObserver.observe(d.cameraId,d.question);
          else if(d.action==='start')roomObserver.start(d.cameraId,d.interval);
          else if(d.action==='stop')roomObserver.stop();
          else if(d.action==='save')roomObserver.save(d);
          else if(d.action==='bind')roomObserver.bind(d);
          else if(d.action==='track')return json(res,roomObserver.track(d));
          else if(d.action==='bindTrack')return json(res,roomObserver.bindTrack(d));
          else if(d.action==='identifyTrack'){identity.name(d.trackId,d.pid);return json(res,roomObserver.tracking.view());}
          else if(d.action==='bindObject')return json(res,roomObserver.bindObject(d));
          else if(d.action==='acceptObjectMove'){
            if(d.source==='finder'){
              if(!roomObserver.tracking.view().running)throw Error('Start tracking to review furniture.');
              finder.accept(d.objectId,d.at);
              return json(res,roomObserver.tracking.view());
            }
            return json(res,roomObserver.acceptObjectMove(d));
          }
          else if(d.action==='trackingView')return json(res,roomObserver.tracking.view());
          else if(d.action==='serverTracking'){if(d.on)pose.start(String(d.cameraId||''));else pose.stop();return json(res,roomObserver.tracking.view());}
          else if(d.action==='stopTracking'){if(d.tracker==='server')pose.stop();return json(res,roomObserver.stopTracking(d.tracker));}
          else throw Error('Choose a Room action.');
        }
        return json(res,roomObserver.view());
      }catch(e){return json(res,{error:e.message},400);}
    }
    if(p==='/api/program-draft' && req.method==='POST') {
      if(generatingProgram)return json(res,{error:'Mother is already writing a draft. Wait for it to finish or cancel it first.'},409);
      generatingProgram=true;const controller=new AbortController();
      const disconnected=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnected);
      try {
        const input=await readSetupBody(req);
        const generated=await generateProgram(input,{signal:controller.signal,brief:readBrief()});
        if(!res.destroyed)return json(res,generated);
      }catch(e){
        if(!res.destroyed)return json(res,{error:e.name==='TimeoutError'?'Draft generation took too long. Your description is preserved; try again.':e.message},400);
      }finally{generatingProgram=false;res.removeListener('close',disconnected);}
      return;
    }
    if (p === '/api/programs') {
      try { return json(res, req.method === 'POST' ? { program:programStore.save(await readSetupBody(req)) } : { programs:programStore.list() }); }
      catch(e) { return json(res,{error:e.message},400); }
    }
    if (p === '/api/program-selection' && req.method === 'POST') {
      try {
        const d=await readSetupBody(req);
        if (d.instance !== T0) return json(res,{error:'The session changed. Reload before choosing a program.'},409);
        if (!STANDBY) throw Error('Choose the program before recording. End this session to prepare another.');
        let selected=null;
        if(d.id) {
          const snapshot=programStore.get(d.id); if(!snapshot)throw Error('That program no longer exists.');
          if(d.revision!==snapshot.revision)throw Error('The program changed. Reload the current version before choosing it.');
          const assignments={}, used=new Set();
          for(const role of snapshot.roles) {
            const phone=Number(d.assignments?.[role.id]);
            if(!Number.isInteger(phone) || phone<1 || phone>MAX_PHONES || used.has(phone))throw Error('Assign a different valid phone to every role. Add phone slots on Phones if needed.');
            assignments[role.id]=phone;used.add(phone);
          }
          selected={snapshot,assignments,timing:d.timing==='independent'?'independent':'shared'};
        }
        session.program=selected;saveSession();programRunner.configure(selected);
        return json(res,{ok:true,program:selected});
      }catch(e){return json(res,{error:e.message},400);}
    }
    if (p === '/api/program-run') {
      try {
        if(req.method==='POST') {
          const d=await readSetupBody(req);
          if(d.instance!==T0)return json(res,{error:'The session changed. Reload the desk.'},409);
          if(STANDBY)throw Error('Start recording and start the assigned participant visits before running the program.');
          if(d.action==='start')programRunner.start();
          else if(d.action==='pause')programRunner.pause();
          else if(d.action==='resume')programRunner.resume(d.phone==null?undefined:Number(d.phone));
          else if(d.action==='next')programRunner.next(Number(d.phone));
          else if(d.action==='stop')programRunner.stop();
          else throw Error('Choose a program control.');
        }
        return json(res,{instance:T0,standby:STANDBY,selection:session.program || null,run:programRunner.view()});
      }catch(e){return json(res,{error:e.message},400);}
    }
    if (p === '/api/setup') return json(res, { instance: T0, name: stamp, standby: STANDBY, title: session.title, notes: session.notes || '', documents: session.documents || [], brief: readBrief(), program: session.program || null, maxPhones: MAX_PHONES });
    if (['/api/session-meta', '/api/brief'].includes(p) && req.method === 'POST') {
      try {
        const d = await readSetupBody(req);
        if (d.instance !== T0) return json(res, { error: 'The session changed. Reload this page before saving.' }, 409);
        if (p === '/api/brief') { if (typeof d.text !== 'string') throw new Error('Enter a brief.'); saveBriefText(d.text); }
        else updateSessionMeta(d);
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (p === '/api/phones') {
      if (req.method === 'POST') {
        try {
          const d = await readSetupBody(req);
          if (d.action !== 'add') throw new Error('Choose Add phone.');
          if (MAX_PHONES >= 65535) throw new Error('All available phone slots have been added.');
          settings.phoneCount = MAX_PHONES + 1; saveSettings(); MAX_PHONES = settings.phoneCount;
          toControls({ type: 'phonesChanged', maxPhones: MAX_PHONES });
        } catch (e) { return json(res, { error: e.message }, 400); }
      }
      const devices = Array.from({ length: MAX_PHONES }, (_, i) => {
        const id = i + 1, s = sessions.get(id);
        return { device: id, url: phoneUrl(id), connected: !!s?.ws, audioReady: !!s?.ws && !!s.audioReady, waiting: s?.waiting ?? true, name: s?.name || '', hidden: !!s?.hidden, headset: s?.headset, headsetName: s?.headsetName || '' };
      });
      return json(res, { maxPhones: MAX_PHONES, devices });
    }
    if (p === '/api/phone-qr') {
      const id = Number(u.searchParams.get('device'));
      if (!Number.isInteger(id) || id < 1 || id > MAX_PHONES) return json(res, { error: 'No such phone slot.' }, 404);
      const url = phoneUrl(id);
      return json(res, { url, qr: url ? await QRCode.toString(url, { type: 'svg', margin: 2 }) : null });
    }
    if (p === '/api/info') {
      const devices = [];
      for (let i = 1; i <= MAX_PHONES; i++) devices.push({ device: i, url: phoneUrl(i) });
      const ip = lanAddress(), base = ip && `http://${ip}:${PORT}/monitor?k=${MONITOR_KEY}`;
      const screens = { local: `/monitor?k=${MONITOR_KEY}`, lan: base, items: [] };
      if (base) for (const c of [{ id: '', name: 'All cameras' }, ...cameras.map((c) => ({ id: c.id, name: c.name }))]) {
        const url = base + (c.id ? '&cam=' + c.id : '');
        screens.items.push({ id: c.id, name: c.name, url, qr: await QRCode.toString(url, { type: 'svg', margin: 1 }) });
      }
      return json(res, { maxPhones: MAX_PHONES, standby: STANDBY, instance: T0, title: session.title || '', phoneUrl: phoneUrl(), devices, session: SESSION_DIR, name: stamp, mock: ai.MOCK, cameras: cameras.map((c) => c.status()), roomMics: roomMics ? roomMics.status() : null, screens });
    }
    if (p === '/api/registry') return json(res, { list: [...registry.list].reverse().map(regView), consent: registry.consent() });
    if (p === '/api/registry-update' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const d = JSON.parse(body || '{}'), x = registry.update(d.pid, d);
      return x ? json(res, { ok: true, person: regView(x) }) : json(res, { error: 'no such registration' }, 404);
    }
    if (p === '/api/voices') return json(res, { voices: ai.VOICES.map((v) => ({ name: v.name, emotions: ai.emotionsOf(v.name) })), byPhone: settings.voices, styles: settings.styles, default: ai.VOICES[0].name });
    if (p === '/api/preview') {   // hear a voice (with emotion, pitch, speed) in the control room before choosing it
      const q = u.searchParams, parts = [];
      try {
        await ai.speak(q.get('text') || 'Walk slowly to the far wall. Tell me what you see.', (b) => parts.push(b), null,
          ai.voiceUrl(q.get('voice'), q.get('emotion')), { pitch: q.get('pitch'), speed: q.get('speed') });
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
        return res.end(require('./ai').wavBytes(Buffer.concat(parts)));
      } catch (e) { return json(res, { error: e.message }, 502); }
    }
    if (p === '/api/sessions') {
      const list = fs.existsSync(REC_ROOT) ? fs.readdirSync(REC_ROOT).filter((d) => !d.startsWith('_') && fs.existsSync(path.join(REC_ROOT, d, 'session.json'))).sort().reverse() : [];
      return json(res, list.map((d) => {
        let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(REC_ROOT, d, 'session.json'), 'utf8')); } catch {}
        return { name: d, title: s.title || '', start: s.start_iso, participants: (s.participants || []).map((x) => x.name || `Phone ${x.phone}`), duration: s.exports?.duration || null, cameras: (s.cameras || []).length, live: d === stamp };
      }));
    }
    if (p === '/api/status') return json(res, { standby: STANDBY, name: stamp, title: session.title || '', since: session.start_iso, monitorKey: MONITOR_KEY, observer:{enabled:roomObserver.enabled,busy:roomObserver.busy,cameraId:roomObserver.cameraId} });
    if (p === '/api/trash') return json(res, { items: readTrash().reverse().map((t) => ({ id: t.id, kind: t.kind, label: t.label, size: t.size, at: t.at, count: t.moves.length })) });
    if (req.method === 'POST' && ['/api/trash-restore', '/api/trash-purge', '/api/delete-session', '/api/delete-registration'].includes(p)) {
      let body = ''; for await (const c of req) body += c;
      const d = JSON.parse(body || '{}');
      try {
        if (p === '/api/trash-restore') restoreTrash(d.id);
        if (p === '/api/trash-purge') purgeTrash(d.id || null);
        if (p === '/api/delete-session') deleteSession(String(d.session || ''));
        if (p === '/api/delete-registration') deleteRegistration(d.pid);
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 400); }
    }
    const dir = sessionDirOf(u.searchParams.get('s'));
    if (!dir) return json(res, { error: 'no such session' }, 404);
    if (p === '/api/session') {
      let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); } catch {}
      let transcript = ''; try { transcript = fs.readFileSync(path.join(dir, 'transcript.txt'), 'utf8'); } catch {}
      const files = [];
      const counts = {};   // stills, sheets and proxies are counted rather than listed
      (function walk(d) { for (const f of fs.readdirSync(d)) { if (f.startsWith('.')) continue; const full = path.join(d, f), r = path.relative(dir, full); const bulk = r.match(/^catalogue\/(thumbs|sheets|proxies)\//); if (fs.statSync(full).isDirectory()) walk(full); else if (bulk) counts[bulk[1]] = (counts[bulk[1]] || 0) + 1; else files.push({ path: r, size: fs.statSync(full).size }); } })(dir);
      let catalogue = null; try { catalogue = JSON.parse(fs.readFileSync(path.join(dir, 'catalogue', 'status.json'), 'utf8')); } catch {}
      if (catalogue) catalogue.counts = counts;
      return json(res, { session: s, transcript, files, catalogue, people: path.basename(dir) === stamp ? people : readPeople(dir) });
    }
    if (p === '/api/open') { if (process.platform === 'darwin') spawn('open', [dir]); return json(res, { ok: true }); }
    if (p === '/api/delete-files' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      try { return json(res, { ok: true, deleted: deleteFiles(dir, JSON.parse(body || '{}').paths || []) }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (p === '/api/tree') {   // every file in the session folder, for the files page
      const out = [];
      (function walk(d) {
        for (const f of fs.readdirSync(d).sort()) {
          if (f.startsWith('.')) continue;
          const full = path.join(d, f), st = fs.statSync(full);
          if (st.isDirectory()) walk(full); else out.push({ path: path.relative(dir, full), size: st.size, mtime: st.mtimeMs });
        }
      })(dir);
      let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); } catch {}
      return json(res, { name: path.basename(dir), title: s.title || '', start: s.start_iso, end: s.end_iso || null, live: path.basename(dir) === stamp, folder: dir, files: out, people: path.basename(dir) === stamp ? people : readPeople(dir) });
    }
    if (p === '/api/reveal') {   // Show in Finder
      const f = path.join(dir, path.normalize(String(u.searchParams.get('f') || '')).replace(/^(\.\.[\/\\])+/, ''));
      if (!f.startsWith(dir + path.sep) || !fs.existsSync(f)) return json(res, { error: 'no such file' }, 404);
      if (process.platform === 'darwin') spawn('open', ['-R', f]);
      return json(res, { ok: true });
    }
    if (p === '/api/export') {
      if (path.basename(dir) === stamp) return json(res, { error: 'This session is still recording — it exports when you stop the server.' }, 409);
      return json(res, exportSession(dir));
    }
    if (p === '/api/upload' && req.method === 'POST') {   // documents: for the session, or for one person (release forms…)
      const live = path.basename(dir) === stamp;
      const list = live ? people : readPeople(dir);
      const pid = u.searchParams.get('pid'), who = pid && list.find((x) => x.pid === pid);
      if (pid && !who) return json(res, { error: 'no such person' }, 404);
      const sub = who ? path.join('documents', `${safeName(who.name || 'person').replace(/ /g, '_')}_${who.pid}`) : 'documents';
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
      const orig = safeName(u.searchParams.get('name'));
      let name = orig, n = 1;
      while (fs.existsSync(path.join(dir, sub, name))) name = orig.replace(/(\.[^.]*)?$/, (e) => `-${++n}${e || ''}`);
      const file = path.join(dir, sub, name);
      let size = 0, tooBig = false;
      await new Promise((ok) => {
        const out = fs.createWriteStream(file);
        req.on('data', (c) => { size += c.length; if (size > 300e6 && !tooBig) { tooBig = true; req.unpipe(out); out.destroy(); } });
        req.pipe(out); out.on('finish', ok); out.on('close', ok); req.on('error', ok);
      });
      if (tooBig) { try { fs.unlinkSync(file); } catch {} return json(res, { error: 'Files can be up to 300 MB.' }, 413); }
      const rec = { file: path.relative(dir, file), name, size, added: new Date().toISOString() };
      if (who) { who.files.push(rec); if (live) savePeople(); else writePeople(dir, list); }
      else {
        const f = path.join(dir, 'session.json'), sj = live ? session : JSON.parse(fs.readFileSync(f, 'utf8'));
        (sj.documents = sj.documents || []).push(rec);
        if (live) { saveSession(); toControls({ type: 'session', title: session.title, notes: session.notes || '', documents: session.documents }); }
        else fs.writeFileSync(f, JSON.stringify(sj, null, 2));
      }
      return json(res, { ok: true, file: rec });
    }
    if (p === '/api/link' && req.method === 'POST') {   // connect a registration to this session (and to one phone visit)
      let body = ''; for await (const c of req) body += c;
      const d = JSON.parse(body || '{}');
      try { return json(res, { ok: true, person: linkPerson(dir, d.pid, d.visit ?? -1) }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (p === '/api/unlink' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      try { unlinkPerson(dir, JSON.parse(body || '{}').pid); return json(res, { ok: true }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (p === '/api/person' && req.method === 'POST') {   // edit someone's details (works on old sessions too)
      let body = ''; for await (const c of req) body += c;
      const d = JSON.parse(body || '{}');
      if (path.basename(dir) === stamp) return json(res, { ok: true, person: upsertPerson(d) });
      const list = readPeople(dir), x = list.find((y) => y.pid === d.pid);
      if (!x) return json(res, { error: 'no such person' }, 404);
      for (const k of ['name', 'contact', 'notes']) if (typeof d[k] === 'string') x[k] = d[k].slice(0, k === 'notes' ? 4000 : 200);
      if (typeof d.release === 'boolean') x.release = d.release;
      writePeople(dir, list);
      if (typeof d.name === 'string') {
        const f = path.join(dir, 'session.json'), sj = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const v of sj.participants || []) if (v.pid === x.pid) v.name = x.name;
        fs.writeFileSync(f, JSON.stringify(sj, null, 2));
      }
      return json(res, { ok: true, person: x });
    }
    if (p === '/api/catalogue') {
      if (path.basename(dir) === stamp) return json(res, { error: 'This session is still recording — the catalogue is built when it ends.' }, 409);
      startCatalogue(dir); return json(res, { ok: true });
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
    if (!file || !file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(file).size, range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (u.searchParams.get('dl')) {
      res.writeHead(200, { 'content-type': type, 'content-length': size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
      return fs.createReadStream(file).pipe(res);
    }
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
  if (p === '/monitor') p = '/monitor.html';
  if (p === '/files') p = '/files.html';
  if (p === '/join') p = '/join.html';
  if (p === '/welcome') p = '/welcome.html';
  if (p === '/people') p = '/people.html';
  if (p === '/trash') p = '/trash.html';
  if (p === '/phones') p = '/phones.html';
  if (p === '/session') p = '/session.html';
  if (p === '/programs') p = '/programs.html';
  if (p === '/room') p = '/room.html';
  if (p === '/screens') p = '/screens.html';
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// ---------- phones ----------
const sessions = new Map();   // phone slot -> Session
const controls = new Set();
const monitors = new Set();   // camera screens: they see pictures, names and captions, and can't do anything
const FOR_MONITORS = new Set(['transcript', 'cameras', 'participants', 'state', 'session', 'marked']);
const toControls = (obj) => {
  const s = JSON.stringify(obj);
  for (const c of controls) if (c.readyState === 1) c.send(s);
  if (FOR_MONITORS.has(obj.type)) for (const c of monitors) if (c.readyState === 1) c.send(s);
};
const send = (ws, obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));
const list = () => [...sessions.values()].filter((s) => s.ws).map((s) => ({ id: s.id, name: s.name, pid: s.pid || null, mode: s.mode, waiting: s.waiting }));

// Every line gets timings on the session clock: start/end for things already spoken (participant, the
// director's own voice); AI-voiced lines get a number u, and play_start / play_end (or ai_cut) events
// record when the phone actually played them.
const at = (ms) => Number(((ms - T0) / 1000).toFixed(2));
let U = 0;
const voiceInfo = (id) => { const st = styleOf(id); return { voice: voiceOf(id), emotion: st.emotion || null, pitch: st.pitch ?? 0, speed: st.speed ?? 1 }; };
function transcript(s, who, text, extra = {}) {
  const label = who === 'participant' ? (s.name || `PHONE ${s.id}`).toUpperCase() : who.toUpperCase();
  transcriptFile.write(`[${clock()}] #${s.id} ${label}: ${text}\n`);
  logEvent('say', { id: s.id, who, text, ...extra });
  toControls({ type: 'transcript', id: s.id, who, text, t: clock() });
}
function state(s) {
  toControls({ type: 'state', id: s.id, audioReady: !!s.audioReady, mode: s.mode, speaking: s.speaking, thinking: s.thinking, listening: s.vad.speaking, held: s.edHold, hidden: !!s.hidden, voice: voiceOf(s.id), style: styleOf(s.id), headset: s.headset, headsetDropped: !!s.headsetDropped, headsetName: s.headsetName, waiting: s.waiting, name: s.name });
}
function report(s, err) {
  console.error(`  #${s.id} ${err.message}`);
  logEvent('error', { id: s.id, message: err.message });
  toControls({ type: 'error', id: s.id, text: err.message });
}

class Session {
  constructor(id) {
    this.id = id; this.ws = null; this.name = ''; this.mode = DEFAULT_MODE; this.waiting = true; this.visitToken = null;
    this.history = []; this.speaking = false; this.thinking = false; this.again = false;
    this.edHold = false; this.lastActivity = Date.now(); this.turn = 0;
    this.pending = Buffer.alloc(0); this.ttsDone = true; this.playT0 = 0; this.playSent = 0; this.abort = null;
    this.vad = new ai.Vad({
      onStart: () => { if (this.speaking && (this.mode === 'auto' || programRunner?.manages(this.id))) stopAi(this, 'participant interrupted'); state(this); },
      onUtterance: (pcm) => {   // pcm = 300 ms pre-roll + speech + 800 ms of quiet
        if (this.waiting) return;
        const now = Date.now(), dur = pcm.length / 2 / RATE;
        heard(this, pcm, { start: at(now - (dur - 0.24) * 1000), end: at(now - 800) });
      }
    });
  }
}

async function heard(s, pcm, when = {}) {
  const visit = s.visitToken, programToken=programRunner?.token(s.id);
  if (s.waiting || !visit) return;
  state(s);
  let text;
  try { text = (await ai.transcribe(pcm)).trim(); }
  catch (e) { if (s.visitToken === visit && !s.waiting) report(s, e); return; }
  if (!text || text.replace(/[^a-z]/gi, '').length < 2 || s.waiting || s.visitToken !== visit) return;
  transcript(s, 'participant', text, when);
  s.history.push({ role: 'user', content: `Participant: "${text}"` });
  s.lastActivity = Date.now();
  if (programRunner?.manages(s.id)) { if(!s.edHold && programRunner.token(s.id)===programToken) programRunner.reply(s.id,text); return; }
  if (s.mode === 'auto' && !s.edHold) aiTurn(s);
}

function systemPrompt(s) {
  let brief = ''; try { brief = fs.readFileSync(BRIEF_FILE, 'utf8'); } catch {}
  const el = Math.floor((Date.now() - (s.startedAt || Date.now())) / 1000);
  return `${brief}\n\n---\nParticipant's name: ${s.name || 'unknown'}. Time since they started: ${Math.floor(el / 60)}m ${el % 60}s.\n` +
    `Lines in square brackets are stage information from the system, not speech. ` +
    `Lines marked as the human director are things a person in the control room said to the participant directly; stay consistent with them.` + roomObserver.prompt();
}

async function aiTurn(s) {
  if (programRunner?.manages(s.id)) return;
  if (s.hidden || s.waiting || s.headsetDropped) return;
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
  const u = ++U;
  transcript(s, 'ai', reply, { u, ...voiceInfo(s.id) });
  say(s, reply, turn, u);
}

function say(s, text, turn, u) {
  s.speaking = true; s.ttsDone = false; s.vad.strict = true; s.playU = u; s.playStarted = false;
  s.abort = new AbortController();
  state(s);
  ai.speak(text, (pcm) => { if (turn === s.turn) s.pending = Buffer.concat([s.pending, pcm]); }, s.abort.signal, ai.voiceUrl(voiceOf(s.id), styleOf(s.id).emotion), styleOf(s.id))
    .catch((e) => { if (s.programDone && turn===s.turn) {const pending=s.programDone;s.programDone=null;pending.reject(e);} if (e.name !== 'AbortError') report(s, e); })
    .finally(() => { if (turn === s.turn) s.ttsDone = true; });
}

function stopAi(s, why, programInternal = false) {
  if (!programInternal && programRunner?.manages(s.id)) programRunner.hold(s.id,why,['participant interrupted','human director cut in'].includes(why));
  if(s.programDone){const pending=s.programDone;s.programDone=null;pending.reject(Error(why));}
  s.turn++;
  if (s.abort) s.abort.abort();
  const wasSpeaking = s.speaking;
  s.pending = Buffer.alloc(0); s.speaking = false; s.ttsDone = true; s.thinking = false; s.playT0 = 0; s.vad.strict = false;
  send(s.ws, { type: 'flush' });
  if (wasSpeaking) {
    const last = s.history[s.history.length - 1];
    if (last && last.role === 'assistant') last.content += ' [cut off: ' + why + ']';
    logEvent('ai_cut', { id: s.id, why, u: s.playU, played: !!s.playStarted });
  }
}

function beginParticipant(s, name, pid) {
  if (STANDBY) {   // nobody starts until the session is recording
    send(s.ws, { type: 'reset' });
    toControls({ type: 'error', id: 0, text: `Phone ${s.id}: not recording yet — press Start session first.` });
    return false;
  }
  if (!s.waiting) endParticipant(s, 'new participant');
  // the person record: given by the control room, or matched by name to someone added but not started yet
  let who = pid && personBy(pid);
  if (!who) who = people.find((x) => x.next === s.id && !x.visits.some((v) => v.end == null));   // assigned to this phone
  if (!who && name) who = people.find((x) => x.name.toLowerCase() === name.toLowerCase() && !x.visits.length);
  if (!who) who = upsertPerson({ name: name || '' });
  if (!who.name && name) who.name = name;
  who.visits.push({ phone: s.id, start: Number(clock()) }); who.next = null; savePeople();
  s.pid = who.pid; s.visitToken = crypto.randomUUID(); s.vad.reset();
  s.waiting = false; s.name = who.name || name || ''; s.history = []; s.startedAt = Date.now(); s.lastActivity = Date.now();
  send(s.ws, { type: 'welcome', id: s.id, waiting: false, name: s.name });
  logEvent('participant_start', { id: s.id, name: s.name, pid: who.pid });
  session.participants.push({ phone: s.id, name: s.name, pid: who.pid, start: Number(clock()) }); saveSession();
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
  if (talk) { talk.targets.delete(s.id); talk.visits.delete(s.id); }
  s.edHold = false;
  logEvent('participant_end', { id: s.id, name: s.name, pid: s.pid, why });
  const rec = [...session.participants].reverse().find((x) => x.phone === s.id && x.end == null);
  if (rec) { rec.end = Number(clock()); saveSession(); }
  const who = s.pid && personBy(s.pid), v = who && [...who.visits].reverse().find((x) => x.phone === s.id && x.end == null);
  if (v) { v.end = Number(clock()); savePeople(); }
  s.waiting = true; s.history = []; s.pid = null; s.visitToken = null; s.vad.reset();
  send(s.ws, { type: 'reset' });
  toControls({ type: 'participants', list: list() }); state(s);
}

function programContext(id, context) {
  const s=sessions.get(id);
  return `${systemPrompt(s)}\nYou are performing Mother program: ${context.program.title}.\nOverall score: ${context.program.description}\nYour role: ${context.role.name}. ${context.role.brief}\nScene: ${context.scene?.name || 'end'}. Current cue: ${context.cue?.text || ''}. Delivery: ${context.cue?.delivery || ''}\nOnly direct this participant. Never invent another participant's readiness. Respect the script's coordination cues. Stage instructions are private; speak only the words intended for the earpiece.`;
}
async function programSpeech(id,cue,context) {
  const s=sessions.get(id);if(!s)throw Error('Phone unavailable.');
  stopAi(s,'program cue',true); const turn=++s.turn;
  let text=cue.text;
  if(cue.adapt){s.thinking=true;state(s);text=await ai.think([{role:'system',content:programContext(id,context)},...s.history.slice(-20),{role:'user',content:`Deliver this passage, preserving its actions and essential meaning. You may adapt wording. Return only spoken text: ${cue.text}`}]);}
  if(turn!==s.turn || s.waiting || !s.ws || s.edHold)throw Error('Cue interrupted.');
  text=String(text).trim().slice(0,6000); if(!text || /^\[?silence\]?$/i.test(text))throw Error('Mother returned no spoken passage. Repeat or advance this cue.');
  s.thinking=false;s.history.push({role:'assistant',content:text});
  const u=++U;transcript(s,'ai',text,{u,...voiceInfo(s.id)});
  return new Promise((resolve,reject)=>{s.programDone={resolve,reject};say(s,text,turn,u);});
}
programRunner=new ProgramRunner({
  ready:id=>{const s=sessions.get(id);return !!s?.ws && s.ws.readyState===1 && !s.waiting && !!s.audioReady && !s.hidden && !s.headsetDropped && s.headset!==false && !s.edHold;},
  visit:id=>sessions.get(id)?.visitToken,
  cancel:id=>{const s=sessions.get(id);if(s)stopAi(s,'program paused',true);},
  perform:programSpeech,
  converse:(id,text,context)=>ai.think([{role:'system',content:programContext(id,context)+`\nThis is a bounded conversation (${context.exchanges+1} of ${context.cue.turns}). Respond briefly within the cue's subject. On the final exchange, finish naturally so the script can continue. Return spoken words only.`},...sessions.get(id).history.slice(-20)]),
  decide:async(id,text,context)=>{
    const raw=await ai.think([{role:'system',content:programContext(id,context)+'\nAfter an interruption choose when to return. Return ONLY JSON: {"action":"resume"|"wait"|"respond","text":"optional spoken response","reason":"short desk explanation"}. Resume repeats the current cue from its beginning. Respond asks or answers briefly then waits for the participant. Wait silently awaits their reply. After two exchanges prefer resume. Do not direct any other role.'},...sessions.get(id).history.slice(-20),{role:'user',content:`${context.director?'Controller intervention':'Participant reply'}: ${text}`}]);
    const decision=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));
    if(!['resume','wait','respond'].includes(decision.action) || (decision.action==='respond' && !String(decision.text || '').trim()))throw Error('Mother could not decide how to return. Choose Repeat cue or Continue cue at the desk.');
    return {action:decision.action,text:String(decision.text || '').slice(0,2000),reason:String(decision.reason || '').slice(0,300)};
  },
  event:(type,data)=>logEvent(type,data),change:run=>toControls({type:'program',run})
});
programRunner.configure(session.program || null);
setInterval(()=>programRunner.tick(),50);

// plays queued AI audio to the phone in real time (a little ahead, so the phone never runs dry)
const FRAME = RATE * 0.02 * 2;
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.speaking) continue;
    if (!s.playT0) {
      if (s.pending.length < RATE * 0.3 * 2 && !s.ttsDone) continue;
      s.playT0 = now; s.playSent = 0;
      if (!s.playStarted) { s.playStarted = true; logEvent('play_start', { id: s.id, u: s.playU }); }
    }
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
      if (s.playStarted) logEvent('play_end', { id: s.id, u: s.playU });
      s.playStarted = false;
      if(s.programDone){const pending=s.programDone;s.programDone=null;pending.resolve();}
      if (s.again && s.mode === 'auto' && !s.edHold) setTimeout(() => aiTurn(s), 300);
    }
  }
}, 20);

// keeps the AI directing when nothing is happening
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (programRunner?.manages(s.id) || !s.ws || s.hidden || s.headsetDropped || s.waiting || s.mode !== 'auto' || s.speaking || s.thinking || s.edHold || s.vad.speaking) continue;
    if (now - s.lastActivity > IDLE_SECS * 1000) {
      s.lastActivity = now;
      s.history.push({ role: 'user', content: `[No reply from the participant for ${IDLE_SECS} seconds. Continue directing.]` });
      aiTurn(s);
    }
  }
}, 1000);

// camera status to the control room
setInterval(() => toControls({ type: 'cameras', list: cameras.map((c) => c.status()) }), 2000);
if (roomMics) setInterval(() => toControls({ type: 'room', room: roomMics.status() }), 250);

// ---------- human director talk ----------
// Speaks text word-for-word in the phone's chosen AI voice (typed lines, and the director's speech in "AI voice" mode).
function speakAs(t, text, who) {
  if (!t || !t.ws) return;
  stopAi(t, 'director ' + who);
  const turn = ++t.turn;
  t.history.push({ role: 'assistant', content: text + ' [these words came from the human director and were spoken in your voice]' });
  const u = ++U;
  transcript(t, who, text, { u, ...voiceInfo(t.id) });
  t.lastActivity = Date.now();
  say(t, text, turn, u);
}

let talk = null;
function talkStart(target, as, owner) {
  if (!Number.isInteger(target) || target < 0 || target > MAX_PHONES) return;
  if (talk && talk.owner !== owner) return;   // another desk connection owns this talk
  if (talk) talkStop(owner);
  talk = { owner, target, targets: new Set(), visits: new Map(), programTokens:new Map(), pcm: [], as: as === 'voice' ? 'voice' : 'own', t0: Date.now() };
  for (const s of sessions.values()) {
    if (!s.ws || (target !== 0 && target !== s.id)) continue;
    talk.targets.add(s.id); talk.visits.set(s.id, s.visitToken); stopAi(s, 'human director cut in'); talk.programTokens.set(s.id,programRunner.token(s.id)); s.edHold = true; state(s);
  }
}
async function talkStop(owner) {
  if (!talk || talk.owner !== owner) return;
  const t = talk; talk = null; t.t1 = Date.now();
  for (const id of t.targets) { const s = sessions.get(id); if (s) { s.edHold = false; s.lastActivity = Date.now(); state(s); } }
  if (!t.pcm.length) return;
  let text = '';
  try { text = (await ai.transcribe(Buffer.concat(t.pcm))).trim(); } catch (e) { return console.error('  director transcription: ' + e.message); }
  if (!text) return;
  for (const id of t.targets) {
    const s = sessions.get(id);
    if (!s || s.waiting || s.visitToken !== t.visits.get(id)) continue;
    if(programRunner.manages(id) && programRunner.token(id)!==t.programTokens.get(id))continue;
    if (t.as === 'voice') {
      if(programRunner.manages(id) && programRunner.status==='running'){
        const role=programRunner.roles.find(r=>r.phone===id);
        const token=programRunner.token(id);
        programSpeech(id,{type:'speak',text,adapt:false},{...programRunner.current(role),program:programRunner.selection.snapshot})
          .then(()=>{if(programRunner.token(id)===token)return programRunner.reply(id,text,true);})
          .catch(e=>{if(programRunner.token(id)===token)programRunner.hold(id,e.message);});
      } else speakAs(s, text, 'voiced');
      continue;
    }
    transcript(s, 'director', text, { start: at(t.t0), end: at(t.t1) });
    s.history.push({ role: 'user', content: `[The human director spoke to the participant directly: "${text}"]` });
    if(programRunner.manages(id))programRunner.reply(id,text,true);
  }
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
const freeId = (w) => {
  if (w && (!Number.isInteger(w) || w < 1 || w > MAX_PHONES)) return 0;
  const busy = (i) => sessions.get(i)?.ws;
  if (w >= 1 && w <= MAX_PHONES && !busy(w)) return w;
  if (w >= 1 && w <= MAX_PHONES) { const old = sessions.get(w).ws; old.close(4000, 'replaced'); return w; }   // a dedicated phone reclaims its slot
  for (let i = 1; i <= MAX_PHONES; i++) if (!busy(i)) return i;
  return 0;
};

wss.on('connection', (ws, req) => {
  // Protocol errors can arrive before authentication (including in the upgrade's first frame).
  ws.on('error', (err) => { console.error('  ! WebSocket error: ' + err.message); ws.terminate(); });
  const u = new URL(req.url, 'http://x');
  const role = u.searchParams.get('role'), key = u.searchParams.get('k');
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));

  if (role === 'control' && key === CONTROL_KEY) {
    controls.add(ws);
    send(ws, { type: 'phonesChanged', maxPhones: MAX_PHONES });
    send(ws,{type:'program',run:programRunner.view()});
    send(ws, { type: 'participants', list: list() });
    send(ws, { type: 'people', list: people });
    send(ws, { type: 'registry', list: recentRegs() });
    send(ws, { type: 'session', title: session.title, notes: session.notes || '', documents: session.documents || [] });
    for (const s of sessions.values()) if (s.ws) state(s);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data);
        if (buf.length < 4 || buf.length % 2) return;
        const target = buf.readUInt16LE(0), pcm = buf.subarray(2);
        if (!talk || talk.owner !== ws || talk.target !== target) return;
        talk.pcm.push(pcm);
        track('director-mic').write(pcm);
        if (talk.as === 'voice') return;   // AI-voice mode: they hear it after transcription, in the AI voice
        for (const id of talk.targets) {
          const s = sessions.get(id);
          if (!s || s.visitToken !== talk.visits.get(id)) continue;
          if (s.ws && s.ws.readyState === 1) s.ws.send(pcm);
          track(`phone${id}-heard`).write(pcm);
        }
        return;
      }
      let m; try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      const s = sessions.get(m.id);
      if (m.type === 'talk') { logEvent(m.on ? 'talk_start' : 'talk_stop', { target: m.target, as: m.as }); if (m.on) talkStart(m.target, m.as, ws); else talkStop(ws); }
      if (m.type === 'endSession' && !STANDBY) { toControls({ type: 'sessionEnding' }); shutdown(true); }
      if (m.type === 'startSession' && STANDBY) { toControls({ type: 'sessionStarting' }); shutdown('record'); }
      if (m.type === 'mode' && s) { s.mode = m.mode === 'auto' ? 'auto' : 'off'; if (s.mode === 'off') stopAi(s, 'AI switched off'); s.lastActivity = Date.now(); logEvent('mode', { id: s.id, mode: s.mode }); state(s); toControls({ type: 'participants', list: list() }); }
      if(m.type==='nudge' && s && programRunner.manages(s.id)){try{programRunner.next(s.id);}catch(e){send(ws,{type:'error',id:0,text:e.message});}return;}
      if (m.type === 'nudge' && s && !s.waiting) { s.history.push({ role: 'user', content: '[Give the next direction now.]' }); logEvent('nudge', { id: s.id }); if (s.mode !== 'auto') { s.mode = 'auto'; state(s); } aiTurn(s); }
      if (m.type === 'end' && s) endParticipant(s, 'ended by director');
      if (m.type === 'voice') {   // id 0 = every phone. Any of voice / emotion / pitch / speed.
        const ids = m.id ? [m.id] : Array.from({ length: MAX_PHONES }, (_, i) => i + 1);
        for (const id of ids) {
          if (m.voice && ai.VOICES.some((v) => v.name === m.voice)) settings.voices[id] = m.voice;
          const st = { ...styleOf(id) };
          if (m.emotion) st.emotion = String(m.emotion);
          if (m.pitch != null) st.pitch = Math.max(-8, Math.min(8, Number(m.pitch) || 0));
          if (m.speed != null) st.speed = Math.max(0.6, Math.min(1.6, Number(m.speed) || 1));
          settings.styles[id] = st;
        }
        saveSettings(); logEvent('voice', { id: m.id || 'all', voice: m.voice, emotion: m.emotion, pitch: m.pitch, speed: m.speed });
        for (const t of sessions.values()) state(t);
      }
      if (m.type === 'speak' && m.text) {   // typed by the director, spoken word for word in the AI's voice
        const text = String(m.text).trim().slice(0, 600);
        for (const t of (m.id ? [sessions.get(m.id)] : [...sessions.values()])) speakAs(t, text, 'typed');
      }
      if (m.type === 'mark') { logEvent('mark', { text: String(m.text || 'Mark').slice(0, 200) }); toControls({ type: 'marked', t: clock(), text: m.text || 'Mark' }); }
      if (m.type === 'instruct' && s && m.text && !s.waiting) {
        logEvent('instruct', { id: s.id, text: m.text });
        toControls({ type: 'transcript', id: s.id, who: 'note', text: '→ AI: ' + m.text, t: clock() });
        transcriptFile.write(`[${clock()}] #${s.id} PRIVATE NOTE TO AI: ${m.text}\n`);
        s.history.push({ role: 'user', content: `[Private instruction from the human director — the participant did not hear this. Act on it now, in your own words: ${m.text}]` });
        if (s.mode !== 'auto') { s.mode = 'auto'; state(s); }
        stopAi(s, 'new instruction'); aiTurn(s);
      }
      if (m.type === 'sessionMeta') {
        updateSessionMeta(m);
      }
      if (m.type === 'personSave') { const x = upsertPerson(m); send(ws, { type: 'personSaved', pid: x.pid, ref: m.ref }); }
      if (m.type === 'personDelete') {
        const x = personBy(m.pid);
        if (x && !x.visits.length && x.registered) {   // added by mistake: take them off, and the copies of their photo and consent
          try {
            unlinkPerson(SESSION_DIR, x.pid);
            const dir = path.join(SESSION_DIR, 'documents', `${safeName(x.name || 'person').replace(/ /g, '_')}_${x.pid}`);
            if (x.photo && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            toControls({ type: 'people', list: people });
          } catch (e) { send(ws, { type: 'error', id: 0, text: e.message }); }
        } else if (x && !x.visits.length && !x.files.length) { people = people.filter((y) => y !== x); savePeople(); }
      }
      if (m.type === 'arrivalAdd' || m.type === 'arrivalStart') {   // someone who registered at the welcome station
        try {
          const t = m.type === 'arrivalStart' && sessions.get(Number(m.phone));
          if (m.type === 'arrivalStart' && !(t && t.ws)) throw new Error('That phone isn\'t connected.');
          const x = linkPerson(SESSION_DIR, m.pid, -1, STANDBY ? 'added to the next session' : t ? 'on phone ' + t.id : 'added in the control room');
          if (m.type === 'arrivalAdd' && m.phone) upsertPerson({ pid: x.pid, next: m.phone });
          if (t) beginParticipant(t, x.name, x.pid);
        } catch (e) { send(ws, { type: 'error', id: Number(m.phone) || 0, text: e.message }); }
      }
      if (m.type === 'linkRegistration') {   // a walk-in's card in this session → their registration (merges their phone visit)
        try {
          const old = personBy(m.pid);
          const vi = session.participants.findIndex((v) => v.pid === m.pid);
          if (vi >= 0) linkPerson(SESSION_DIR, m.rid, vi, 'linked in the control room');
          else {
            linkPerson(SESSION_DIR, m.rid, -1, STANDBY ? 'added to the next session' : 'linked in the control room');
            if (old && !old.visits.length && !old.registered && old.pid !== m.rid) {
              const x = personBy(m.rid);
              if (old.notes && !x.notes.includes(old.notes)) x.notes = [x.notes, old.notes].filter(Boolean).join('\n');
              for (const f of old.files) if (!x.files.find((y) => y.file === f.file)) x.files.push(f);
              people = people.filter((y) => y !== old); savePeople();
            }
          }
        } catch (e) { send(ws, { type: 'error', id: 0, text: e.message }); }
      }
      if (m.type === 'personStart') {   // start someone on a phone from here, instead of the phone's own screen
        const x = personBy(m.pid), t = sessions.get(Number(m.phone));
        if (x && t && t.ws) {
          beginParticipant(t, x.name, x.pid);   // takes the phone past its start screen
        } else send(ws, { type: 'error', id: Number(m.phone) || 0, text: 'That phone isn\'t connected.' });
      }
      if (m.type === 'getBrief') { let b = ''; try { b = fs.readFileSync(BRIEF_FILE, 'utf8'); } catch {} send(ws, { type: 'brief', text: b }); }
      if (m.type === 'saveBrief' && typeof m.text === 'string') {
        saveBriefText(m.text);
      }
    });
    ws.on('close', () => { controls.delete(ws); talkStop(ws); });
    return;
  }

  if (role === 'monitor' && (key === MONITOR_KEY || key === CONTROL_KEY)) {
    monitors.add(ws);
    send(ws, { type: 'cameras', list: cameras.map((c) => c.status()) });
    send(ws, { type: 'participants', list: list() });
    send(ws, { type: 'session', title: session.title });
    ws.on('close', () => monitors.delete(ws));
    return;
  }
  if (role === 'phone' && key === PHONE_KEY) {
    const id = freeId(Number(u.searchParams.get('device') || u.searchParams.get('id')));
    if (!id) { send(ws, { type: 'full' }); return ws.close(); }
    let s = sessions.get(id);
    if (!s) { s = new Session(id); sessions.set(id, s); }
    s.ws = ws; s.hidden = false; s.audioReady = false;
    send(ws, { type: 'welcome', id, waiting: s.waiting, name: s.name });
    logEvent('phone_connected', { id });
    toControls({ type: 'participants', list: list() });
    ws.on('message', (data, isBinary) => {
      if (s.ws !== ws) return;   // ignore frames from a phone whose slot has been replaced
      if (isBinary) {
        const pcm = Buffer.from(data);
        if (pcm.length && pcm.length % 2 === 0 && !s.audioReady) { s.audioReady = true; state(s); }
        // The desk starts/ends each visit. A connected phone alone does not enable its microphone feed.
        if (STANDBY || s.waiting || !pcm.length || pcm.length % 2) return;
        track(`phone${id}-mic`).write(pcm);
        s.vad.push(pcm);
        const out = Buffer.alloc(pcm.length + 2); out.writeUInt16LE(id, 0); pcm.copy(out, 2);
        for (const c of controls) if (c.readyState === 1) c.send(out);
        return;
      }
      let m; try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      // Phones are desk equipment: only the control room can start a participant visit.
      if (m.type === 'hello') { s.audioReady = true; state(s); }
      if (m.type === 'hello' && !s.waiting && s.mode === 'auto') {   // came back after a dropout
        s.history.push({ role: 'user', content: '[The participant reconnected after a dropout. Pick up where you left off, briefly.]' });
        setTimeout(() => aiTurn(s), 1200);
      }
      if (m.type === 'headset') {   // native app: the participant's earpiece came or went (e.g. walked out of Bluetooth range)
        const was = s.headset; s.headset = !!m.connected; s.headsetName = String(m.name || '');
        s.headsetDropped = was === true && !s.headset ? true : (s.headset ? false : s.headsetDropped);
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
  console.log('\n  MOTHER' + (ai.MOCK ? '  (MOCK AI)' : ''));
  console.log(STANDBY ? '  STANDBY — nothing is recording. Prepare the next session, then press Start session in the control room.' : '  RECORDING — session folder: ' + SESSION_DIR);
  if (!ai.MOCK && !process.env.OPENAI_API_KEY) console.log('  ! no OPENAI_API_KEY in .env — the AI will not work');
  if (!ai.MOCK) {
    try { await fetch((process.env.POCKET_TTS_URL || 'http://localhost:8123').replace(/\/+$/, '') + '/', { signal: AbortSignal.timeout(2000) }); console.log('  voice: Watercooler (Pocket-TTS) reachable'); }
    catch { console.log('  ! Watercooler voice server not reachable on :8123 — see README'); }
  }
  console.log(cameras.length ? `  cameras: ${cameras.map((c) => c.name).join(', ')}` : '  cameras: none (add them in cameras.json)');
  for (const c of cameras) c.start();
  console.log(roomMics ? `  room mics: ${roomCfg.names.join(', ')} (${roomCfg.device})` : '  room mics: none (add them in roommics.json)');
  if (roomMics && !STANDBY) roomMics.start();
  console.log('\n  CONTROL ROOM (open on this computer, use headphones):\n  ' + controlUrl);
  console.log('  LIBRARY: http://localhost:' + PORT + '/library?k=' + CONTROL_KEY);
  if (process.platform === 'darwin' && !process.env.NO_OPEN) spawn('open', [controlUrl]);
  if (process.env.PUBLIC_URL) announce(process.env.PUBLIC_URL);
  else if (!process.env.NO_TUNNEL) startQuickTunnel();
  logEvent('session_start', { prepared: adopted });
});

// ---------- catalogue: built in the background after a session (see catalogue.js) ----------
function startCatalogue(dir) {
  fs.mkdirSync(path.join(dir, 'catalogue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalogue', 'status.json'), JSON.stringify({ state: 'running', step: 'queued', started: new Date().toISOString() }));
  const log = fs.openSync(path.join(dir, 'catalogue', 'log.txt'), 'a');
  const cmd = process.platform === 'win32' ? [process.execPath, [path.join(__dirname, 'catalogue.js'), dir]] : ['nice', ['-n', '10', process.execPath, path.join(__dirname, 'catalogue.js'), dir]];
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.on('error', () => {}); child.unref();
}

// ---------- shutdown: close everything, convert video, write exports ----------
async function shutdown(restart) {
  roomObserver.stop();
  if (closing) return; closing = true;
  if (STANDBY) {   // nothing to save but the preparation; let the cameras go so the recording can open them
    for (const c of wss.clients) { try { c.close(1012, restart === 'record' ? 'session starting' : 'stopping'); } catch {} }
    for (const c of cameras) c.stop();
    await new Promise((r) => { const t0 = Date.now(); const check = () => (cameras.every((c) => !c.prev || c.prev.exitCode !== null || c.prev.signalCode) || Date.now() - t0 > 5000) ? r() : setTimeout(check, 100); check(); });
    if (restart === 'record') console.log('\n  — starting the session —\n');
    process.exit(restart === 'record' ? 76 : 0);   // 76 = start recording (see run.js)
  }
  for (const c of wss.clients) { try { c.close(1012, 'session ending'); } catch {} }
  console.log('\n  stopping — finishing recordings…');
  for (const s of sessions.values()) endParticipant(s, 'session ended');
  logEvent('session_end');
  for (const t of tracks.values()) t.close();
  for (const c of cameras) c.stop();
  if (roomMics) roomMics.stop();
  const done = (p) => !p || p.exitCode !== null || p.signalCode;
  await new Promise((r) => {   // let ffmpeg close its files
    const t0 = Date.now();
    const check = () => ((cameras.every((c) => [c.rec, c.prev].every(done)) && (!roomMics || roomMics.closed())) || Date.now() - t0 > 8000) ? r() : setTimeout(check, 200);
    check();
  });
  if (cameras.length) console.log('  converting video for the editor…');
  const clips = cameras.flatMap((c) => c.finalize());
  session.video = clips.map((c) => ({ ...c, file: path.relative(SESSION_DIR, c.file) }));
  const room = roomMics ? roomMics.finalize() : [];
  session.room_audio = room.map((r) => ({ ...r, file: path.relative(SESSION_DIR, r.file) }));
  session.end_iso = new Date().toISOString();
  saveSession();
  await new Promise((r) => events.end(r));
  transcriptFile.end();
  try {
    const ex = exportSession(SESSION_DIR, clips);
    console.log(`  exports written: timeline.fcpxml, markers.csv (${ex.markers})${ex.subtitles.length ? ', ' + ex.subtitles.join(', ') : ''}`);
  } catch (e) { console.log('  ! export failed: ' + e.message); }
  if (process.env.NO_CATALOGUE !== '1') { try { startCatalogue(SESSION_DIR); console.log('  building the catalogue in the background — progress shows in the library'); } catch (e) { console.log('  ! catalogue: ' + e.message); } }
  console.log('\n  saved: ' + SESSION_DIR + '\n');
  process.exit(restart === true ? 75 : 0);   // 75 = back to standby (see run.js)
}
process.on('SIGINT', () => shutdown(false));
process.on('SIGTERM', () => shutdown(false));
