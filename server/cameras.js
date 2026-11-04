// Cameras: records each camera's main stream to disk (no re-encode) and serves a live preview.
// Config: cameras.json in the project folder, e.g.
// [ { "name": "Gallery", "main": "rtsp://user:pass@192.168.1.50:554/stream1",
//                       "preview": "rtsp://user:pass@192.168.1.50:554/stream2" } ]
// "main": "test" uses a generated test picture (for trying things out without a camera).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SEGMENT_SECS = 600;   // a new file every 10 minutes, so a crash loses at most one chunk

function loadConfig(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'cameras.json'), 'utf8'));
    return list.filter((c) => c && c.main).map((c, i) => ({ id: 'cam' + (i + 1), name: c.name || `Camera ${i + 1}`, main: c.main, preview: c.preview || c.main }));
  } catch { return []; }
}

const safe = (s) => s.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'camera';

function inputArgs(url, preview) {
  if (url === 'test') {
    return preview
      ? ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=8']
      : ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'];
  }
  const a = ['-fflags', '+genpts'];
  if (url.startsWith('rtsp')) a.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
  return [...a, '-i', url];
}

class Camera {
  constructor(cfg, sessionDir, T0, log) {
    Object.assign(this, cfg);
    this.slug = safe(cfg.name);
    this.dir = path.join(sessionDir, 'video', this.slug);
    fs.mkdirSync(this.dir, { recursive: true });
    this.T0 = T0; this.log = log;
    this.frame = null; this.frameAt = 0; this.viewers = new Set();
    this.segments = [];          // { file, wallStart }
    this.stopped = false; this.recording = false; this.previewing = false;
  }

  start() { this.startRecorder(); this.startPreview(); }

  // ---- recording ----
  startRecorder() {
    if (this.stopped) return;
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
    const pattern = path.join(this.dir, `${this.slug}_${stamp}_%03d.mkv`);
    const listFile = path.join(this.dir, `.segments_${stamp}.csv`);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', ...inputArgs(this.main, false),
      '-map', '0:v:0', '-map', this.main === 'test' ? '1:a:0' : '0:a:0?',
      '-c:v', this.main === 'test' ? 'libx264' : 'copy', ...(this.main === 'test' ? ['-preset', 'ultrafast', '-g', '50'] : []),
      '-c:a', 'aac', '-b:a', '96k', '-af', 'aresample=async=1000', '-max_muxing_queue_size', '2048',
      '-f', 'segment', '-segment_time', String(SEGMENT_SECS), '-reset_timestamps', '1',
      '-segment_format', 'matroska', '-segment_list', listFile, '-segment_list_type', 'csv', pattern];
    const spawnedAt = Date.now();
    const p = spawn('ffmpeg', args);
    this.rec = p;
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', () => this.log('camera_error', { cam: this.id, message: 'ffmpeg not found — brew install ffmpeg' }, true));
    // The first chunk's file appearing on disk marks when recording really began.
    const firstFile = pattern.replace('%03d', '000');
    const watch = setInterval(() => {
      if (fs.existsSync(firstFile)) {
        clearInterval(watch);
        this.recording = true;
        this.runs = this.runs || [];
        this.runs.push({ pattern, listFile, wallStart: Date.now(), spawnedAt });
        this.log('camera_recording', { cam: this.id, name: this.name, file: path.basename(firstFile) });
      }
    }, 100);
    p.on('exit', (code) => {
      clearInterval(watch);
      this.recording = false;
      if (this.stopped) return;
      this.log('camera_dropped', { cam: this.id, name: this.name, code, detail: err.trim().split('\n').slice(-2).join(' ') }, true);
      setTimeout(() => this.startRecorder(), 3000);
    });
  }

  // ---- live preview (small, low frame rate JPEGs) ----
  startPreview() {
    if (this.stopped) return;
    const args = ['-hide_banner', '-loglevel', 'error', ...inputArgs(this.preview, true),
      '-an', '-vf', 'fps=8,scale=640:-2', '-q:v', '7', '-f', 'mjpeg', 'pipe:1'];
    const p = spawn('ffmpeg', args);
    this.prev = p;
    let buf = Buffer.alloc(0);
    p.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const s = buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (s < 0) { buf = Buffer.alloc(0); break; }
        const e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
        if (e < 0) { buf = buf.subarray(s); break; }
        this.frame = buf.subarray(s, e + 2); this.frameAt = Date.now(); this.previewing = true;
        buf = buf.subarray(e + 2);
        for (const res of this.viewers) this.sendFrame(res);
      }
    });
    p.on('error', () => {});
    p.on('exit', () => { this.previewing = false; if (!this.stopped) setTimeout(() => this.startPreview(), 3000); });
  }
  sendFrame(res) {
    if (!this.frame) return;
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.frame.length}\r\n\r\n`);
    res.write(this.frame); res.write('\r\n');
  }
  serve(res) {
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'cache-control': 'no-store', connection: 'close' });
    this.viewers.add(res); this.sendFrame(res);
    res.on('close', () => this.viewers.delete(res));
  }
  status() { return { id: this.id, name: this.name, recording: this.recording, live: this.previewing && Date.now() - this.frameAt < 3000 }; }

  // ---- stop: close files and convert chunks to .mp4 for the editor ----
  stop() {
    this.stopped = true;
    for (const p of [this.rec, this.prev]) if (p && p.exitCode === null) p.kill('SIGINT');
  }
  finalize() {
    const out = [];
    for (const run of this.runs || []) {
      let rows = [];
      try { rows = fs.readFileSync(run.listFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(',')); } catch {}
      // csv rows: filename,start,end (seconds from the start of this run)
      const files = rows.length ? rows : fs.readdirSync(this.dir).filter((f) => f.startsWith(path.basename(run.pattern).split('%')[0]) && f.endsWith('.mkv')).sort().map((f, i) => [f, String(i * SEGMENT_SECS), '']);
      for (const [name, start] of files) {
        const mkv = path.join(this.dir, name);
        if (!fs.existsSync(mkv)) continue;
        const mp4 = mkv.replace(/\.mkv$/, '.mp4');
        const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', mkv]).stdout?.toString().trim();
        const tag = probe === 'hevc' ? ['-tag:v', 'hvc1'] : [];
        const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mkv, '-c', 'copy', ...tag, '-movflags', '+faststart', mp4]);
        const ok = r.status === 0 && fs.existsSync(mp4) && fs.statSync(mp4).size > 0;
        const durOf = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout?.toString().trim()) || 0;
        const dur = ok ? durOf(mp4) : durOf(mkv);
        if (ok && dur > 0) { try { fs.unlinkSync(mkv); } catch {} }   // the .mp4 is a lossless copy; keep the .mkv only if conversion failed
        const file = ok && dur > 0 ? mp4 : mkv;
        if (dur < 1) { try { fs.unlinkSync(file); } catch {} continue; }   // fragments from a dropout
        out.push({ cam: this.id, name: this.name, file, offset: (run.wallStart - this.T0) / 1000 + Number(start || 0), duration: dur });
      }
      try { fs.unlinkSync(run.listFile); } catch {}
    }
    return out;
  }
}

module.exports = { loadConfig, Camera };
