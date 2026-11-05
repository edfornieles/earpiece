// AI pieces: speech detection, transcription (OpenAI), the director's mind (OpenAI chat),
// and the Watercooler voice (Pocket-TTS running on this Mac).
// MOCK_AI=1 replaces the network calls with stand-ins, for testing without keys.

const RATE = 24000;
const MOCK = !!process.env.MOCK_AI;
const OPENAI = 'https://api.openai.com/v1';
const KEY = () => process.env.OPENAI_API_KEY;
const TEXT_MODEL = () => process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
const STT_MODEL = () => process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const TTS_URL = () => (process.env.POCKET_TTS_URL || 'http://localhost:8123').replace(/\/+$/, '');
const VOICE = () => process.env.POCKET_TTS_VOICE || 'hf://kyutai/tts-voices/vctk/p329_023.wav';

// ---------- speech detection on the participant's mic ----------
// Feed 20 ms int16 frames; calls onStart() when speech begins and onUtterance(pcmBuffer) when it ends.
class Vad {
  constructor({ onStart, onUtterance }) {
    this.onStart = onStart; this.onUtterance = onUtterance;
    this.floor = 0.01; this.speaking = false; this.run = 0; this.silence = 0;
    this.pre = []; this.buf = []; this.len = 0; this.strict = false;
  }
  push(pcm) {
    const n = pcm.length >> 1; let s = 0;
    for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; s += v * v; }
    const rms = Math.sqrt(s / (n || 1));
    if (!this.speaking) this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.995 + rms * 0.005;
    const thresh = Math.max(this.strict ? 0.04 : 0.018, this.floor * 3);
    const loud = rms > thresh;
    if (!this.speaking) {
      this.pre.push(pcm); if (this.pre.length > 15) this.pre.shift();   // 300 ms pre-roll
      this.run = loud ? this.run + 1 : 0;
      if (this.run >= 3) {
        this.speaking = true; this.silence = 0;
        this.buf = this.pre.slice(); this.len = this.buf.reduce((a, b) => a + b.length, 0); this.pre = [];
        this.onStart && this.onStart();
      }
      return;
    }
    this.buf.push(pcm); this.len += pcm.length;
    this.silence = loud ? 0 : this.silence + 1;
    const secs = this.len / 2 / RATE;
    if (this.silence >= 40 || secs > 30) {             // 800 ms of quiet ends a turn
      this.speaking = false; this.run = 0;
      const all = Buffer.concat(this.buf); this.buf = []; this.len = 0;
      if (secs > 0.6) this.onUtterance(all);
    }
  }
}

// ---------- helpers ----------
function wavBytes(pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

class Resampler {
  constructor(from, to) { this.r = from / to; this.pos = 0; this.last = 0; }
  process(input) {
    if (this.r === 1) return input;
    const L = input.length + 1, out = [];
    let p = this.pos;
    while (p < L - 1) {
      const i = Math.floor(p), f = p - i;
      const a = i === 0 ? this.last : input[i - 1], b = input[i];
      out.push(a + (b - a) * f); p += this.r;
    }
    this.pos = p - (L - 1);
    if (input.length) this.last = input[input.length - 1];
    return Float32Array.from(out);
  }
}
function floatToInt16Buf(f) {
  const b = Buffer.alloc(f.length * 2);
  for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); b.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2); }
  return b;
}

// Decodes a WAV that arrives in pieces (Pocket-TTS streams it). Handles 16-bit PCM and 32-bit float, any rate.
class WavStreamDecoder {
  constructor() { this.head = Buffer.alloc(0); this.fmt = null; this.inData = false; this.carry = Buffer.alloc(0); this.rs = null; }
  push(chunk) {
    if (!this.inData) {
      this.head = Buffer.concat([this.head, chunk]);
      let i = 12;
      while (i + 8 <= this.head.length) {
        const id = this.head.toString('ascii', i, i + 4), size = this.head.readUInt32LE(i + 4);
        if (id === 'fmt ') {
          if (i + 8 + 16 > this.head.length) return [];
          this.fmt = { format: this.head.readUInt16LE(i + 8), channels: this.head.readUInt16LE(i + 10), rate: this.head.readUInt32LE(i + 12), bits: this.head.readUInt16LE(i + 22) };
        }
        if (id === 'data') {
          this.inData = true;
          this.rs = new Resampler(this.fmt.rate, RATE);
          chunk = this.head.subarray(i + 8); this.head = null;
          break;
        }
        i += 8 + size + (size & 1);
      }
      if (!this.inData) return [];
    }
    const data = Buffer.concat([this.carry, chunk]);
    const bps = this.fmt.bits / 8, frame = bps * this.fmt.channels;
    const n = Math.floor(data.length / frame);
    this.carry = data.subarray(n * frame);
    const f = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const o = k * frame;
      f[k] = this.fmt.format === 3 ? data.readFloatLE(o) : bps === 2 ? data.readInt16LE(o) / 32768 : bps === 4 ? data.readInt32LE(o) / 2147483648 : (data.readUInt8(o) - 128) / 128;
    }
    return floatToInt16Buf(this.rs.process(f));
  }
}

