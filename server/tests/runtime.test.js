const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const WebSocket = require('ws');
const { Vad } = require('../ai');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (check()) return; await pause(10); }
  throw new Error('Timed out: ' + label);
}

test('speech detection resets all buffered speech between visits', () => {
  let utterances = 0;
  const vad = new Vad({ onUtterance: () => utterances++ });
  const loud = Buffer.alloc(960); for (let i = 0; i < 480; i++) loud.writeInt16LE(6000, i * 2);
  for (let i = 0; i < 10; i++) vad.push(loud);
  assert.equal(vad.speaking, true);
  vad.reset();
  for (let i = 0; i < 40; i++) vad.push(Buffer.alloc(960));
  assert.equal(utterances, 0);
  assert.equal(vad.speaking, false);
});

test('recording server connection, visit and audio isolation regressions', { timeout: 30000 }, async (t) => {
  // All writes, recordings and keys belong to this disposable copy; no live devices or APIs are used.
  const root = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'earpiece-test-'));
  let child;
  const sockets = new Set();
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    if (child && child.exitCode === null && !child.signalCode) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.js'))) fs.copyFileSync(path.join(root, file), path.join(tmp, file));
  fs.cpSync(path.join(root, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(tmp, '.keys.json'), JSON.stringify({ phone: 'phone', control: 'control', monitor: 'monitor', join: 'join' }));
  fs.writeFileSync(path.join(tmp, 'cameras.json'), '[]');
  fs.appendFileSync(path.join(tmp, 'ai.js'), '\nmodule.exports.transcribe = async () => { await new Promise(r => setTimeout(r, 300)); return "Delayed speech from the previous visit"; };\nmodule.exports.think = async () => "[silence]";\n');
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, [path.join(tmp, 'server.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), EARPIECE_MODE: 'record', MOCK_AI: '1', AI_MODE: 'off', NO_OPEN: '1', NO_TUNNEL: '1', NO_CATALOGUE: '1', MAX_PHONES: '2', PUBLIC_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = ''; child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
  await until(() => output.includes('CONTROL ROOM') || child.exitCode !== null, 'server startup');
  assert.equal(child.exitCode, null, output);
  const info = await (await fetch(`http://127.0.0.1:${port}/api/info?k=control`)).json();
  const dir = path.join(tmp, 'recordings', info.name);
  async function connect(role, device) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&k=${role}${device ? '&device=' + device : ''}`);
    sockets.add(ws); const messages = [], binary = [];
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => { if (isBinary) binary.push(Buffer.from(data)); else messages.push(JSON.parse(data)); });
    await once(ws, 'open');
    await until(() => messages.length, 'initial messages');
    return { ws, messages, binary, send: (m) => ws.send(JSON.stringify(m)) };
  }
  const control = await connect('control'), phone1 = await connect('phone', 1), phone2 = await connect('phone', 2);
  const pcm = Buffer.alloc(960, 0x12);
  const start = async (id, pid) => {
    const before = control.messages.length;
    control.send({ type: 'personSave', pid, name: pid });
    control.send({ type: 'personStart', pid, phone: id });
    await until(() => control.messages.slice(before).some((m) => m.type === 'state' && m.id === id && !m.waiting && m.name === pid), 'desk starts ' + pid);
  };
  const end = async (id) => {
    const before = control.messages.length;
    control.send({ type: 'end', id });
    await until(() => control.messages.slice(before).some((m) => m.type === 'state' && m.id === id && m.waiting), 'desk ends visit');
  };
  const request = (route, body, key = 'control') => fetch(`http://127.0.0.1:${port}/api/${route}${route.includes('?') ? '&' : '?'}k=${key}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await t.test('operator pages load and phones cannot start their own participant visit', async () => {
    for (const page of ['phones', 'session', 'screens']) {
      const response = await fetch(`http://127.0.0.1:${port}/${page}?k=control`);
      assert.equal(response.status, 200); assert.match(await response.text(), /setup\.js/);
    }
    phone1.send({ type: 'begin', name: 'Must not start' }); await pause(50);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'))).participants.length, 0);
    phone1.send({ type: 'hello' });
    await until(() => control.messages.some(m => m.type === 'state' && m.id === 1 && m.audioReady), 'audio readiness reported');
    const phones = await (await request('phones')).json();
    assert.equal(phones.devices[0].audioReady, true); assert.equal(phones.devices[0].waiting, true);
  });

  await t.test('dedicated session page saves brief and details; rejects stale edits and wrong keys', async () => {
    const data = await (await request('setup')).json();
    assert.equal((await request('session-meta', { instance: data.instance, title: 'Rehearsal', notes: 'Session context' })).status, 200);
    assert.equal((await request('brief', { instance: data.instance, text: 'Give short, clear directions.' })).status, 200);
    const saved = await (await request('setup')).json();
    assert.equal(saved.title, 'Rehearsal'); assert.equal(saved.notes, 'Session context'); assert.equal(saved.brief, 'Give short, clear directions.');
    assert.equal((await request('session-meta', { instance: 0, title: 'Stale title' })).status, 409);
    assert.equal((await request('phones', { action: 'add' }, 'phone')).status, 403);
    assert.equal((await request('setup', undefined, 'phone')).status, 403);
    assert.ok(control.messages.some(m => m.type === 'session' && m.title === 'Rehearsal'));
    assert.ok(control.messages.some(m => m.type === 'brief' && m.saved));
  });

  await t.test('add permanent phone slots beyond four without disconnecting existing phones', async () => {
    for (let n = 3; n <= 5; n++) {
      const r = await (await request('phones', { action: 'add' })).json();
      assert.equal(r.maxPhones, n); assert.equal(r.devices.length, n);
    }
    assert.equal(phone1.ws.readyState, WebSocket.OPEN); assert.equal(phone2.ws.readyState, WebSocket.OPEN);
    await until(() => control.messages.some(m => m.type === 'phonesChanged' && m.maxPhones === 5), 'desk updates slot count');
    const fifth = await connect('phone', 5);
    assert.ok(fifth.messages.some(m => m.type === 'welcome' && m.id === 5));
    const qr = await (await request('phone-qr?device=5')).json();
    assert.match(qr.url, /device=5$/); assert.match(qr.qr, /<svg/);
    assert.equal((await request('phone-qr?device=6')).status, 404);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, '.settings.json'))).phoneCount, 5);
    assert.equal((await (await request('info')).json()).maxPhones, 5);
    fifth.ws.close();
  });

  await t.test('unauthenticated malformed WebSocket frame does not crash recording', async () => {
    const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {}); socket.on('data', () => {});
    await once(socket, 'connect');
    const request = 'GET /ws?role=phone&k=invalid HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';
    socket.write(Buffer.concat([Buffer.from(request), Buffer.from([0x83, 0x80, 0, 0, 0, 0])]));
    await until(() => output.includes('Invalid WebSocket frame'), 'protocol error handled'); socket.destroy();
    assert.equal(child.exitCode, null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/info?k=control`)).status, 200);
  });

  await t.test('waiting microphone is discarded; active microphone goes only to desk and recording', async () => {
    phone1.ws.send(pcm); await pause(80);
    assert.equal(control.binary.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'audio', 'phone1-mic.wav')), false);
    await start(1, 'First'); await start(2, 'Second');
    phone1.ws.send(pcm);
    await until(() => control.binary.length === 1, 'desk receives participant audio');
    assert.equal(control.binary[0].readUInt16LE(0), 1);
    assert.deepEqual(control.binary[0].subarray(2), pcm);
    assert.equal(phone1.binary.length, 0); assert.equal(phone2.binary.length, 0);
    assert.ok(fs.statSync(path.join(dir, 'audio', 'phone1-mic.wav')).size > 44);
    await end(1);
    const bytes = fs.statSync(path.join(dir, 'audio', 'phone1-mic.wav')).size;
    phone1.ws.send(pcm); await pause(80);
    assert.equal(control.binary.length, 1);
    assert.equal(fs.statSync(path.join(dir, 'audio', 'phone1-mic.wav')).size, bytes);
  });

  await t.test('participant transcription from an ended visit is discarded', async () => {
    await start(1, 'Previous');
    const loud = Buffer.alloc(960); for (let i = 0; i < 480; i++) loud.writeInt16LE(6000, i * 2);
    for (let i = 0; i < 8; i++) phone1.ws.send(loud);
    for (let i = 0; i < 40; i++) phone1.ws.send(Buffer.alloc(960));
    // A ping response is ordered after the audio messages on this connection.
    const pong = once(phone1.ws, 'pong'); phone1.ws.ping(); await pong;
    await end(1); await start(1, 'Previous'); await pause(400);   // same person, different visit
    assert.equal(control.messages.some((m) => m.type === 'transcript' && m.who === 'participant'), false);
    assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('Delayed speech'), false);
    // Prove the transcription fixture works for a visit that remains active.
    for (let i = 0; i < 8; i++) phone1.ws.send(loud);
    for (let i = 0; i < 40; i++) phone1.ws.send(Buffer.alloc(960));
    await until(() => control.messages.some((m) => m.type === 'transcript' && m.who === 'participant'), 'current visit transcription');
  });

  await t.test('AI voice reaches only its assigned participant', async () => {
    const before1 = phone1.binary.length, before2 = phone2.binary.length;
    control.send({ type: 'speak', id: 1, text: 'A private direction for phone one.' });
    await until(() => phone1.binary.length > before1, 'assigned phone receives AI audio');
    assert.equal(phone2.binary.length, before2);
    const before = control.messages.length; control.send({ type: 'mode', id: 1, mode: 'off' });
    await until(() => control.messages.slice(before).some((m) => m.type === 'state' && m.id === 1 && !m.speaking), 'AI playback stopped');
  });

  await t.test('director routes to selected phone; another desk cannot steal or stop talk', async () => {
    const other = await connect('control');
    const before1 = phone1.binary.length, before2 = phone2.binary.length;
    control.send({ type: 'talk', target: 1, on: true });
    const packet = Buffer.alloc(962); packet.writeUInt16LE(1); pcm.copy(packet, 2);
    control.ws.send(packet);
    await until(() => phone1.binary.length > before1, 'selected participant hears director');
    assert.equal(phone2.binary.length, before2);
    const before = other.messages.length;
    other.send({ type: 'talk', target: 2, on: true }); other.send({ type: 'talk', on: false });
    other.ws.send(Buffer.from([2, 0, 1, 0])); other.ws.close(); await pause(80);
    assert.equal(phone2.binary.length, before2);
    assert.equal(other.messages.slice(before).some((m) => m.type === 'state' && m.id === 1 && !m.held), false);
    const marker = control.messages.length;
    control.send({ type: 'talk', on: false });
    await until(() => control.messages.slice(marker).some((m) => m.type === 'state' && m.id === 1 && !m.held), 'owner releases talk');
  });

  await t.test('delayed director voice is not played to the next visit', async () => {
    control.send({ type: 'talk', target: 1, on: true, as: 'voice' });
    const packet = Buffer.alloc(962); packet.writeUInt16LE(1); pcm.copy(packet, 2);
    control.ws.send(packet); control.send({ type: 'talk', on: false });
    await end(1); await start(1, 'Next');
    const before = phone1.binary.length; await pause(400);
    assert.equal(phone1.binary.length, before);
    assert.equal(control.messages.some((m) => m.type === 'transcript' && m.who === 'voiced'), false);
  });

  await t.test('disconnecting talk owner releases all held phones', async () => {
    const observer = await connect('control');
    control.send({ type: 'talk', target: 0, on: true });
    await until(() => [1, 2].every((id) => observer.messages.some((m) => m.type === 'state' && m.id === id && m.held)), 'both phones held');
    const counts = [phone1.binary.length, phone2.binary.length];
    control.ws.send(Buffer.concat([Buffer.alloc(2), pcm]));
    await until(() => phone1.binary.length > counts[0] && phone2.binary.length > counts[1], 'explicit talk-to-all reaches both phones');
    const before = observer.messages.length; control.ws.terminate();
    await until(() => [1, 2].every((id) => observer.messages.slice(before).some((m) => m.type === 'state' && m.id === id && !m.held)), 'disconnect releases both phones');
    // Short binary and valid JSON primitives must also be harmless.
    observer.ws.send(Buffer.alloc(1)); observer.ws.send('null'); phone1.ws.send('null');
    await pause(80); assert.equal(child.exitCode, null);
  });

  await t.test('added phone slots survive a server restart', async () => {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    child = spawn(process.execPath, [path.join(tmp, 'server.js')], {
      env: { PATH: process.env.PATH, PORT: String(port), MOCK_AI: '1', NO_OPEN: '1', NO_TUNNEL: '1', NO_CATALOGUE: '1', MAX_PHONES: '2' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let ready = false; child.stdout.on('data', d => { if (String(d).includes('CONTROL ROOM')) ready = true; }); child.stderr.on('data', () => {});
    await until(() => ready, 'server restarts');
    assert.equal((await (await request('phones')).json()).maxPhones, 5);
  });
});
