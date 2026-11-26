// Sound library: audio tracks uploaded from the desk, played into participants' ears on top of Mother's voice.
//
// Uploads are converted once to a light MP3 (every phone browser plays it) and kept in sounds/ with a small
// index (sounds.json). Phones fetch the file and play it themselves, so a track mixes with the live voice
// instead of queueing behind it. The beep needs no file: phones make it.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BEEP = { id: 'beep', name: 'Beep', builtIn: true, duration: 0.25 };
const MAX_BYTES = 200e6;

function run(cmd, args) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => ok({ code: -1, out, err: e.message }));
    p.on('close', (code) => ok({ code, out, err }));
  });
}

class Sounds {
  constructor(dir, { now = () => Date.now(), ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
    this.dir = dir; this.now = now; this.ffmpeg = ffmpeg; this.ffprobe = ffprobe;
    this.index = path.join(dir, 'sounds.json');
    this.items = [];
    try { this.items = JSON.parse(fs.readFileSync(this.index, 'utf8')).filter((x) => x && x.id && x.file); } catch {}
  }
  save() { fs.mkdirSync(this.dir, { recursive: true }); const tmp = this.index + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2)); fs.renameSync(tmp, this.index); }
  list() { return [BEEP, ...this.items.map(({ id, name, duration, size, addedAt, addedBy }) => ({ id, name, duration, size, addedAt, addedBy }))]; }
  get(id) { return id === 'beep' ? BEEP : this.items.find((x) => x.id === id) || null; }
  // The file on disk for a sound id, or null. Only files this library wrote are ever served.
  file(id) { const x = this.items.find((s) => s.id === id); return x ? path.join(this.dir, x.file) : null; }

  // Converts an uploaded file (any format ffmpeg reads) and adds it to the library.
  async add(name, src, by = '') {
    const label = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'Sound';
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sound';
    let id = slug, n = 1;
    while (id === 'beep' || this.items.some((x) => x.id === id)) id = `${slug}-${++n}`;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = id + '.mp3', out = path.join(this.dir, file);
    const r = await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '2', '-ar', '44100', '-b:a', '160k', out]);
    if (r.code !== 0 || !fs.existsSync(out)) { try { fs.unlinkSync(out); } catch {} throw Error('Could not read that file as audio.'); }
    const probe = await run(this.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
    const duration = Math.round(parseFloat(probe.out) * 10) / 10 || null;
    const item = { id, name: label, file, duration, size: fs.statSync(out).size, addedAt: new Date(this.now()).toISOString(), ...(by ? { addedBy: by } : {}) };
    this.items.push(item); this.save();
    return item;
  }
  remove(id) {
    const x = this.items.find((s) => s.id === id);
    if (!x) throw Error(id === 'beep' ? 'The beep is built in.' : 'No such sound.');
    try { fs.unlinkSync(path.join(this.dir, x.file)); } catch {}
    this.items = this.items.filter((s) => s !== x); this.save();
    return x;
  }
}

// What is playing on each phone, so the desk can show it and stop it. Pure state, no sockets.
class Playing {
  constructor(now = () => Date.now()) { this.now = now; this.byPhone = new Map(); }   // phone -> Map(soundId -> {loop, since, by})
  start(phone, id, loop, by) {
    if (!this.byPhone.has(phone)) this.byPhone.set(phone, new Map());
    this.byPhone.get(phone).set(id, { loop: !!loop, since: this.now(), by });
  }
  stop(phone, id) {   // id omitted: everything on that phone
    const m = this.byPhone.get(phone); if (!m) return;
    if (id) m.delete(id); else m.clear();
    if (!m.size) this.byPhone.delete(phone);
  }
  // Non-looping sounds end on their own: drop them once their length has passed (phones also report it).
  expire(lengthOf) {
    const t = this.now();
    for (const [phone, m] of this.byPhone) for (const [id, x] of m) if (!x.loop && t - x.since > ((lengthOf(id) || 0) + 2) * 1000) this.stop(phone, id);
  }
  view() { return [...this.byPhone].flatMap(([phone, m]) => [...m].map(([id, x]) => ({ phone, id, loop: x.loop, since: x.since, by: x.by }))); }
}

module.exports = { Sounds, Playing, BEEP, MAX_BYTES };
