// Shared audio helpers for the phone and control pages.
// Wire format: 24 kHz mono int16.

const WIRE_RATE = 24000;

class Resampler {
  constructor(from, to) { this.r = from / to; this.pos = 0; this.last = 0; }
  process(input) {
    if (this.r === 1) return input;
    const L = input.length + 1;
    const out = new Float32Array(Math.ceil((L - 1 - this.pos) / this.r) + 1);
    let p = this.pos, k = 0;
    while (p < L - 1) {
      const i = Math.floor(p), f = p - i;
      const a = i === 0 ? this.last : input[i - 1];
      const b = input[i];
      out[k++] = a + (b - a) * f;
      p += this.r;
    }
    this.pos = p - (L - 1);
    this.last = input[input.length - 1];
    return out.subarray(0, k);
  }
}

function floatToInt16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    o[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return o;
}
function int16ToFloat(i16) {
  const o = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) o[i] = i16[i] / 0x8000;
  return o;
}
function rms(f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / (f.length || 1));
}

// Opens the mic, returns { ctx, onChunk(cb) } where cb gets Float32 chunks at WIRE_RATE (~20 ms each).
async function openMic(ctx) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  });
  const src = ctx.createMediaStreamSource(stream);
  const lp = ctx.createBiquadFilter();            // anti-alias before downsampling
  lp.type = 'lowpass'; lp.frequency.value = 10000;
  const cap = new AudioWorkletNode(ctx, 'capture');
  src.connect(lp).connect(cap);
  const sink = ctx.createGain(); sink.gain.value = 0;   // keep the node pulled by the graph
  cap.connect(sink).connect(ctx.destination);
  const rs = new Resampler(ctx.sampleRate, WIRE_RATE);
  let pending = [], pendingLen = 0, handler = () => {};
  const CHUNK = WIRE_RATE * 0.02;
  cap.port.onmessage = (e) => {
    const r = rs.process(e.data);
    pending.push(r); pendingLen += r.length;
    if (pendingLen >= CHUNK) {
      const out = new Float32Array(pendingLen);
      let o = 0; for (const p of pending) { out.set(p, o); o += p.length; }
      pending = []; pendingLen = 0;
      handler(out);
    }
  };
  return { stream, onChunk: (cb) => (handler = cb) };
}

// A player: feed it int16 at WIRE_RATE, it plays through `dest`.
function makePlayer(ctx, dest) {
  const node = new AudioWorkletNode(ctx, 'playback', { outputChannelCount: [2] });
  node.connect(dest);
  const rs = new Resampler(WIRE_RATE, ctx.sampleRate);
  let level = 0;
  return {
    node,
    push(i16) {
      const f = int16ToFloat(i16);
      level = Math.max(level * 0.8, rms(f));
      node.port.postMessage(rs.process(f));
    },
    level() { level *= 0.92; return level; },
    flush() { node.port.postMessage('flush'); }
  };
}