// ---------- network calls ----------
async function transcribe(pcm) {
  if (MOCK) return 'mock: I am standing by the window.';
  const tryModel = async (model) => {
    const fd = new FormData();
    fd.set('model', model);
    fd.set('file', new Blob([wavBytes(pcm)], { type: 'audio/wav' }), 'speech.wav');
    const r = await fetch(`${OPENAI}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${KEY()}` }, body: fd });
    if (!r.ok) throw new Error(`transcribe ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).text || '';
  };
  try { return await tryModel(STT_MODEL()); }
  catch (e) { if (STT_MODEL() !== 'whisper-1') return tryModel('whisper-1'); throw e; }
}

async function think(messages) {
  if (MOCK) return 'Walk slowly to the nearest wall. Tell me what you see.';
  const r = await fetch(`${OPENAI}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: TEXT_MODEL(), messages, temperature: 0.9, max_tokens: 160 })
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()).choices[0].message.content || '').trim();
}

// Streams the Watercooler voice; calls onPcm(int16 buffer at 24 kHz) as audio arrives.
async function speak(text, onPcmRaw, signal, voice, style = {}) {
  const sh = shaper(style.pitch, style.speed, onPcmRaw);
  const onPcm = sh ? (b) => sh.write(b) : onPcmRaw;
  if (signal && sh) signal.addEventListener('abort', () => sh.kill());
  try { await speakRaw(text, onPcm, signal, voice); } finally { if (sh) await sh.end(); }
}
async function speakRaw(text, onPcm, signal, voiceUrl) {
  const dec = new WavStreamDecoder();
  if (MOCK) {                                   // 1.5 s of soft tone, delivered in pieces
    const sr = 24000, n = sr * 1.5, f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / sr);
    const w = Buffer.concat([wavBytes(floatToInt16Buf(f), sr)]);
    for (let o = 0; o < w.length; o += 7001) { if (signal?.aborted) return; onPcm(dec.push(w.subarray(o, o + 7001))); await new Promise((r) => setTimeout(r, 30)); }
    return;
  }
  const fd = new FormData();
  fd.set('text', text);
  fd.set('voice_url', voiceUrl || VOICE());
  const r = await fetch(`${TTS_URL()}/tts`, { method: 'POST', body: fd, signal });
  if (!r.ok) throw new Error(`voice ${r.status}: ${(await r.text()).slice(0, 200)}`);
  for await (const chunk of r.body) {
    if (signal?.aborted) return;
    const pcm = dec.push(Buffer.from(chunk));
    if (pcm.length) onPcm(pcm);
  }
}

