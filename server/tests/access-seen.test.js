const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const { Access } = require('../access');
test('first and last sign-in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-')); let t = Date.parse('2026-11-16T10:00:00Z');
  const a = new Access(path.join(dir, 'a.json'), { fetchImpl: null, now: () => t });
  a.addUser({ email: 'x@y.z', name: 'X' });
  assert.equal(a.cfg.users[0].lastSeenAt, undefined);
  a.seen('x@y.z'); const first = a.cfg.users[0].firstSeenAt; assert.ok(first);
  t += 30e3; a.seen('x@y.z'); assert.equal(a.cfg.users[0].lastSeenAt, first);   // throttled
  t += 60e3; a.seen('x@y.z'); assert.notEqual(a.cfg.users[0].lastSeenAt, first); assert.equal(a.cfg.users[0].firstSeenAt, first);
  t += 1e3; a.seen('x@y.z', { force: true }); assert.equal(a.cfg.users[0].lastSeenAt, new Date(t).toISOString());
  const b = new Access(path.join(dir, 'a.json'), { fetchImpl: null }); assert.equal(b.cfg.users[0].firstSeenAt, first);
});
