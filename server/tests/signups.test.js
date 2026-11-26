const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Signups, emails, when } = require('../signups');

const store = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mother-signups-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new Signups(dir); };
const consent = { version: 'v1', text: 'You can stop at any time.' };
const ok = { name: 'Ana Silva', email: 'Ana@Example.com', adult: true, agree: true, contact: true, version: 'v1', experience: { kinds: ['Dance or movement', 'Juggling'], level: 'Trained', details: 'Ballet school' } };

test('a sign-up needs a name, an email, 18+, agreement and permission to email; it keeps the exact text agreed to', (t) => {
  const s = store(t);
  for (const [k, re] of [['name', /name/], ['email', /email/], ['adult', /18/], ['agree', /agree/], ['contact', /email you/]]) assert.throws(() => s.add({ ...ok, [k]: k === 'name' || k === 'email' ? '' : false }, consent), re);
  assert.throws(() => s.add({ ...ok, version: 'old' }, consent), /updated/);
  const { signup, isNew } = s.add(ok, consent);
  assert.ok(isNew); assert.equal(signup.email, 'ana@example.com');
  assert.deepEqual(signup.experience, { kinds: ['Dance or movement'], level: 'Trained', details: 'Ballet school' }, 'only known kinds are kept');
  assert.equal(signup.consent.text, 'You can stop at any time.'); assert.ok(signup.token.length >= 20);
  const again = s.add({ ...ok, phone: '0700' }, consent);
  assert.equal(again.isNew, false); assert.equal(again.signup.token, signup.token); assert.equal(s.list().length, 1, 'signing up again updates, never duplicates');
});

test('the schedule: a day filled with slots, places respected, booking and changing and cancelling', (t) => {
  const s = store(t);
  assert.throws(() => s.addSlots({ date: '', start: '10:00', minutes: 30, places: 1 }), /date/);
  const made = s.addSlots({ date: '2026-12-03', start: '10:00', end: '11:30', minutes: 30, places: 1 });
  assert.deepEqual(made.map((x) => x.start), ['10:00', '10:30', '11:00']);
  assert.throws(() => s.addSlots({ date: '2026-12-03', start: '10:00', end: '11:00', minutes: 30, places: 1 }), /already exist/);
  const a = s.add(ok, consent).signup, b = s.add({ ...ok, name: 'Bo', email: 'bo@example.com' }, consent).signup;
  s.book(a.id, made[0].id);
  assert.throws(() => s.book(b.id, made[0].id), /filled up/);
  assert.throws(() => s.editSlot(made[0].id, { places: 0 }), /between/);
  s.editSlot(made[1].id, { closed: true });
  assert.throws(() => s.book(b.id, made[1].id), /closed/); s.book(b.id, made[1].id, 'Ed');   // the team can still book a closed time
  s.book(a.id, made[2].id); assert.equal(s.booked(made[0].id).length, 0, 'changing frees the old place');
  assert.equal(s.cancel(a.id).was.slot, made[2].id); assert.equal(s.get(a.id).booking, null);
  const r = s.removeSlot(made[1].id); assert.deepEqual(r.unbooked.map((x) => x.name), ['Bo']);
});

test("a person's booking page shows only their own details and places left, never other people", (t) => {
  const s = store(t);
  const [x] = s.addSlots({ date: '2026-12-03', start: '14:00', minutes: 45, places: 3, note: 'group' });
  const a = s.add(ok, consent).signup, b = s.add({ ...ok, name: 'Bo', email: 'bo@example.com' }, consent).signup;
  s.book(b.id, x.id);
  const v = s.publicView(a);
  assert.equal(v.name, 'Ana Silva'); assert.equal(v.slots[0].left, 2); assert.equal(JSON.stringify(v).includes('Bo'), false);
  assert.equal(s.byToken(a.token).id, a.id); assert.equal(s.byToken('guess'), null); assert.equal(s.byToken(undefined), null);
});

test('the emails carry the time, the place and their own link', () => {
  const x = { date: '2026-12-03', start: '14:00', minutes: 45, note: '' }, page = { title: 'Take part in Mother', where: 'Studio 4' };
  const m = emails.booked({ name: 'Ana' }, page, 'https://x/book?t=abc', x);
  assert.match(m.subject, /Thursday 3 December at 14:00/); assert.match(m.text, /14:00–14:45/); assert.match(m.text, /Studio 4/); assert.match(m.text, /book\?t=abc/);
  assert.match(emails.schedule({ name: 'Ana' }, page, 'L', [x, { ...x, start: '15:00' }]).text, /Thursday 3 December: 14:00 to 15:45/);
  assert.equal(when(x), 'Thursday 3 December, 14:00–14:45');
});
