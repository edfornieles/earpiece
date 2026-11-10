// Live mode: one OpenAI Realtime connection per phone that hears, sees and speaks.
// The phone's microphone streams straight in (24 kHz PCM, the same format the phones already use);
// speech comes straight back. Each time the participant finishes speaking, or the camera notices them
// do something, Mother attaches what it can see (a wide picture of the room, a close-up of the
// participant, and the tracking notes) and then answers. Old pictures are removed from the
// conversation so it stays small.
const WebSocket = require('ws');

const KEEP_IMAGES = 5, EVENT_GAP_MS = 8000;

class LiveAgent {
  // hooks: audio(pcm), responseDone(), speechStarted(), heard(text), said(text),
  //        see() → {images:[{jpeg, detail, label} or {data, mime, caption, detail}], note},
  //        playedMs(), log(type, data)
  constructor({ key, model, voice, instructions, hooks, WS = WebSocket }) {
    Object.assign(this, { key, model: model || 'gpt-realtime', voice: voice || 'marin', instructions, h: hooks, WS });
    this.ws = null; this.ready = false; this.responding = false; this.userSpeaking = false;
    this.images = []; this.contextItem = null; this.generation = 0; this.seq = 0; this.itemId = null; this.lastEventAt = 0; this.pendingEvent = null; this.closed = false;
  }
  open() {
    const ws = new this.WS(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`, { headers: { authorization: `Bearer ${this.key}` } });
    this.ws = ws;
    this.watchdog = setTimeout(() => this.fail('Realtime voice did not become ready.'), 10000);
    ws.on('open', () => {
      this.send({ type: 'session.update', session: {
        type: 'realtime', output_modalities: ['audio'], instructions: this.instructions,
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-4o-transcribe' },
            // Mother decides when to answer, so it can attach what it sees first.
            turn_detection: { type: 'server_vad', create_response: false, interrupt_response: true, silence_duration_ms: 500, prefix_padding_ms: 300, threshold: 0.5 } },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: this.voice },
        },
      } });
      this.h.log('live_open', { model: this.model, voice: this.voice });
    });
    ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } this.onEvent(m); });
    ws.on('close', (code) => { if (!this.closed && this.ws === ws) this.fail(`Realtime voice disconnected (${code}).`, true); });
    ws.on('error', (error) => { if (!this.closed && this.ws === ws) this.fail(error.message, true); });
  }
  send(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  close() { this.closed = true; clearTimeout(this.watchdog); try { this.ws?.close(); } catch {} }
  // retry: the connection dropped or OpenAI ended the session (they cap its length). Reconnect quietly a few
  // times before giving up on Live and handing back to the standard voice.
  fail(message, retry = false) {
    if (this.closed) return;
    if (retry && this.wasReady && (this.reconnects || 0) < 3) {
      this.reconnects = (this.reconnects || 0) + 1;
      this.h.log('live_reconnect', { why: message, attempt: this.reconnects });
      clearTimeout(this.watchdog);
      const old = this.ws; this.ws = null; try { old?.removeAllListeners?.(); old?.close(); } catch {}
      Object.assign(this, { ready: false, responding: false, busy: false, userSpeaking: false, images: [], contextItem: null, itemId: null, reconnecting: true });
      setTimeout(() => { if (!this.closed) this.open(); }, 500);
      return;
    }
    this.h.log('live_error', {error:message});
    this.close();
    this.h.fallback?.(message);
  }
  request(response) {
    this.responding = true;
    this.itemId = null;
    this.hadAudio = false;
    this.cancelled = false;
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.fail('Realtime voice did not send audio.'), 12000);
    this.send({ type:'response.create', ...(response ? {response} : {}) });
  }
  // The room changed (furniture moved): give the conversation the new description.
  setInstructions(text) { this.instructions = text; if (this.ready) this.send({ type: 'session.update', session: { type: 'realtime', instructions: text } }); }
  append(pcm) { if (this.ready) this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') }); }

  onEvent(m) {
    if (this.closed) return;
    switch (m.type) {
      case 'session.updated': if (!this.ready) { clearTimeout(this.watchdog); this.ready = true; this.wasReady = true; this.h.log('live_ready', {}); if (this.reconnecting) { this.reconnecting = false; this.nextTurn(); } else this.onReady?.(); } break;
      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true; this.generation++;
        if (this.responding) {   // they talked over Mother: stop, and tell the model how much was actually heard
          this.cancel();
          if (this.itemId) this.send({ type: 'conversation.item.truncate', item_id: this.itemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(this.h.playedMs())) });
        }
        this.h.speechStarted();
        break;
      case 'input_audio_buffer.speech_stopped': this.userSpeaking = false; break;
      case 'input_audio_buffer.committed': if (this.ready && !this.userSpeaking) this.respond('speech'); break;
      case 'conversation.item.input_audio_transcription.completed': if (m.transcript?.trim()) this.h.heard(m.transcript.trim()); break;
      case 'response.created': this.responding = true; this.respondedAt = Date.now(); break;
      case 'response.output_item.added': this.itemId = m.item?.id || null; break;
      case 'response.output_audio.delta': if (m.delta && !this.cancelled) { this.hadAudio = true; clearTimeout(this.watchdog); this.h.audio(Buffer.from(m.delta, 'base64')); } break;
      case 'response.output_audio_transcript.done': if (!this.cancelled && m.transcript?.trim()) this.h.said(m.transcript.trim()); break;
      case 'response.done':
        clearTimeout(this.watchdog);
        this.responding = false; this.doneAt = Date.now();
        if (!this.cancelled && !this.hadAudio) { this.fail(m.response?.status_details?.error?.message || 'Realtime reply contained no audio.'); break; }
        this.cancelled = false;
        this.h.responseDone();
        if (m.response?.status && m.response.status !== 'completed') this.h.log('live_response', { status: m.response.status, why: m.response.status_details?.reason || m.response.status_details?.error?.message || '' });
        this.nextTurn();
        break;
      case 'error': if (!['response_cancel_not_active','item_not_found'].includes(m.error?.code)) this.fail(m.error?.message || 'Realtime voice error.', m.error?.code === 'session_expired'); break;
    }
  }
  // Attach what Mother can see, drop old pictures, then ask for an answer.
  async respond(reason, note = '') {
    if (this.closed || !this.ready || this.userSpeaking || this.h.canSpeak?.()===false) return;
    if (this.responding || this.busy) {
      if (reason === 'speech') this.pendingSpeech = true;
      return;
    }
    const generation = this.generation;
    this.busy = true;
    try {
      const seen = await this.h.see().catch(() => null);
      if (this.closed || this.userSpeaking || this.h.canSpeak?.()===false || generation !== this.generation) return;
      for (const img of seen?.images || []) {
        const id = `img_${++this.seq}`;
        this.send({ type: 'conversation.item.create', item: { id, type: 'message', role: 'user', content: [...(img.caption || img.label ? [{ type: 'input_text', text: img.caption || 'Camera view: ' + img.label }] : []), { type: 'input_image', image_url: `data:${img.mime || 'image/jpeg'};base64,` + Buffer.from(img.data || img.jpeg).toString('base64'), detail: img.detail || 'auto' }] } });
        this.images.push(id);
      }
      while (this.images.length > KEEP_IMAGES) this.send({ type: 'conversation.item.delete', item_id: this.images.shift() });
      const text = [seen?.note && `[What you see right now (camera tracking): ${seen.note}]`, note].filter(Boolean).join('\n');
      if (this.contextItem) {
        this.send({ type: 'conversation.item.delete', item_id: this.contextItem });
        this.contextItem = null;
      }
      if (text) {
        this.contextItem = `scene_${++this.seq}`;
        this.send({type:'conversation.item.create',item:{id:this.contextItem,type:'message',role:'user',content:[{type:'input_text',text}]}});
      }
      this.request();
      this.h.log('live_turn', { reason, images: seen?.images?.length || 0 });
    } finally { this.busy = false; this.nextTurn(); }
  }
  nextTurn() {
    if (this.closed || this.userSpeaking || this.responding || this.busy) return;
    if (this.pendingSay) { const text = this.pendingSay; this.pendingSay = null; this.say(text); return; }
    if (this.pendingSpeech) { this.pendingSpeech = false; this.respond('speech'); return; }
    if (this.pendingEvent) { const event = this.pendingEvent; this.pendingEvent = null; if (Date.now() - (this.doneAt || 0) >= 6000) this.event(event); }
  }
  // Something happened in the room (from tracking): let Mother react, but not too often or over anyone.
  event(text) {
    if (!this.ready) return;
    if (this.responding || this.userSpeaking || this.busy) { this.pendingEvent = text; return; }
    if (Date.now() - this.lastEventAt < EVENT_GAP_MS || Date.now() - (this.doneAt || 0) < 6000) return;   // not right after Mother has spoken
    this.lastEventAt = Date.now();
    this.respond('event', `[${text}]`);
  }
  // A line typed at the desk, spoken in Mother's live voice.
  // If Mother is mid-sentence, the desk's line cuts in: stop, then say it.
  say(text) {
    if (!this.ready || this.closed) return;
    if (this.responding || this.busy) { this.pendingSay = text; this.cancel(); return; }
    this.request({ instructions: `Say exactly this, and nothing else: ${text}` });
  }
  cancel() { this.generation++; if (this.responding) { this.cancelled = true; this.send({ type: 'response.cancel' }); } }
}
module.exports = { LiveAgent };
