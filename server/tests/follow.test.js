const test = require('node:test');
const assert = require('node:assert');
const { pickFocus, frameFor, Follow, LOST_MS } = require('../public/follow-core');

const person = (id, box, pid) => ({ id, visible: true, box, binding: pid ? { person: { pid, name: pid } } : null });
const near = { x: 0.4, y: 0.2, w: 0.2, h: 0.6 }, far = { x: 0.1, y: 0.3, w: 0.08, h: 0.25 };

test('follows the chosen person, else a recognised one, else the biggest', () => {
  const tracks = [person('P1', near), person('P2', far, 'ed'), { id: 'P3', visible: false, box: near }];
  assert.equal(pickFocus(tracks, 'P1').id, 'P1');
  assert.equal(pickFocus(tracks, 'ed').id, 'P2');
  assert.equal(pickFocus(tracks, 'auto').id, 'P2');          // recognised beats bigger
  assert.equal(pickFocus([person('A', far), person('B', near)]).id, 'B');
  assert.equal(pickFocus([], 'auto'), null);
});

test('framing keeps the crop inside the picture with headroom', () => {
  const f = frameFor({ x: 0.9, y: 0.05, w: 0.1, h: 0.5 });
  assert.ok(f.cx + f.h / 2 <= 1 + 1e-9 && f.cy - f.h / 2 >= -1e-9);
  const g = frameFor(near);
  assert.ok(g.cy - g.h / 2 < near.y, 'head has room above it');
  assert.ok(frameFor({ x: 0.5, y: 0.5, w: 0.01, h: 0.02 }).h >= 0.3, 'never zooms in further than the minimum');
});

test('eases onto the person, holds still for small shifts, and goes wide when they are lost', () => {
  const v = new Follow(); let r, t = 0;
  for (let i = 0; i < 120; i++) r = v.step(near, t += 16, 0.016);
  const goal = frameFor(near);
  assert.ok(Math.abs(r.w - goal.h) < 0.02, 'zoomed to the person');
  const before = { ...r };
  for (let i = 0; i < 60; i++) r = v.step({ ...near, x: near.x + 0.005 }, t += 16, 0.016);
  assert.ok(Math.abs(r.x - before.x) < 0.002, 'a small shift does not move the frame');
  for (let i = 0; i < 60; i++) r = v.step(null, t += 16, 0.016);
  assert.ok(r.w < 0.95, 'holds briefly after losing them');
  t += LOST_MS;
  for (let i = 0; i < 200; i++) r = v.step(null, t += 16, 0.016);
  assert.ok(r.w > 0.97, 'then shows the whole room');
});
