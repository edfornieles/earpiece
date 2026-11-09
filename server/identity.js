// Who is who in the room: recognises registered people (face matching agreed) in the tracking
// camera and names their person track ("Ed Fornieles #1"). Runs on this computer.
//
// - Faces are read from the camera's full-resolution stream (about once a second) when it has one,
//   because people seen from a corner camera are small; otherwise from the live preview.
// - A face is tied to the person track whose box contains it (upper half of the body box). A name
//   sticks to the track as the person moves or turns away, and moves only on a new confident match.
// - Learning: when a track is named (by a confident match or by the desk choosing a registered person),
//   new views of that face as this camera sees it are saved to participants/<pid>/face-templates.json,
//   so the person is recognised more easily from the side and from above. Only for people who agreed.
// - Everyone else: faces are compared and then discarded. Nothing about them is kept.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MATCH_EVERY_MS = 1000, CONFIRM_HITS = 2, CONFIRM_WITHIN_MS = 6000;
const LEARN_MIN_SCORE = 0.5, LEARN_DIFFERENT_BELOW = 0.9, MAX_TEMPLATES = 40;
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

class Identity {
  constructor({ root, registry, cameras, tracking, log = () => {}, spawnImpl = spawn }) {
    Object.assign(this, { root, registry, cameras, tracking, log, spawnImpl });
    this.py = path.join(root, '.faces-venv', 'bin', 'python');
    this.ready = fs.existsSync(this.py) && fs.existsSync(path.join(root, 'models', 'face_recognition_sface_2021dec.onnx'));
    this.enrolled = new Map(); this.failed = new Map(); this.pending = new Map(); this.hits = new Map();
    this.recent = []; this.seq = 0; this.busy = false; this.full = null;
    if (this.ready) this.start();
  }
  start() {
    this.proc = this.spawnImpl(this.py, [path.join(this.root, 'face_worker.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin?.on?.('error', () => {});   // the worker may exit first, e.g. while the server shuts down
    let buf = '';
    this.proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { this.onReply(JSON.parse(line)); } catch {} } });
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => { this.proc = null; this.enrolled.clear(); this.pending.clear(); this.busy = false; setTimeout(() => this.start(), 5000); });
    this.sync();
    this.timer ||= setInterval(() => { this.sync(); this.tick(); }, MATCH_EVERY_MS);
  }
  send(o) { if (this.proc) this.proc.stdin.write(JSON.stringify(o) + '\n'); }
  people() { return this.registry.list.filter((x) => x.face && x.photo); }
  templatesFile(pid) { return path.join(this.root, 'participants', pid, 'face-templates.json'); }
  templates(pid) { try { return JSON.parse(fs.readFileSync(this.templatesFile(pid), 'utf8')); } catch { return []; } }
  // Enrol everyone registered with face matching; forget anyone who no longer is.
  sync() {
    const want = new Map(this.people().map((x) => [x.pid, x]));
    for (const [pid, x] of want) if (!this.enrolled.has(pid) && !this.failed.has(pid) && !this.pending.has(pid)) { this.pending.set(pid, true); this.send({ op: 'enroll', pid, path: x.photo, templates: this.templates(pid).map((t) => t.emb) }); }
    for (const pid of this.enrolled.keys()) if (!want.has(pid)) { this.enrolled.delete(pid); this.send({ op: 'forget', pid }); }
  }
  person(pid) { const x = this.registry.get(pid); return x && { pid, name: x.name, number: x.number }; }

  // ---- full-resolution frames from the camera's main stream ----
  fullFrames(cam) {
    const src = cam.main && /^(rtsp|https?):\/\//.test(cam.main) ? cam.main : null;
    if (!src) { this.stopFull(); return null; }
    if (this.full?.camId !== cam.id || this.full.fps !== (this.fullFps || 1)) {
      this.stopFull();
      const args = ['-hide_banner', '-loglevel', 'error', ...(src.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []), '-i', src, '-an', '-vf', `fps=${this.fullFps || 1}`, '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
      const p = this.spawnImpl('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] }); let buf = Buffer.alloc(0);
      this.full = { camId: cam.id, proc: p, frame: null, at: 0, fps: this.fullFps || 1 };
      p.stdout.on('data', (d) => {
        buf = Buffer.concat([buf, d]); let e;
        while ((e = buf.indexOf(Buffer.from([0xff, 0xd9]))) >= 0) { const s = buf.lastIndexOf(Buffer.from([0xff, 0xd8]), e); if (s >= 0 && this.full?.proc === p) { this.full.frame = buf.subarray(s, e + 2); this.full.at = Date.now(); } buf = buf.subarray(e + 2); }
        if (buf.length > 20e6) buf = Buffer.alloc(0);
      });
      p.on('exit', () => { if (this.full?.proc === p) this.full = null; });
    }
    return this.full;
  }
  stopFull() { if (this.full) { try { this.full.proc.kill(); } catch {} this.full = null; } }

  tick(now = Date.now()) {
    const t = this.tracking; if (!this.proc || this.busy || !this.enrolled.size) return;
    const view = t.view(now); if (!view.running) { this.stopFull(); return; }
    const cam = this.cameras.find((c) => c.id === t.cameraId); if (!cam) return;
    const full = this.fullFrames(cam);
    const frame = full?.frame && now - full.at < 3000 ? full.frame : cam.frame && now - cam.frameAt < 2000 ? cam.frame : null;
    if (!frame) return;
    this.busy = true; this.source = frame === full?.frame ? 'full resolution' : 'preview';
    this.send({ op: 'match', id: ++this.seq, jpeg: Buffer.from(frame).toString('base64') });
    setTimeout(() => { this.busy = false; }, 5000);   // never wait forever on the worker
  }
  onReply(m) {
    if (m.op === 'enroll') {
      this.pending.delete(m.pid);
      if (m.ok) { this.enrolled.set(m.pid, true); this.log(`face enrolled: ${this.person(m.pid)?.name}`); }
      else { this.failed.set(m.pid, m.error); this.log(`face not enrolled for ${this.person(m.pid)?.name}: ${m.error}`); }
      return;
    }
    if (m.op !== 'match') return;
    this.busy = false;
    this.assign(m.faces || [], m.w, m.h);
  }
  // Tie each face to the person track that contains it; name tracks; learn new views of named people.
  assign(faces, w, h, now = Date.now()) {
    const tracks = this.tracking.view(now).tracks.filter((t) => t.visible && t.box);
    const placed = faces.map((f) => {
      const cx = (f.box[0] + f.box[2] / 2) / w, cy = (f.box[1] + f.box[3] / 2) / h;
      const inside = tracks.filter((t) => cx >= t.box.x && cx <= t.box.x + t.box.w && cy >= t.box.y && cy <= t.box.y + t.box.h * 0.5);
      return { f, track: inside.sort((a, b) => Math.abs(a.box.x + a.box.w / 2 - cx) - Math.abs(b.box.x + b.box.w / 2 - cx))[0] || null };
    });
    for (const { f, track } of placed) {
      if (!track) continue;
      if (f.pid) {
        const key = track.id + '>' + f.pid, prev = this.hits.get(key);
        const hits = prev && now - prev.at < CONFIRM_WITHIN_MS ? prev.n + 1 : 1;
        this.hits.set(key, { n: hits, at: now });
        const p = this.person(f.pid); if (!p) continue;
        this.recent = [{ ...p, score: f.score, track: track.id, at: now }, ...this.recent.filter((r) => r.pid !== f.pid)].slice(0, 12);
        if (hits >= CONFIRM_HITS) this.tracking.identify(track.id, { ...p, score: f.score, at: now, by: 'face' });
      }
      // Learn: one face in a track that is named as a registered person (by the desk, or by a strong match).
      const who = this.tracking.bindings.get(track.id)?.person;
      const alone = placed.filter((x) => x.track?.id === track.id).length === 1;
      if (who?.pid && alone && f.emb && this.enrolled.has(who.pid) && (who.by === 'desk' || (f.pid === who.pid && f.score >= LEARN_MIN_SCORE))) this.learn(who.pid, f.emb);
    }
  }
  learn(pid, emb) {
    const list = this.templates(pid);
    if (list.some((t) => dot(t.emb, emb) >= LEARN_DIFFERENT_BELOW)) return;   // already have a view like this
    list.push({ at: new Date().toISOString(), emb });
    const keep = list.slice(-MAX_TEMPLATES);
    fs.mkdirSync(path.dirname(this.templatesFile(pid)), { recursive: true });
    fs.writeFileSync(this.templatesFile(pid), JSON.stringify(keep));
    this.send({ op: 'learn', pid, emb });
  }
  // The desk says who a track is, from the registered people.
  name(trackId, pid) {
    const p = this.person(pid); if (!p) throw Error('Choose a registered person.');
    this.tracking.identify(trackId, { ...p, by: 'desk', at: Date.now() });
  }
  status(now = Date.now()) {
    const registered = this.registry.list.map((x) => ({ pid: x.pid, name: x.name, number: x.number, face: !!x.face, enrolled: this.enrolled.has(x.pid), views: x.face ? this.templates(x.pid).length + (this.enrolled.has(x.pid) ? 1 : 0) : 0, problem: this.failed.get(x.pid) || null }));
    return { ready: this.ready, running: !!this.proc, source: this.source || null, registered,
      recent: this.recent.filter((r) => now - r.at < 60000).map((r) => ({ name: r.name, number: r.number, score: r.score, track: r.track, secondsAgo: Math.round((now - r.at) / 1000) })) };
  }
}
module.exports = { Identity };
