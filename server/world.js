// Mother's picture of the room: the floor plan put into words, what is around each person from where
// they stand, a map drawn from above, and a memory of when the furniture was last checked and what moved.
// Everything here is cheap (no models): it is built once and shared by every phone.
const fs = require('fs');
const { PNG } = require('pngjs');
const { areaFor } = require('./tracking');

const centre = (fp) => [0, 1].map((i) => fp.points.reduce((a, p) => a + p[i], 0) / fp.points.length);
const m1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const solid = (fp) => (fp.heightM ?? 1) >= 0.05;
const wallsOf = (plan) => { const n = plan.wallNames || {}; return { left: n.left || 'left wall', right: n.right || 'right wall', top: n.top || 'far wall', bottom: n.bottom || 'near wall' }; };
function inside([x, y], pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function segDist([x, y], [ax, ay], [bx, by]) { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0; return Math.hypot(x - ax - t * dx, y - ay - t * dy); }
const polyDist = (p, pts) => inside(p, pts) ? 0 : Math.min(...pts.map((a, i) => segDist(p, a, pts[(i + 1) % pts.length])));
function doorCentre(plan, d) {
  if (d.offsetM == null) return null;
  const c = d.offsetM + d.widthM / 2;
  return d.wall === 'bottom' ? [c, plan.depthM] : d.wall === 'top' ? [c, 0] : d.wall === 'right' ? [plan.widthM, c] : [0, c];
}
// Which way a direction points, in the room's own words (the walls have names).
function towards(plan, d) {
  const w = wallsOf(plan), ax = Math.abs(d[0]), ay = Math.abs(d[1]), h = d[0] > 0 ? w.right : w.left, v = d[1] > 0 ? w.bottom : w.top;
  return ax > 2.4 * ay ? `towards the ${h}` : ay > 2.4 * ax ? `towards the ${v}` : `towards the corner of the ${v} and the ${h}`;
}
// Where a piece of furniture stands, described by the walls.
function placeOf(plan, fp) {
  const w = wallsOf(plan), xs = fp.points.map((p) => p[0]), ys = fp.points.map((p) => p[1]), c = centre(fp);
  const gaps = [[w.left, Math.min(...xs), 'x'], [w.right, plan.widthM - Math.max(...xs), 'x'], [w.top, Math.min(...ys), 'y'], [w.bottom, plan.depthM - Math.max(...ys), 'y']];
  const against = gaps.filter((g) => g[1] < 0.35);
  if (against.length >= 2 && against[0][2] !== against[1][2]) return `in the corner of the ${against[0][0]} and the ${against[1][0]}`;
  if (against.length) {
    const [name, , axis] = against[0], f = axis === 'x' ? c[1] / plan.depthM : c[0] / plan.widthM, ends = axis === 'x' ? [w.top, w.bottom] : [w.left, w.right];
    return `against the ${name}, ${f < 0.36 ? `towards the ${ends[0]} end` : f > 0.64 ? `towards the ${ends[1]} end` : 'about the middle'}`;
  }
  if (Math.abs(c[0] / plan.widthM - 0.5) < 0.2 && Math.abs(c[1] / plan.depthM - 0.5) < 0.2) return 'in the middle of the room';
  const near = gaps.sort((a, b) => a[1] - b[1])[0];
  return `on the open floor, ${m1(near[1])} m out from the ${near[0]}`;
}
// The whole room in plain words. Given once to each conversation; rebuilt when the plan changes.
function briefing(plan, { name = 'The room', camera = null } = {}) {
  if (!plan?.widthM) return '';
  const w = wallsOf(plan), fps = (plan.footprints || []).filter((f) => f.points?.length >= 3);
  const lines = [
    `THE ROOM (your map of the space, from the reviewed floor plan and the camera's furniture checks; use it for where things are, and the pictures and tracking notes for what people are doing):`,
    `${name}: ${m1(plan.widthM)} m wide and ${m1(plan.depthM)} m deep. Standing in the middle facing the ${w.top}, the ${w.right} is on the right, the ${w.left} on the left and the ${w.bottom} behind.`,
    `Position numbers in tracking notes: x is metres from the ${w.left}, y is metres from the ${w.top}.`,
  ];
  for (const d of plan.doors || []) {
    const c = doorCentre(plan, d), wall = w[d.wall] || d.wall, len = d.wall === 'top' || d.wall === 'bottom' ? plan.widthM : plan.depthM;
    const ends = d.wall === 'top' || d.wall === 'bottom' ? [w.left, w.right] : [w.top, w.bottom], f = c ? (d.offsetM + d.widthM / 2) / len : null;
    lines.push(`${d.name}: in the ${wall}${f == null ? '' : f < 0.36 ? `, towards the ${ends[0]} end` : f > 0.64 ? `, towards the ${ends[1]} end` : ', about the middle'}${d.widthM ? ` (${m1(d.widthM)} m wide)` : ''}.`);
  }
  if (fps.length) lines.push('Furniture:');
  for (const fp of fps) {
    const c = centre(fp), near = fps.filter((o) => o !== fp && solid(o)).map((o) => ({ name: o.name, d: polyDist(c, o.points) })).sort((a, b) => a.d - b.d)[0];
    const low = !solid(fp);
    lines.push(`- ${fp.name}${low ? ' (flat on the floor)' : fp.heightM ? ` (${m1(fp.heightM)} m high)` : ''}: ${placeOf(plan, fp)}; centre x ${m1(c[0])}, y ${m1(c[1])}${near && near.d < 1.5 && !low ? `; nearest to it: ${near.name}, ${near.d < 0.15 ? 'touching' : m1(near.d) + ' m'}` : ''}.`);
  }
  if (camera && Number.isFinite(camera.x)) {
    const g = [[w.left, camera.x], [w.right, plan.widthM - camera.x], [w.top, camera.y], [w.bottom, plan.depthM - camera.y]].sort((a, b) => a[1] - b[1])[0];
    lines.push(`Your floor-tracking camera is ${camera.z ? `${m1(camera.z)} m up ` : ''}on the ${g[0]} (x ${m1(camera.x)}, y ${m1(camera.y)}), looking across the room.`);
  }
  lines.push('Talk about the room the way a person would (by the door, at the bench, behind you); never read coordinates aloud.');
  return lines.join('\n');
}
// Which way someone faces: from the way they are walking, else judged from their body in the camera picture.
// Body points are fractions of the picture (hence the aspect ratio); the camera's position on the floor turns
// "towards the camera" into a direction.
function facingOf(track, camera, trail, aspect = 16 / 9) {
  if (trail?.length >= 2) {
    const a = trail[0], b = trail.at(-1), d = [b.p[0] - a.p[0], b.p[1] - a.p[1]], n = Math.hypot(...d);
    if (n >= 0.4) return { dir: [d[0] / n, d[1] / n], how: 'walking' };
  }
  const kp = track?.kp; if (!camera || !track?.floor || !Array.isArray(kp) || kp.length < 13) return null;
  const on = (i) => kp[i] && kp[i][2] >= 0.4;
  const c = [track.floor[0] - camera.x, track.floor[1] - camera.y], n = Math.hypot(...c); if (n < 0.3 || !on(5) || !on(6)) return null;
  const ray = [c[0] / n, c[1] / n], right = [-ray[1], ray[0]];   // the picture's right-hand side, on the floor
  const mid = (kp[5][0] + kp[6][0]) / 2, width = Math.abs(kp[5][0] - kp[6][0]) * aspect;
  const torso = on(11) && on(12) ? Math.abs((kp[11][1] + kp[12][1]) / 2 - (kp[5][1] + kp[6][1]) / 2) : 0;
  if (torso && width / torso < 0.35) {   // side-on: the nose shows which way
    if (!on(0)) return null;
    const s = kp[0][0] > mid ? 1 : -1; return { dir: [right[0] * s, right[1] * s], how: 'body' };
  }
  const face = on(0) && (on(1) || on(2));
  return { dir: face ? [-ray[0], -ray[1]] : ray, how: 'body' };
}
function side(f, d) {
  const a = Math.atan2(f[0] * d[1] - f[1] * d[0], f[0] * d[0] + f[1] * d[1]) * 180 / Math.PI;   // plan seen from above, y down: positive is their right
  return Math.abs(a) <= 45 ? 'in front of them' : Math.abs(a) >= 135 ? 'behind them' : a > 0 ? 'to their right' : 'to their left';
}
// What is around one person, from where they stand. Wall directions are always given (they come from the
// plan); left/right/in front are added when the facing direction is known.
function relative(plan, me, { facing = null, others = [], limit = 5 } = {}) {
  if (!plan || !me?.floor) return '';
  const p = me.floor, things = [];
  for (const fp of (plan.footprints || []).filter((f) => f.points?.length >= 3 && solid(f))) things.push({ name: fp.name, d: polyDist(p, fp.points), c: centre(fp) });
  const near = things.sort((a, b) => a.d - b.d).slice(0, limit);
  for (const d of plan.doors || []) { const c = doorCentre(plan, d); if (c) near.push({ name: d.name, d: Math.hypot(c[0] - p[0], c[1] - p[1]), c }); }
  for (const o of others) if (o.floor) near.push({ name: o.name || 'another person', d: Math.hypot(o.floor[0] - p[0], o.floor[1] - p[1]), c: o.floor, person: true });
  const say = (t) => {
    const v = [t.c[0] - p[0], t.c[1] - p[1]];
    if (t.d < 0.1 && !t.person) return `${t.name}: right at it`;
    return `${t.name}: ${m1(t.d)} m${facing ? ' ' + side(facing.dir, v) : ''} (${towards(plan, v)})`;
  };
  const head = facing ? `They face ${towards(plan, facing.dir)} (${facing.how === 'walking' ? 'from the way they are walking' : 'judged from their body, so left and right may be off: prefer the wall directions'}).` : 'Which way they face is not known, so give directions by walls and objects, not left and right.';
  return ` AROUND THEM: ${head} ${near.map(say).join('; ')}.`;
}

// ---- a map from above, as a picture (for the Live voice, which sees images) ----
const FONT = Object.fromEntries(Object.entries({
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110', C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110', E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001', I: '01110 00100 00100 00100 00100 00100 01110',
  J: '00111 00010 00010 00010 00010 10010 01100', K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 11001 10101 10011 10001 10001 10001', O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000', Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100', U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100', W: '10001 10001 10001 10101 10101 11011 10001', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110', 2: '01110 10001 00001 00010 00100 01000 11111',
  3: '11110 00001 00001 01110 00001 00001 11110', 4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000', 8: '01110 10001 10001 01110 10001 10001 01110',
  9: '01110 10001 10001 01111 00001 00010 01100', '.': '00000 00000 00000 00000 00000 01100 01100', '-': '00000 00000 00000 11111 00000 00000 00000',
}).map(([k, v]) => [k, v.split(' ')]));
const SCALE = 100, PAD = 46;   // pixels per metre; margin for the wall names
function mapPng(plan, people = []) {
  const W = Math.round(plan.widthM * SCALE) + PAD * 2, H = Math.round(plan.depthM * SCALE) + PAD * 2, png = new PNG({ width: W, height: H });
  png.data.fill(255);
  const px = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255; };
  const box = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, c); };
  const line = (a, b, c, t = 2) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1; for (let i = 0; i <= n; i++) box(a[0] + (b[0] - a[0]) * i / n - t / 2, a[1] + (b[1] - a[1]) * i / n - t / 2, t, t, c); };
  const disc = (x, y, r, c) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) px(x + i, y + j, c); };
  const fill = (pts, c) => { const ys = pts.map((p) => p[1]); for (let y = Math.floor(Math.min(...ys)); y <= Math.max(...ys); y++) { const xs = []; pts.forEach((a, i) => { const b = pts[(i + 1) % pts.length]; if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])); }); xs.sort((a, b) => a - b); for (let k = 0; k + 1 < xs.length; k += 2) box(xs[k], y, xs[k + 1] - xs[k], 1, c); } };
  // Text centred on (x, y); "up" writes it reading upwards, for the side walls.
  const text = (x, y, str, c, { s = 2, up = false, back = null } = {}) => {
    const t = String(str).toUpperCase().replace(/[^A-Z0-9.\- ]/g, ''), len = t.length * 6 * s - s, hgt = 7 * s;
    let x0 = Math.round(x - (up ? hgt : len) / 2), y0 = Math.round(y - (up ? len : hgt) / 2);
    x0 = Math.max(2, Math.min(W - (up ? hgt : len) - 2, x0)); y0 = Math.max(2, Math.min(H - (up ? len : hgt) - 2, y0));
    if (back) box(x0 - 2, y0 - 2, (up ? hgt : len) + 4, (up ? len : hgt) + 4, back);
    [...t].forEach((ch, n) => { const g = FONT[ch]; if (!g) return; for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r][q] === '1') up ? box(x0 + r * s, y0 + len - (n * 6 + q + 1) * s, s, s, c) : box(x0 + (n * 6 + q) * s, y0 + r * s, s, s, c); });
  };
  const at = (p) => [PAD + p[0] * SCALE, PAD + p[1] * SCALE], INK = [40, 40, 40], GREY = [120, 120, 120];
  const fps = (plan.footprints || []).filter((f) => f.points?.length >= 3);
  for (const fp of fps.filter((f) => !solid(f))) { const pts = fp.points.map(at); pts.forEach((a, i) => line(a, pts[(i + 1) % pts.length], [190, 190, 190], 1)); }
  for (const fp of fps.filter(solid)) { const pts = fp.points.map(at); fill(pts, [226, 230, 236]); pts.forEach((a, i) => line(a, pts[(i + 1) % pts.length], GREY, 2)); }
  const c = [[0, 0], [plan.widthM, 0], [plan.widthM, plan.depthM], [0, plan.depthM]].map(at); c.forEach((a, i) => line(a, c[(i + 1) % 4], INK, 4));
  for (const d of plan.doors || []) {
    if (d.offsetM == null) continue;
    const h = d.wall === 'top' || d.wall === 'bottom', e = d.wall === 'bottom' ? plan.depthM : d.wall === 'right' ? plan.widthM : 0, a = at(h ? [d.offsetM, e] : [e, d.offsetM]), b = at(h ? [d.offsetM + d.widthM, e] : [e, d.offsetM + d.widthM]);
    line(a, b, [255, 255, 255], 6); line(a, b, [40, 110, 200], 2);
    const mid = doorCentre(plan, d), inwards = d.wall === 'bottom' ? [0, -16] : d.wall === 'top' ? [0, 16] : d.wall === 'right' ? [-30, 0] : [30, 0], q = at(mid);
    text(q[0] + inwards[0], q[1] + inwards[1], d.name, [40, 110, 200], { s: 1, back: [255, 255, 255] });
  }
  for (const fp of fps) { const q = at(centre(fp)); text(q[0], q[1], fp.name, solid(fp) ? INK : [150, 150, 150], { s: solid(fp) ? 2 : 1, back: solid(fp) ? [255, 255, 255] : null }); }
  const w = wallsOf(plan);
  text(W / 2, PAD / 2, w.top, GREY); text(W / 2, H - PAD / 2, w.bottom, GREY); text(PAD / 2, H / 2, w.left, GREY, { up: true }); text(W - PAD / 2, H / 2, w.right, GREY, { up: true });
  for (const o of people) {
    if (!o.floor) continue;
    const q = at(o.floor), col = o.me ? [214, 40, 40] : [230, 140, 20];
    if (o.facing) line(q, [q[0] + o.facing[0] * 30, q[1] + o.facing[1] * 30], col, 3);
    disc(Math.round(q[0]), Math.round(q[1]), 9, col);
    text(q[0], q[1] - 20, o.label || (o.me ? 'participant' : 'person'), col, { back: [255, 255, 255] });
  }
  return PNG.sync.write(png, { colorType: 2 });
}

