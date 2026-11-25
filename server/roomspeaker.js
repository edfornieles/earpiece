// Room speaker: the computer's own audio output (an amp on the headphone socket), a fifth voice in the room
// beside the phones. Mother can speak a typed line through it, play library tracks (once or looping) or beep.
//
// Settings in speaker.json (optional): { "device": "External Headphones", "volume": 1 }
// "device" is the output's name as macOS lists it. One thing plays at a time; a new one replaces it.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function loadSpeakerConfig(dir) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(dir, 'speaker.json'), 'utf8')) || {}; } catch {}
  return { device: String(c.device || 'External Headphones'), volume: Math.max(0, Math.min(2, Number(c.volume ?? 1) || 0)) };
}

class RoomSpeaker {
  constructor(cfg, { ffmpeg = 'ffmpeg', speak, onChange = () => {}, onAudio = () => {}, log = () => {} } = {}) {   // onAudio: what went out, 24 kHz mono s16le, for the recording
    this.device = cfg.device; this.volume = cfg.volume;
    this.ffmpeg = ffmpeg; this.speak = speak; this.onChange = onChange; this.onAudio = onAudio; this.log = log;
    this.voice = '';   // name of the AI voice it speaks in
    this.proc = null; this.abort = null; this.now = null;   // now: { kind:'say'|'sound', id, label, loop, since }
    this.serial = 0;
  }
  // CoreAudio lists inputs and outputs together; ffmpeg's -audio_device_index counts that whole list.
  deviceIndex() {   // cached for 10 s: the panel asks every couple of seconds
    if (this.idxAt && Date.now() - this.idxAt < 10000) return this.idx;
    this.idx = this.findIndex(); this.idxAt = Date.now();
    return this.idx;
  }
  findIndex() {
    const r = spawnSync(this.ffmpeg, ['-hide_banner', '-f', 'lavfi', '-i', 'anullsrc', '-t', '0.01', '-f', 'audiotoolbox', '-list_devices', 'true', '-'], { encoding: 'utf8', timeout: 8000 });
    // Lines look like: "[AudioToolbox @ 0x…] [2]            External Headphones, BuiltInHeadphoneOutputDevice"
    for (const l of String(r.stderr || '').split('\n')) {
      const m = l.match(/\]\s*\[(\d+)\]\s+(.*?),\s/);
      if (m && m[2].trim().toLowerCase() === this.device.toLowerCase()) return Number(m[1]);
    }
    return -1;
  }
  status() { return { device: this.device, volume: this.volume, available: this.deviceIndex() >= 0, playing: this.now }; }

  // Starts ffmpeg writing to the speaker. input: ffmpeg input args. Resolves when playback ends.
  start(input, now) {
    this.stop(true);
    this.idxAt = 0;   // look again before playing, in case something was plugged in or out
    const idx = this.deviceIndex();
    if (idx < 0) throw Error(`The room speaker (${this.device}) is not connected to this computer.`);
    const args = ['-hide_banner', '-loglevel', 'error', ...input, '-af', `volume=${this.volume}`, '-ac', '2', '-ar', '48000', '-f', 'audiotoolbox', '-audio_device_index', String(idx), '-',
      '-af', `volume=${this.volume}`, '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'];   // the same sound, for the session recording
    const p = spawn(this.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const serial = ++this.serial;
    p.stdout.on('data', (d) => { if (this.serial === serial) this.onAudio(d); });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.on('error', () => {});
    this.proc = p; this.now = { ...now, since: Date.now() };
    this.onChange();
    const done = new Promise((ok) => p.on('close', (code) => {
      if (code && err.trim()) this.log('speaker_error', { message: err.trim().slice(0, 300) });
      if (this.serial === serial) { this.proc = null; this.now = null; this.abort = null; this.onChange(); }
      ok();
    }));
    return { proc: p, done };
  }

  // Speaks a line in one of Mother's voices. Returns once it has started; the speech streams as it's made.
  say(text, voiceUrl, style = {}) {
    text = String(text || '').trim().slice(0, 2000);
    if (!text) throw Error('Type what the room speaker should say.');
    const { proc } = this.start(['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0'], { kind: 'say', id: 'say', label: text.slice(0, 120), loop: false });
    const abort = new AbortController(); this.abort = abort;
    this.speak(text, (pcm) => { if (!abort.signal.aborted) proc.stdin.write(pcm); }, abort.signal, voiceUrl, style)
      .catch((e) => { if (e.name !== 'AbortError') { this.log('speaker_error', { message: e.message }); proc.kill('SIGKILL'); } })
      .finally(() => { try { proc.stdin.end(); } catch {} });
  }
  // The director's own voice, live: raw 16-bit mono PCM pushed in as it arrives. Returns a writer; end() finishes.
  live(rate = 24000) {
    const { proc } = this.start(['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0'], { kind: 'live', id: 'live', label: 'Your voice, live', loop: false });
    return { write: (pcm) => { if (this.proc === proc) proc.stdin.write(pcm); }, end: () => { try { proc.stdin.end(); } catch {} } };
  }
  // file: a library track on disk; null with beep:true for the built-in beep.
  play({ id, label, file, beep = false, loop = false }) {
    // The speaker plays in real time by itself, so files need no -re. A looping beep is one 0.25 s beep a second.
    const input = beep
      ? ['-f', 'lavfi', '-i', loop ? 'aevalsrc=0.5*sin(2*PI*880*t)*lt(mod(t\\,1)\\,0.25):s=48000' : 'aevalsrc=0.5*sin(2*PI*880*t):s=48000:d=0.25']
      : [...(loop ? ['-stream_loop', '-1'] : []), '-i', file];
    this.start(input, { kind: beep ? 'beep' : 'sound', id, label, loop: !!loop });
  }
  stop(quiet = false) {
    if (this.abort) { this.abort.abort(); this.abort = null; }
    if (this.proc) { const p = this.proc; this.proc = null; this.serial++; p.kill('SIGKILL'); }
    const was = this.now; this.now = null;
    if (was && !quiet) this.onChange();
    return was;
  }
}

module.exports = { RoomSpeaker, loadSpeakerConfig };