// Voices Pocket-TTS can speak in. The first is the default.
// Pocket-TTS copies everything — identity AND manner — from the sample a voice is cloned from,
// so "emotion" means switching to the same actor recorded in a different state (Expresso dataset).
const X = 'hf://kyutai/tts-voices/expresso/';
const VOICES = [
  { name: 'Watercooler', url: 'hf://kyutai/tts-voices/vctk/p329_023.wav' },
  { name: 'Cosette (expressive)', emotions: {
    neutral: 'ex04-ex03_default_001_channel1_3s', calm: 'ex04-ex02_calm_002_channel1_480s', whisper: 'ex04-ex03_whisper_001_channel1_198s',
    happy: 'ex04-ex02_happy_001_channel1_118s', sad: 'ex04-ex01_sad-sympathetic_001_channel1_267s', angry: 'ex04-ex02_angry_001_channel1_119s',
    fearful: 'ex04-ex02_fearful_001_channel1_316s', awe: 'ex04-ex02_awe_001_channel1_982s', bored: 'ex04-ex02_bored_001_channel1_254s',
    confused: 'ex04-ex02_confused_001_channel1_499s', desire: 'ex04-ex02_desire_001_channel1_657s', disgusted: 'ex04-ex02_disgusted_004_channel1_169s',
    sarcastic: 'ex04-ex02_sarcastic_001_channel1_519s', laughing: 'ex04-ex02_laughing_001_channel1_147s', fast: 'ex04-ex03_fast_001_channel1_208s',
    projected: 'ex04-ex03_projected_001_channel1_192s', narration: 'ex04-ex01_narration_001_channel1_605s' } },
  { name: 'Expressive 2', emotions: {
    calm: 'ex03-ex01_calm_001_channel1_1143s', happy: 'ex03-ex01_happy_001_channel1_334s', sad: 'ex03-ex02_sad-sympathetic_001_channel1_454s',
    angry: 'ex03-ex01_angry_001_channel1_201s', awe: 'ex03-ex01_awe_001_channel1_1323s', confused: 'ex03-ex01_confused_001_channel1_909s',
    desire: 'ex03-ex01_desire_004_channel1_545s', disgusted: 'ex03-ex01_disgusted_004_channel1_170s', sarcastic: 'ex03-ex01_sarcastic_001_channel1_435s',
    sleepy: 'ex03-ex01_sleepy_001_channel1_619s', laughing: 'ex03-ex01_laughing_001_channel1_188s', narration: 'ex03-ex02_narration_001_channel1_674s' } },
  { name: 'Expressive 3', emotions: {
    neutral: 'ex01-ex02_default_001_channel1_168s', whisper: 'ex01-ex02_whisper_001_channel1_579s', fast: 'ex01-ex02_fast_001_channel1_104s',
    projected: 'ex01-ex02_projected_001_channel1_46s', enunciated: 'ex01-ex02_enunciated_001_channel1_432s' } },
  { name: 'Narrator', url: 'hf://kyutai/tts-voices/unmute-prod-website/ex04_narration_longform_00001.wav' },
  { name: 'Alba', url: 'hf://kyutai/tts-voices/alba-mackenna/casual.wav' },
  { name: 'Marius', url: 'hf://kyutai/tts-voices/voice-donations/Selfie.wav' },
  { name: 'Javert', url: 'hf://kyutai/tts-voices/voice-donations/Butter.wav' },
  { name: 'Jean', url: 'hf://kyutai/tts-voices/ears/p010/freeform_speech_01_enhanced.wav' },
  { name: 'Anna', url: 'hf://kyutai/tts-voices/vctk/p228_023_enhanced.wav' },
  { name: 'Vera', url: 'hf://kyutai/tts-voices/vctk/p229_023_enhanced.wav' },
  { name: 'Fantine', url: 'hf://kyutai/tts-voices/vctk/p244_023_enhanced.wav' },
  { name: 'Charles', url: 'hf://kyutai/tts-voices/vctk/p254_023_enhanced.wav' },
  { name: 'Paul', url: 'hf://kyutai/tts-voices/vctk/p259_023_enhanced.wav' },
  { name: 'George', url: 'hf://kyutai/tts-voices/vctk/p315_023_enhanced.wav' },
  { name: 'Mary', url: 'hf://kyutai/tts-voices/vctk/p333_023_enhanced.wav' },
  { name: 'Michael', url: 'hf://kyutai/tts-voices/vctk/p360_023_enhanced.wav' },
  { name: 'Eve', url: 'hf://kyutai/tts-voices/vctk/p361_023_enhanced.wav' },
  { name: 'Bill', url: 'hf://kyutai/tts-voices/voice-zero/bill_boerst.wav' },
  { name: 'Peter', url: 'hf://kyutai/tts-voices/voice-zero/peter_yearsley.wav' },
  { name: 'Stuart', url: 'hf://kyutai/tts-voices/voice-zero/stuart_bell.wav' },
  { name: 'Caro', url: 'hf://kyutai/tts-voices/voice-zero/caro_davy.wav' }
];
const emotionsOf = (name) => Object.keys((VOICES.find((v) => v.name === name) || {}).emotions || {});
function voiceUrl(name, emotion) {
  const v = VOICES.find((x) => x.name === name) || VOICES[0];
  if (!v.emotions) return v.url;
  const file = v.emotions[emotion] || v.emotions.neutral || v.emotions.calm || Object.values(v.emotions)[0];
  return X + file + '.wav';
}

// Pitch (semitones) and speed (×) applied after the voice is generated, through ffmpeg, as it streams.
const { spawn } = require('child_process');
function shaper(pitch, speed, onPcm) {
  pitch = Number(pitch) || 0; speed = Number(speed) || 1;
  if (Math.abs(pitch) < 0.05 && Math.abs(speed - 1) < 0.02) return null;
  const p = Math.pow(2, pitch / 12);
  let tempo = speed / p; const tempos = [];
  while (tempo > 2) { tempos.push(2); tempo /= 2; }
  while (tempo < 0.5) { tempos.push(0.5); tempo /= 0.5; }
  tempos.push(tempo);
  const af = `asetrate=${Math.round(RATE * p)},aresample=${RATE},` + tempos.map((t) => `atempo=${t.toFixed(4)}`).join(',');
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0',
    '-af', af, '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-flush_packets', '1', 'pipe:1']);
  ff.stdout.on('data', (d) => onPcm(Buffer.from(d)));
  ff.on('error', () => {});
  ff.stdin.on('error', () => {});
  const done = new Promise((r) => ff.on('close', r));
  return { write: (b) => ff.stdin.write(b), end: () => { ff.stdin.end(); return done; }, kill: () => ff.kill('SIGKILL') };
}

module.exports = { VOICES, voiceUrl, emotionsOf, shaper, TTS_URL, Vad, transcribe, think, speak, WavStreamDecoder, wavBytes, floatToInt16Buf, RATE, MOCK };
