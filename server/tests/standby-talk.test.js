// Before Start session (standby), holding a phone key and speaking in the AI voice still reaches the phone,
// the same as a typed line: it is a rehearsal, so no visit starts and nothing is recorded.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const WebSocket = require('ws');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (check()) return; await pause(10); } throw new Error('Timed out: ' + label); }

test('held AI-voice talk is spoken to a phone before the session starts', { timeout: 30000 }, async (t) => {
  const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'earpiece-standby-'));
  let child; const sockets = new Set();
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (const f of fs.readdirSync(root).filter((f) => f.endsWith('.js'))) fs.copyFileSync(path.join(root, f), path.join(tmp, f));
  fs.cpSync(path.join(root, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(tmp, '.keys.json'), JSON.stringify({ phone: 'phone', control: 'control', monitor: 'monitor', join: 'join' }));
  fs.writeFileSync(path.join(tmp, 'cameras.json'), '[]');
  fs.appendFileSync(path.join(tmp, 'ai.js'), '\nmodule.exports.transcribe = async () => "Hello from the desk";\n');
  const r = net.createServer(); r.listen(0, '127.0.0.1'); await once(r, 'listening'); const port = r.address().port; await new Promise((ok) => r.close(ok));
  child = spawn(process.execPath, [path.join(tmp, 'server.js')], { env: { PATH: process.env.PATH, PORT: String(port), MOCK_AI: '1', NO_OPEN: '1', NO_TUNNEL: '1', NO_CATALOGUE: '1', MAX_PHONES: '2', PUBLIC_URL: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  await until(() => out.includes('STANDBY') || child.exitCode !== null, 'server startup');
  async function connect(role, device) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&k=${role}${device ? '&device=' + device : ''}`); sockets.add(ws);
    const messages = [], binary = []; ws.on('error', () => {});
    ws.on('message', (d, bin) => { if (bin) binary.push(Buffer.from(d)); else messages.push(JSON.parse(d)); });
    await once(ws, 'open'); await until(() => messages.length, 'initial messages');
    return { ws, messages, binary, send: (m) => ws.send(JSON.stringify(m)) };
  }
  const control = await connect('control'), phone = await connect('phone', 1);
  phone.send({ type: 'hello' });
  await until(() => control.messages.some((m) => m.type === 'state' && m.id === 1 && m.audioReady), 'phone ready');
  const before = phone.binary.length, mark = control.messages.length;
  control.send({ type: 'talk', target: [1], on: true, as: 'voice' });
  const packet = Buffer.alloc(962); packet.writeUInt16LE(1); Buffer.alloc(960, 0x12).copy(packet, 2);
  for (let i = 0; i < 5; i++) { control.ws.send(packet); await pause(100); }
  control.send({ type: 'talk', target: 1, on: false, as: 'voice' });
  await until(() => control.messages.slice(mark).some((m) => m.type === 'transcript' && m.who === 'voiced' && /Hello from the desk/.test(m.text)), 'spoken in the AI voice');
  await until(() => phone.binary.length > before, 'phone receives the AI voice');
  assert.ok(control.messages.slice(mark).some((m) => m.type === 'transcript' && /Rehearsal/.test(m.text || '')));
  assert.ok(!control.messages.slice(mark).some((m) => m.type === 'error' && /not recording yet/.test(m.text || '')), 'no "press Start session" refusal');
  assert.ok(control.messages.slice(mark).filter((m) => m.type === 'state' && m.id === 1).every((m) => m.waiting), 'no visit started');
});