// ---- memory: when the furniture was last checked, what moved, and undo ----
const TRAIL_MS = 2500, HOLD_MS = 30 * 60000, LOG_MAX = 200;
class World {
  // room: { config, moveFootprint(name, delta, by) }
  constructor({ file, room }) {
    this.file = file; this.room = room; this.trails = new Map(); this.holds = new Map();
    this.mem = { confirmed: {}, log: [], lastCheckAt: 0 };
    try { Object.assign(this.mem, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  }
  save() { clearTimeout(this.saving); this.saving = setTimeout(() => { try { fs.writeFileSync(this.file, JSON.stringify(this.mem)); } catch {} }, 500); this.saving.unref?.(); }
  // Called about once a second with the people being tracked: keeps a short trail for "which way are they walking".
  observe(tracks, now = Date.now()) {
    for (const t of tracks) {
      if (!t.visible || !t.floor || t.confidence === 'unsure') { this.trails.delete(t.id); continue; }
      this.trails.set(t.id, [...(this.trails.get(t.id) || []), { at: now, p: t.floor }].filter((s) => now - s.at <= TRAIL_MS));
    }
    for (const id of this.trails.keys()) if (!tracks.some((t) => t.id === id)) this.trails.delete(id);
  }
  facing(track, camera) { return facingOf(track, camera, this.trails.get(track?.id)); }
  // A place named without counting the object itself ("beside the Work bench", not "at the Small stool").
  spot(name, p) { const plan = this.room.config.floorPlan; return areaFor({ ...plan, footprints: (plan.footprints || []).filter((f) => f.name !== name) }, p); }
  confirmed(name, now = Date.now()) { this.mem.confirmed[name] = now; this.save(); }
  moved({ name, from, to, delta, by = 'desk', now = Date.now() }) {
    const entry = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: now, name, delta, by, distanceM: Math.round(Math.hypot(...delta) * 10) / 10, from: from ? this.spot(name, from) : null, to: this.spot(name, to) };
    this.mem.log = [...this.mem.log, entry].slice(-LOG_MAX); this.mem.confirmed[name] = now; this.save();
    return entry;
  }
  // Put a moved piece back, and stop the camera moving it again for a while (the desk has overruled it).
  undo(id, now = Date.now()) {
    const e = this.mem.log.find((x) => x.id === id); if (!e || e.undone) throw Error('That change can no longer be undone.');
    if (!this.room.moveFootprint(e.name, e.delta.map((v) => -v), 'undo')) throw Error(`${e.name} is no longer on the plan.`);
    e.undone = now; this.holds.set(e.name, now + HOLD_MS); this.save();
    return e;
  }
  held(name, now = Date.now()) { return (this.holds.get(name) || 0) > now; }
  checked(now = Date.now()) { this.mem.lastCheckAt = now; this.save(); }
  changes(now = Date.now(), within = 30 * 60000) { return this.mem.log.filter((e) => !e.undone && now - e.at <= within); }
  // For Mother: how fresh the furniture positions are, and what has moved lately.
  note(now = Date.now()) {
    const ago = (t) => { const s = Math.round((now - t) / 1000); return s < 90 ? 'just now' : `${Math.round(s / 60)} min ago`; };
    const moved = this.changes(now).slice(-4).map((e) => `${e.name} moved ${e.from ? `from ${e.from} ` : ''}to ${e.to} (${ago(e.at)})`);
    const fresh = this.mem.lastCheckAt && now - this.mem.lastCheckAt < 6 * 3600000 ? `The camera last checked the furniture ${ago(this.mem.lastCheckAt)}.` : 'The furniture has not been checked by the camera lately: positions are from the plan, and something may have moved.';
    return ` ROOM NOW: ${fresh}${moved.length ? ' Moved recently: ' + moved.join('; ') + '.' : ''}`;
  }
  view(now = Date.now()) { return { lastCheckAt: this.mem.lastCheckAt, changes: this.mem.log.slice(-8).reverse().map((e) => ({ ...e, held: this.held(e.name, now) })) }; }
}
module.exports = { World, briefing, relative, facingOf, mapPng, towards, placeOf, polyDist };
