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
async function speak(text, onPcm, signal, voiceUrl) {
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
const VOICES = [
  ['Watercooler', 'hf://kyutai/tts-voices/vctk/p329_023.wav'],
  ['Narrator', 'hf://kyutai/tts-voices/unmute-prod-website/ex04_narration_longform_00001.wav'],
  ['Alba', 'hf://kyutai/tts-voices/alba-mackenna/casual.wav'],
  ['Marius', 'hf://kyutai/tts-voices/voice-donations/Selfie.wav'],
  ['Javert', 'hf://kyutai/tts-voices/voice-donations/Butter.wav'],
  ['Jean', 'hf://kyutai/tts-voices/ears/p010/freeform_speech_01_enhanced.wav'],
  ['Cosette', 'hf://kyutai/tts-voices/expresso/ex04-ex02_confused_001_channel1_499s.wav'],
  ['Anna', 'hf://kyutai/tts-voices/vctk/p228_023_enhanced.wav'],
  ['Vera', 'hf://kyutai/tts-voices/vctk/p229_023_enhanced.wav'],
  ['Fantine', 'hf://kyutai/tts-voices/vctk/p244_023_enhanced.wav'],
  ['Charles', 'hf://kyutai/tts-voices/vctk/p254_023_enhanced.wav'],
  ['Paul', 'hf://kyutai/tts-voices/vctk/p259_023_enhanced.wav'],
  ['George', 'hf://kyutai/tts-voices/vctk/p315_023_enhanced.wav'],
  ['Mary', 'hf://kyutai/tts-voices/vctk/p333_023_enhanced.wav'],
  ['Michael', 'hf://kyutai/tts-voices/vctk/p360_023_enhanced.wav'],
  ['Eve', 'hf://kyutai/tts-voices/vctk/p361_023_enhanced.wav'],
  ['Bill', 'hf://kyutai/tts-voices/voice-zero/bill_boerst.wav'],
  ['Peter', 'hf://kyutai/tts-voices/voice-zero/peter_yearsley.wav'],
  ['Stuart', 'hf://kyutai/tts-voices/voice-zero/stuart_bell.wav'],
  ['Caro', 'hf://kyutai/tts-voices/voice-zero/caro_davy.wav']
].map(([name, url]) => ({ name, url }));
const voiceUrl = (name) => (VOICES.find((v) => v.name === name) || VOICES[0]).url;

module.exports = { VOICES, voiceUrl, TTS_URL, Vad, transcribe, think, speak, WavStreamDecoder, wavBytes, floatToInt16Buf, RATE, MOCK };
