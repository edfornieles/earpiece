const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { Access } = require('../access');

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function setup(t, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mother-access-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.access.json');
  fs.writeFileSync(file, JSON.stringify({ users: [{ email: 'Nina@Example.com', name: 'Nina' }, { email: 'ed@example.com', name: 'Ed', role: 'owner' }], teamDomain: 'team.cloudflareaccess.com', aud: 'AUD1', ...cfg }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const a = new Access(file, { fetchImpl: null, now: () => now });
  a.keys.set('k1', publicKey); a.keysAt = now;
  const token = (claims, kid = 'k1', key = privateKey) => {
    const head = enc({ alg: 'RS256', kid }), body = enc({ aud: ['AUD1'], iss: 'https://team.cloudflareaccess.com', exp: now / 1000 + 600, ...claims });
    return head + '.' + body + '.' + crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), key).toString('base64url');
  };
  const req = (headers) => ({ headers });
  return { a, token, req, file };
}

test('inside the studio nothing changes; outside, only a signed login on the list counts as a director', (t) => {
  const { a, token, req } = setup(t);
  assert.deepEqual(a.check(req({})), { remote: false });
  const remote = { 'cf-connecting-ip': '1.2.3.4' };
  assert.equal(a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email: 'nina@example.com' }) })).director, true);
  // Someone not on the list is turned away with a message.
  assert.equal(a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email: 'stranger@example.com' }) })).blocked, 'not-listed');
  // A forged token, an expired one, one for another application, or a bare email header: not logged in.
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const bad of [token({ email: 'nina@example.com' }, 'k1', other), token({ email: 'nina@example.com', exp: 1 }), token({ email: 'nina@example.com', aud: ['OTHER'] })])
    assert.equal(a.check(req({ ...remote, 'cf-access-jwt-assertion': bad })).director, undefined);
  assert.equal(a.check(req({ ...remote, 'cf-access-authenticated-user-email': 'nina@example.com' })).director, undefined);
  // Until logins are required, an outside link with a key still works (needsLogin false); after, it does not.
  assert.equal(a.check(req(remote)).needsLogin, false);
  a.cfg.requireLogin = true;
  assert.equal(a.check(req(remote)).needsLogin, true);
});

test('privacy mode shuts out everyone outside the studio, is announced, and survives a restart', (t) => {
  const { a, token, req, file } = setup(t);
  const seen = []; a.onPrivacy = (on) => seen.push(on);
  a.setPrivacy(true);
  assert.deepEqual(seen, [true]);
  assert.equal(a.check(req({ 'cf-connecting-ip': '1.2.3.4', 'cf-access-jwt-assertion': token({ email: 'nina@example.com' }) })).blocked, 'private');
  assert.deepEqual(a.check(req({})), { remote: false }, 'the studio itself is never shut out');
  assert.equal(new Access(file, { fetchImpl: null }).privacy, true);
  assert.match(a.page('private'), /private/);
});

test('an owner has the desk from anywhere and is the one person privacy mode lets in', (t) => {
  const { a, token, req } = setup(t);
  const remote = { 'cf-connecting-ip': '1.2.3.4' };
  const ed = a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email: 'ed@example.com' }) }));
  assert.equal(ed.director, true); assert.equal(ed.owner, true);
  const nina = a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email: 'nina@example.com' }) }));
  assert.equal(nina.owner, false);
  a.setPrivacy(true);
  assert.equal(a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email: 'ed@example.com' }) })).owner, true, 'the owner still gets in');
  assert.equal(a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email: 'nina@example.com' }) })).blocked, 'private');
  assert.equal(a.check(req(remote)).blocked, 'private', 'no login, no way in');
});

test('the owner adds, re-roles and removes people; there is always one owner', (t) => {
  const { a, token, req, file } = setup(t);
  a.addUser({ email: ' New.Person@Gmail.com ', name: 'New', role: 'director' });
  assert.throws(() => a.addUser({ email: 'new.person@gmail.com' }), /already/);
  assert.throws(() => a.addUser({ email: 'not-an-email' }), /valid email/);
  const remote = { 'cf-connecting-ip': '1.2.3.4' };
  assert.equal(a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email: 'new.person@gmail.com' }) })).director, true, 'in at once, no restart');
  a.setRole('new.person@gmail.com', 'owner');
  assert.equal(a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email: 'new.person@gmail.com' }) })).owner, true);
  a.removeUser('new.person@gmail.com');
  assert.equal(a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email: 'new.person@gmail.com' }) })).blocked, 'not-listed');
  assert.throws(() => a.removeUser('ed@example.com'), /one owner/);
  assert.throws(() => a.setRole('ed@example.com', 'director'), /one owner/);
  assert.equal(new Access(file, { fetchImpl: null }).cfg.users.length, 2, 'saved');
});

test('disconnecting someone keeps them out for a while, never an owner, and names can change', (t) => {
  const { a, token, req } = setup(t);
  const remote = { 'cf-connecting-ip': '1.2.3.4' }, as = (email) => a.check(req({ ...remote, 'cf-access-jwt-assertion': token({ email }) }));
  a.kick('nina@example.com');
  assert.equal(as('nina@example.com').blocked, 'kicked');
  a.unkick('nina@example.com');
  assert.equal(as('nina@example.com').director, true);
  a.kick('ed@example.com');
  assert.equal(as('ed@example.com').owner, true, 'an owner cannot be locked out');
  a.setName('nina@example.com', 'Nina E.');
  assert.equal(as('nina@example.com').name, 'Nina E.');
  assert.throws(() => a.setName('nina@example.com', '  '), /name/);
});
