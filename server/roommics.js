// Room microphones: records an audio interface (e.g. the Zoom F4 over USB) on the session clock.
// Config: roommics.json in the project folder, e.g.
//   { "device": "ZOOM F4", "channels": 4, "names": ["Window", "Bench", "Door", "Centre"] }
// "device" is the input's name as macOS lists it (npm run devices), or "default" for the Mac's own mic,
// or "test" for a generated tone. Each channel becomes its own WAV in audio/ when the session ends.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function loadRoomMics(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'roommics.json'), 'utf8'));
    if (!c || !c.device) return null;
    const channels = Math.max(1, Math.min(16, Number(c.channels) || 1));
    const names = Array.from({ length: channels }, (_, i) => (c.names && c.names[i]) || `Room ${i + 1}`);
    return { device: String(c.device), channels, names, rate: Number(c.rate) || 48000 };
  } catch { return null; }
}

const safe = (s) => s.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'room';

class RoomMics {
  constructor(cfg, sessionDir, T0, log) {
    Object.assign(this, cfg);
    this.dir = path.join(sessionDir, 'audio');
    this.T0 = T0; this.log = log;
    this.runs = []; this.stopped = false; this.recording = false;
    this.levels = new Array(cfg.channels).fill(0);
  }
  input() {
    if (this.device === 'test') {
      const ch = this.names.map((_, i) => `0.2*sin(${220 * (i + 1)}*2*PI*t)`).join('|');
      return ['-re', '-f', 'lavfi', '-i', `aevalsrc=${ch}:s=${this.rate}`];
    }
    const dev = this.device === 'default' ? '0' : this.device;
    return ['-f', 'avfoundation', '-i', `:${dev}`];
  }
  // ffmpeg hands raw 24-bit audio to us; we stamp the first samples against the session clock and
  // write them straight to disk (crash-safe: a raw file is always readable), measuring levels as they pass.
  start() {
    if (this.stopped) return;
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
    const file = path.join(this.dir, `.room_${stamp}.raw`);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', ...this.input(),
      '-ac', String(this.channels), '-ar', String(this.rate), '-f', 's24le', 'pipe:1'];
    const p = spawn('ffmpeg', args);
    this.proc = p;
    const out = fs.createWriteStream(file);
    const frame = 3 * this.channels;
    let run = null, carry = Buffer.alloc(0), err = '';
    p.stdout.on('data', (d) => {
      if (!run) {
        run = { file, frames: 0, wallStart: Date.now() - (d.length / frame / this.rate) * 1000 };
        this.runs.push(run); this.recording = true;
        this.log('roommics_recording', { device: this.device, channels: this.channels });
      }
      out.write(d);
      const buf = carry.length ? Buffer.concat([carry, d]) : d;
      const n = Math.floor(buf.length / frame);
      run.frames += n;
      const peak = new Array(this.channels).fill(0);
      for (let i = 0; i < n; i += 8) for (let c = 0; c < this.channels; c++) {
        const v = Math.abs(buf.readIntLE(i * frame + c * 3, 3)) / 8388608;
        if (v > peak[c]) peak[c] = v;
      }
      this.levels = this.levels.map((l, c) => Math.max(peak[c], l * 0.85));
      carry = buf.subarray(n * frame);
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', () => this.log('roommics_error', { message: 'ffmpeg not found — brew install ffmpeg' }, true));
    p.on('exit', (code) => {
      out.end();
      this.recording = false;
      if (this.stopped) return;
      this.log('roommics_dropped', { code, detail: err.trim().split('\n').slice(-2).join(' ') }, true);
      setTimeout(() => this.start(), 3000);
    });
    this.out = out;
  }
  status() {
    return { device: this.device, channels: this.channels, names: this.names, recording: this.recording,
      levels: this.levels.map((l) => Math.round(l * 100) / 100) };
  }
  stop() { this.stopped = true; if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGINT'); }
  closed() { return (!this.proc || this.proc.exitCode !== null || this.proc.signalCode) && (!this.out || this.out.closed); }

  // one WAV per channel, named after its position; returns [{ file, name, offset, duration }]
  finalize() {
    const out = [];
    this.runs.forEach((run, ri) => {
      if (!fs.existsSync(run.file) || !run.frames) return;
      const offset = Math.max(0, (run.wallStart - this.T0) / 1000);
      const suffix = this.runs.length > 1 ? `-part${ri + 1}` : '';
      const outs = this.names.map((n) => path.join(this.dir, `room-${safe(n)}${suffix}.wav`));
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's24le', '-ar', String(this.rate), '-ac', String(this.channels), '-i', run.file];
      if (this.channels === 1) args.push('-c:a', 'pcm_s24le', outs[0]);
      else {
        const n = this.channels;
        args.push('-filter_complex', `[0:a]asplit=${n}${outs.map((_, i) => `[s${i}]`).join('')};` + outs.map((_, i) => `[s${i}]pan=mono|c0=c${i}[c${i}]`).join(';'));
        outs.forEach((f, i) => args.push('-map', `[c${i}]`, '-c:a', 'pcm_s24le', f));
      }
      const r = spawnSync('ffmpeg', args);
      if (r.status !== 0) { this.log('roommics_split_failed', { detail: String(r.stderr).slice(-300) }, true); return; }
      const duration = Math.round((fs.statSync(run.file).size / (3 * this.channels) / this.rate) * 1000) / 1000;
      outs.forEach((f, i) => out.push({ file: f, name: this.names[i], offset: Math.round(offset * 1000) / 1000, duration }));
      try { fs.unlinkSync(run.file); } catch {}
    });
    return out;
  }
}

module.exports = { loadRoomMics, RoomMics };
