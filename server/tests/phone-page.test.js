const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function phonePage(userAgent = 'Desktop browser') {
  const html = fs.readFileSync(path.join(__dirname, '../public/phone.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const elements = new Map(), sockets = [], audioTrack = { enabled: true };
  let microphoneChunk;
  function element(id) {
    if (!elements.has(id)) elements.set(id, { style: {}, hidden: true, disabled: false, textContent: '', firstElementChild: { style: {} }, play: async () => {} });
    return elements.get(id);
  }
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(data); }
  }
  class AudioContext {
    constructor() { this.audioWorklet = { addModule: async () => {} }; this.state = 'running'; }
    async resume() {}
  }
  const context = {
    document: { getElementById: element, addEventListener() {} },
    location: { search: '?k=test-key&device=5', origin: 'https://mother.example.test', protocol: 'https:', host: 'mother.example.test' },
    navigator: { userAgent }, sessionStorage: { getItem: () => null, setItem() {} },
    window: { AudioContext }, WebSocket: Socket, URLSearchParams, setTimeout, requestAnimationFrame() {},
    openMic: async () => ({ stream: { getAudioTracks: () => [audioTrack] }, onChunk: fn => { microphoneChunk = fn; } }),
    makePlayer: () => ({ push() {}, flush() {}, level: () => 0 }), rms: () => 0,
    floatToInt16: () => new Int16Array(480), alert: message => { throw new Error(message); }
  };
  vm.runInNewContext(script, context, { filename: 'phone.html' });
  return { elements, sockets, audioTrack, chunk: () => microphoneChunk(new Float32Array(480)), element };
}

test('opening phone setup does not replace a native connection; browser audio follows desk visits', async () => {
  const p = phonePage();
  assert.equal(p.sockets.length, 0);
  await p.element('start').onclick();
  assert.equal(p.sockets.length, 1);
  const ws = p.sockets[0]; ws.readyState = 1; ws.onopen();
  ws.onmessage({ data: JSON.stringify({ type: 'welcome', id: 5, waiting: true }) });
  assert.equal(p.audioTrack.enabled, false); p.chunk();
  assert.equal(ws.sent.filter(x => typeof x !== 'string').length, 0);
  ws.onmessage({ data: JSON.stringify({ type: 'welcome', id: 5, waiting: false, name: 'Test' }) });
  assert.equal(p.audioTrack.enabled, true); p.chunk();
  assert.equal(ws.sent.filter(x => typeof x !== 'string').length, 1);
  ws.onmessage({ data: JSON.stringify({ type: 'reset' }) });
  assert.equal(p.audioTrack.enabled, false); p.chunk();
  assert.equal(ws.sent.filter(x => typeof x !== 'string').length, 1);
  assert.equal(ws.sent.some(x => typeof x === 'string' && JSON.parse(x).type === 'begin'), false);
});

test('Android setup offers the native Mother app without opening a second connection', () => {
  const p = phonePage('Android');
  assert.equal(p.sockets.length, 0); assert.equal(p.element('native').hidden, false);
  const link = new URL(p.element('native').href);
  assert.equal(link.protocol, 'earpiece:'); assert.equal(link.searchParams.get('device'), '5');
  assert.equal(link.searchParams.get('server'), 'https://mother.example.test');
});
