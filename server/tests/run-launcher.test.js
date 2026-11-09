const test = require('node:test');
const assert = require('node:assert/strict');
const { Launcher } = require('../run-launcher');

const program = { id: 'p1', title: 'Acconci', revision: 3, roles: [{ id: 'ed', name: 'Performer' }], scenes: [] };
const duo = { ...program, id: 'p2', roles: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };

function setup({ standby = false, phones = [] } = {}) {
  const log = [], state = { status: 'idle' };
  const ph = Object.fromEntries([1, 2, 3, 4].map((id) => [id, { id, connected: false, waiting: true, ready: false, problem: '', ...(phones.find((p) => p.id === id) || {}) }]));
  const runner = { view: () => ({ status: state.status, program: { title: 'Old' } }), start: () => { log.push('start'); state.status = 'running'; }, stop: () => { log.push('stop'); state.status = 'stopped'; } };
  const h = {
    standby, maxPhones: () => 4, program: (id) => [program, duo].find((p) => p.id === id), runner,
    phones: () => Object.values(ph),
    select: (sel) => log.push(['select', sel.assignments]),
    remember: (sel, pending) => log.push(['remember', sel.assignments, !!pending.at]),
    beginVisit: (id) => { log.push(['visit', id]); ph[id].waiting = false; },
    startRecording: () => log.push('record'),
    log: () => {},
  };
  return { launcher: new Launcher(h), log, ph, state };
}

test('roles go to connected phones first', () => {
  const { launcher } = setup({ phones: [{ id: 3, connected: true }] });
  assert.deepEqual(launcher.plan('p2').assignments, { a: 3, b: 1 });
});

test('in standby, Run remembers the program and starts recording', () => {
  const { launcher, log } = setup({ standby: true });
  assert.equal(launcher.run({ id: 'p1' }).phase, 'recording');
  assert.deepEqual(log, [['remember', { ed: 1 }, true], 'record']);
});

test('while recording, Run starts the visit and then the score once the phone is ready', () => {
  const { launcher, log, ph } = setup({ phones: [{ id: 1, connected: true, problem: 'connect the earpiece' }] });
  assert.equal(launcher.run({ id: 'p1' }).phase, 'waiting');
  assert.deepEqual(log.slice(0, 2), [['select', { ed: 1 }], ['visit', 1]]);
  assert.deepEqual(launcher.status().waitingFor, [{ phone: 1, reason: 'connect the earpiece' }]);
  ph[1].ready = true; ph[1].problem = '';
  launcher.tick();
  assert.equal(log.at(-1), 'start');
  assert.equal(launcher.status(), null);
});

test('a run remembered through the restart carries on', () => {
  const { launcher, log, ph } = setup();
  launcher.resume({ snapshot: program, assignments: { ed: 2 } });
  assert.deepEqual(launcher.status().waitingFor, [{ phone: 2, reason: 'connect the phone' }]);
  ph[2].connected = true; launcher.tick();
  assert.deepEqual(log, [['visit', 2]]);
  ph[2].ready = true; launcher.tick();
  assert.equal(log.at(-1), 'start');
});

test('guards: one phone per role, and replacing a running program is explicit', () => {
  const { launcher, log, state } = setup();
  assert.throws(() => launcher.run({ id: 'p2', assignments: { a: 1, b: 1 } }), /its own phone/);
  state.status = 'running';
  assert.throws(() => launcher.run({ id: 'p1' }), /Another program is running/);
  launcher.run({ id: 'p1', replace: true });
  assert.ok(log.includes('stop'));
});

test('Play starts recording in standby, then the visit, then Mother, with no program', () => {
  const s1 = setup({ standby: true, phones: [{ id: 2, connected: true }] });
  s1.launcher.h.rememberPlay = (n) => s1.log.push(['rememberPlay', n]);
  assert.equal(s1.launcher.play().phase, 'recording');
  assert.deepEqual(s1.log, [['rememberPlay', 2], 'record']);
  const s2 = setup({ phones: [{ id: 1, connected: true }] });
  s2.launcher.h.startPlay = (n) => s2.log.push(['play', n]);
  s2.launcher.resumePlay(1); s2.launcher.tick();
  assert.deepEqual(s2.log, [['visit', 1]]);
  s2.ph[1].ready = true; s2.launcher.tick();
  assert.deepEqual(s2.log.at(-1), ['play', 1]);
  assert.ok(!s2.log.includes('start'), 'no score is started');
});
