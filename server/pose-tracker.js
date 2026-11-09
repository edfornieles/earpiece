// Live tracking on this computer instead of in a browser tab: YOLO pose with ByteTrack (pose_worker.py),
// reading the camera's full-resolution stream. Every person comes with body points (ankles, hips, head),
// so tracking.js can place them with an honest error radius. Furniture and animals are looked for
// every few frames. Runs only while the desk has switched it on; the GPU is free otherwise.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TRACKER = 'server', FULL_FPS = 5, OBJECTS_EVERY = 8, FRESH_FULL_MS = 1500, FRESH_PREVIEW_MS = 800;
const FURNITURE = new Set(['chair', 'couch', 'bench', 'dining table', 'suitcase', 'backpack', 'handbag', 'potted plant', 'tv']), ANIMALS = new Set(['dog', 'cat']);

class PoseTracker {
  constructor({ root, cameras, room, identity, log = () => {}, spawnImpl = spawn }) {
    Object.assign(this, { root, cameras, room, identity, log, spawnImpl });
    this.py = path.join(root, '.faces-venv', 'bin', 'python');
    this.ready = fs.existsSync(this.py) && fs.existsSync(path.join(root, 'pose_worker.py')) && fs.existsSync(path.join(root, 'models', 'yolo11s-pose.pt'));
    this.on = false; this.cameraId = ''; this.proc = null; this.device = null; this.busy = false; this.seq = 0; this.error = '';
    this.lastFrame = null; this.objects = []; this.animals = []; this.stats = { ms: 0, fps: 0, n: 0, since: 0, source: '' };
  }
  start(cameraId) {
    if (!this.ready) throw Error('Server tracking is not set up on this computer (pose model or Python missing).');
    const cam = this.cameras.find((c) => c.id === cameraId); if (!cam) throw Error('Choose a camera.');
    const t = this.room.tracking;
    if (t.owner && t.owner !== TRACKER && Date.now() - t.at < 5000) throw Error('Tracking is already running on another screen. Stop it there first.');
    this.on = true; this.startedAt = Date.now(); this.fullAt = 0; this.cameraId = cameraId; this.error = ''; this.seq = 0; this.lastFrame = null;
    this.stats = { ms: 0, fps: 0, n: 0, since: Date.now(), source: '' };
    if (this.identity) this.identity.fullFps = FULL_FPS;
    this.spawn(); this.timer ||= setInterval(() => this.tick(), 60);
    this.log(`server tracking on (${cameraId})`);
  }
  stop() {
    const was = this.on; this.on = false; clearInterval(this.timer); this.timer = null;
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    this.device = null; this.busy = false;
    if (this.identity) this.identity.fullFps = 1;
    if (was) { this.room.stopTracking(TRACKER); this.log('server tracking off'); }
  }
  spawn() {
    if (this.proc) return;
    const p = this.spawnImpl(this.py, [path.join(this.root, 'pose_worker.py')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, YOLO_OFFLINE: '1' } });
    this.proc = p; let buf = '', err = '';
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { this.onReply(JSON.parse(line)); } catch {} } });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null; this.device = null; this.busy = false;
      if (this.on) { this.error = `Pose detector stopped${code ? ` (${err.trim().split('\n').pop() || code})` : ''}. Restarting…`; setTimeout(() => this.on && this.spawn(), 2000); }
    });
  }
  // The newest frame: the full-resolution stream when it is flowing, the preview otherwise.
  frame(now) {
    const cam = this.cameras.find((c) => c.id === this.cameraId); if (!cam) return null;
    const full = this.identity?.fullFrames?.(cam);
    if (full?.frame && now - full.at < FRESH_FULL_MS) { this.fullAt = now; return { jpeg: full.frame, source: 'full' }; }
    // Switching picture size restarts the tracker's ids, so stay on the full stream through short gaps
    // and give it a few seconds to start before falling back to the preview.
    if (now - (this.fullAt || 0) < 5000 || now - this.startedAt < 6000) return null;
    if (cam.frame && now - cam.frameAt < FRESH_PREVIEW_MS) return { jpeg: cam.frame, source: 'preview' };
    return null;
  }
  tick(now = Date.now()) {
    if (!this.on || !this.proc || !this.device || this.busy || this.paused?.(this.cameraId)) return;
    const f = this.frame(now); if (!f || f.jpeg === this.lastFrame) return;
    this.lastFrame = f.jpeg; this.busy = true; this.stats.source = f.source; this.sentAt = now;
    const id = ++this.seq;
    this.proc.stdin.write(JSON.stringify({ id, jpeg: Buffer.from(f.jpeg).toString('base64'), objects: id % OBJECTS_EVERY === 1 }) + '\n');
    clearTimeout(this.stall); this.stall = setTimeout(() => { this.busy = false; }, 10000);
  }
  onReply(m) {
    if (m.ready) { this.device = m.device; this.error = ''; this.log(`pose detector ready (${m.device})`); return; }
    this.busy = false; clearTimeout(this.stall);
    if (!this.on) return;
    if (m.error) { this.error = m.error; return; }
    this.error = '';
    const now = Date.now(), W = m.w, H = m.h, box = (b) => ({ x: b[0] / W, y: b[1] / H, w: b[2] / W, h: b[3] / H });
    const tracks = (m.people || []).map((p) => {
      const b = box(p.box);
      return { id: 'P' + p.track, box: b, score: p.conf, feetVisible: b.y + b.h < 0.97, kp: p.kp.map(([x, y, c]) => [Math.round(x / W * 1000) / 1000, Math.round(y / H * 1000) / 1000, Math.round(c * 1000) / 1000]) };
    });
    if (m.objects) {
      const list = m.objects.map((o) => ({ cls: o.cls, score: o.conf, box: box(o.box) }));
      this.objects = list.filter((o) => FURNITURE.has(o.cls)); this.animals = list.filter((o) => ANIMALS.has(o.cls));
    }
    const s = this.stats; s.ms = m.ms; s.n++; if (now - s.since > 2000) { s.fps = Math.round(s.n * 10000 / (now - s.since)) / 10; s.n = 0; s.since = now; }
    try { this.room.track({ tracker: TRACKER, cameraId: this.cameraId, tracks, objects: this.objects, animals: this.animals }); }
    catch (e) { this.error = e.message; this.stop(); }
  }
  status() {
    return { ready: this.ready, on: this.on, cameraId: this.cameraId, device: this.device, error: this.error, ms: this.stats.ms, fps: this.stats.fps, source: this.stats.source };
  }
}
module.exports = { PoseTracker, TRACKER };
