const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Sounds, Playing } = require('../sounds');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('uploads become MP3s in the library, with the beep always first; deleting removes the file', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mother-sounds-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'tone.wav');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', src]);
  const lib = new Sounds(path.join(dir, 'lib'));
  const a = await lib.add('Low hum.wav', src, 'Ed');
  assert.equal(a.id, 'low-hum'); assert.equal(a.name, 'Low hum'); assert.equal(a.addedBy, 'Ed');
  assert.ok(Math.abs(a.duration - 1.5) < 0.2, 'duration measured');
  const b = await lib.add('Low hum.wav', src);
  assert.equal(b.id, 'low-hum-2', 'same name gets its own id');
  assert.deepEqual(lib.list().map((x) => x.id), ['beep', 'low-hum', 'low-hum-2']);
  assert.ok(fs.existsSync(lib.file('low-hum')));
  assert.equal(new Sounds(path.join(dir, 'lib')).list().length, 3, 'kept across a restart');
  await assert.rejects(lib.add('notes.txt', path.join(dir, 'missing.txt')), /audio/);
  lib.remove('low-hum');
  assert.equal(lib.file('low-hum'), null);
  assert.throws(() => lib.remove('beep'), /built in/);
  assert.equal(lib.file('../../etc/passwd'), null, 'only library files are ever served');
});

test('what is playing where: loops stay until stopped, one-off sounds expire after their length', () => {
  let now = 0; const p = new Playing(() => now);
  p.start(1, 'beep', false, 'Ed'); p.start(2, 'hum', true, 'Nina'); p.start(2, 'beep', false, 'Nina');
  assert.equal(p.view().length, 3);
  now = 5000; p.expire((id) => (id === 'beep' ? 0.25 : 60));
  assert.deepEqual(p.view().map((x) => [x.phone, x.id, x.loop]), [[2, 'hum', true]]);
  p.stop(2); assert.equal(p.view().length, 0);
});
