// Runs on the audio thread.

// Passes mic samples to the main thread.
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);

// Plays incoming chunks with a small jitter buffer.
// Waits for ~80 ms before starting, re-buffers after a gap, drops audio if it falls >400 ms behind.
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.buffered = 0;
    this.playing = false;
    this.target = Math.round(sampleRate * 0.08);
    this.max = Math.round(sampleRate * 0.4);
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'flush') { this.queue = []; this.offset = 0; this.buffered = 0; this.playing = false; return; }
      this.queue.push(d);
      this.buffered += d.length;
      while (this.buffered > this.max && this.queue.length > 1) {
        const q = this.queue.shift();
        this.buffered -= q.length - this.offset;
        this.offset = 0;
      }
    };
  }
  process(inputs, outputs) {
    const outs = outputs[0];
    const out = outs[0];
    let i = 0;
    if (!this.playing && this.buffered >= this.target) this.playing = true;
    if (this.playing) {
      while (i < out.length && this.queue.length) {
        const q = this.queue[0];
        const n = Math.min(out.length - i, q.length - this.offset);
        out.set(q.subarray(this.offset, this.offset + n), i);
        i += n; this.offset += n; this.buffered -= n;
        if (this.offset >= q.length) { this.queue.shift(); this.offset = 0; }
      }
      if (i < out.length) this.playing = false;
    }
    for (; i < out.length; i++) out[i] = 0;
    for (let c = 1; c < outs.length; c++) outs[c].set(out);
    return true;
  }
}
registerProcessor('playback', PlaybackProcessor);
