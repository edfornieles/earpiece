// Where a person stands, how sure we are, and where the camera can be trusted.
//
// A calibrated camera turns a point in the picture into a point on the floor only for things ON the
// floor (z = 0). For a body point at a known height h (hips ≈ 0.93 m standing), the camera position
// lets us follow the line from the camera through that point down to the floor and stop at height h:
//   standing point = camera + (floor hit − camera) · (z_cam − h) / z_cam.
// Every estimate carries an error radius worked out from what is uncertain about it: a few pixels for
// a visible ankle; a few pixels plus the spread of body heights for hips or head. Ankles beat hips
// beat head; the smallest honest radius wins.
const { apply, invert } = require('./tracking');

const KP = { nose: 0, leye: 1, reye: 2, lsho: 5, rsho: 6, lhip: 11, rhip: 12, lknee: 13, rknee: 14, lank: 15, rank: 16 };
const MIN_CONF = 0.45, PIXEL = 0.004;   // keypoint confidence; ~4 px at 1000 px of picture
const BODY = { hips: { h: 0.93, spread: 0.08 }, head: { h: 1.62, spread: 0.12 }, seatedHips: { h: 0.62, spread: 0.12 } };

function atHeight(H, cam, pt, h) {
  const p = apply(H, pt); if (!p || !cam || !(cam.z > h)) return null;
  const k = (cam.z - h) / cam.z; return [cam.x + (p[0] - cam.x) * k, cam.y + (p[1] - cam.y) * k];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function mean(points) { return points.length ? [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length] : null; }
function visible(kp, ids) { return ids.map((i) => kp[i]).filter((p) => p && p[2] >= MIN_CONF && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 0.985); }
// Worst-case floor shift for a small pixel error at a picture point (at height h).
function pixelRadius(H, cam, pt, h) {
  const at = (q) => (h ? atHeight(H, cam, q, h) : apply(H, q));
  const c = at(pt); if (!c) return Infinity;
  return Math.max(...[[PIXEL, 0], [-PIXEL, 0], [0, PIXEL], [0, -PIXEL]].map(([du, dv]) => { const q = at([pt[0] + du, pt[1] + dv]); return q ? dist(q, c) : Infinity; }));
}
function insidePoly([x, y], pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
const tallFurniture = (plan) => (plan?.footprints || []).filter((f) => f.heightM != null && f.heightM >= 0.4);

// Candidate positions for one person, best first. kp: 17 × [u, v, conf] in 0..1 picture units.
function candidates({ H, cam, plan, kp, seated = false }) {
  const out = [], inRoom = (p) => p && (!plan || (p[0] >= -0.1 && p[1] >= -0.1 && p[0] <= plan.widthM + 0.1 && p[1] <= plan.depthM + 0.1));
  const ankles = visible(kp, [KP.lank, KP.rank]);
  if (ankles.length) {
    const pt = mean(ankles), p = apply(H, pt);
    // "Feet" inside a table or bench are not feet: the legs are hidden behind it.
    if (inRoom(p) && !tallFurniture(plan).some((f) => insidePoly(p, f.points)))
      out.push({ how: 'feet', floor: p, radius: 0.08 + pixelRadius(H, cam, pt, 0) + (ankles.length === 1 ? 0.05 : 0) });
  }
  if (cam) {
    const hips = visible(kp, [KP.lhip, KP.rhip]);
    if (hips.length) {
      const pt = mean(hips), body = seated ? BODY.seatedHips : BODY.hips, p = atHeight(H, cam, pt, body.h);
      const lo = atHeight(H, cam, pt, body.h - body.spread), hi = atHeight(H, cam, pt, body.h + body.spread);
      if (inRoom(p) && lo && hi) out.push({ how: seated ? 'hips (seated)' : 'hips', floor: p, radius: 0.08 + dist(lo, hi) / 2 + pixelRadius(H, cam, pt, body.h) });
    }
    const head = visible(kp, [KP.nose, KP.leye, KP.reye]);
    if (head.length && !seated) {
      const pt = mean(head), p = atHeight(H, cam, pt, BODY.head.h);
      const lo = atHeight(H, cam, pt, BODY.head.h - BODY.head.spread), hi = atHeight(H, cam, pt, BODY.head.h + BODY.head.spread);
      if (inRoom(p) && lo && hi) out.push({ how: 'head', floor: p, radius: 0.1 + dist(lo, hi) / 2 + pixelRadius(H, cam, pt, BODY.head.h) });
    }
  }
  return out.sort((a, b) => a.radius - b.radius);
}
// Seated: knees roughly level with hips in the picture, relative to the torso's length.
function looksSeated(kp) {
  const [hips, knees, sh] = [visible(kp, [KP.lhip, KP.rhip]), visible(kp, [KP.lknee, KP.rknee]), visible(kp, [KP.lsho, KP.rsho])];
  if (!hips.length || !knees.length || !sh.length) return false;
  const torso = Math.abs(mean(hips)[1] - mean(sh)[1]); if (torso < 0.01) return false;
  return Math.abs(mean(knees)[1] - mean(hips)[1]) < 0.45 * torso;
}
function place(opts) {
  const seated = opts.seated ?? (opts.kp ? looksSeated(opts.kp) : false);
  const c = opts.kp ? candidates({ ...opts, seated }) : [];
  if (!c.length) return null;
  const best = c[0], clamp = (p) => opts.plan ? [Math.max(0, Math.min(opts.plan.widthM, p[0])), Math.max(0, Math.min(opts.plan.depthM, p[1]))] : p;
  return { floor: clamp(best.floor), radius: Math.min(3, best.radius), how: best.how, seated };
}

// Smoothing on the floor: a constant-velocity Kalman filter per axis. Measurements are weighted by
// their radius, so a sure "feet" reading pulls hard and a vague "head" reading pulls gently. Between
// readings the position is predicted and its radius grows; after HOLD_MS without a reading it is dropped.
const ACCEL = 1.5, HOLD_MS = 2500, MAX_SPEED = 2.5;
class Smoother {
  constructor() { this.s = null; }
  step(m, now) {
    if (!this.s) { if (!m) return null; this.s = { t: now, x: [m.floor[0], 0], y: [m.floor[1], 0], P: [[m.radius ** 2, 0], [0, 1]], Py: [[m.radius ** 2, 0], [0, 1]], last: now, how: m.how }; return this.out(now, m); }
    const dt = Math.max(0.001, (now - this.s.t) / 1000); this.s.t = now;
    for (const [a, P] of [['x', 'P'], ['y', 'Py']]) {   // predict
      const v = this.s[a], p = this.s[P], q = ACCEL ** 2;
      v[0] += v[1] * dt; v[1] = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v[1]));
      const p00 = p[0][0] + dt * (p[1][0] + p[0][1]) + dt * dt * p[1][1] + q * dt ** 4 / 4, p01 = p[0][1] + dt * p[1][1] + q * dt ** 3 / 2, p11 = p[1][1] + q * dt * dt;
      this.s[P] = [[p00, p01], [p01, p11]];
    }
    if (m) {
      // A reading far outside what is plausible (a mismatched detection) is ignored rather than followed.
      const pred = [this.s.x[0], this.s.y[0]], gate = 3 * Math.sqrt(this.s.P[0][0] + m.radius ** 2) + 0.5;
      if (dist(pred, m.floor) > gate && now - this.s.last < HOLD_MS) return this.out(now, null);
      for (const [a, P, z] of [['x', 'P', m.floor[0]], ['y', 'Py', m.floor[1]]]) {   // update
        const v = this.s[a], p = this.s[P], R = m.radius ** 2, S = p[0][0] + R, k0 = p[0][0] / S, k1 = p[1][0] / S, e = z - v[0];
        v[0] += k0 * e; v[1] += k1 * e;
        this.s[P] = [[(1 - k0) * p[0][0], (1 - k0) * p[0][1]], [p[1][0] - k1 * p[0][0], p[1][1] - k1 * p[0][1]]];
      }
      this.s.last = now; this.s.how = m.how;
    }
    return this.out(now, m);
  }
  out(now, m) {
    if (!this.s || now - this.s.last > HOLD_MS) return null;
    const r = Math.sqrt(Math.max(this.s.P[0][0], this.s.Py[0][0]));
    return { floor: [this.s.x[0], this.s.y[0]], radius: Math.min(3, r), how: m ? this.s.how : 'held', heldMs: m ? 0 : now - this.s.last };
  }
}
// How much an instruction may rely on a position.
function confidence(radius, how) {
  if (how === 'held') return radius <= 0.45 ? 'rough' : 'unsure';
  return radius <= 0.3 ? 'sure' : radius <= 0.6 ? 'rough' : 'unsure';
}

// Coverage: for each floor cell, does the camera see feet there, only the upper body, or nothing?
// Feet are hidden when the line from the camera to an ankle (10 cm up) passes through furniture
// lower than the line at that point; bodies when the same happens at hip height.
function coverage({ H, cam, plan, step = 0.25 }) {
  const Hi = invert(H), tall = tallFurniture(plan), cells = [];
  const blocked = (p, h) => {
    if (!cam) return false;
    for (let t = 0.04; t < 0.98; t += 0.04) {
      const q = [p[0] + (cam.x - p[0]) * t, p[1] + (cam.y - p[1]) * t], z = h + (cam.z - h) * t;
      if (tall.some((f) => f.heightM > z && insidePoly(q, f.points))) return true;
    }
    return false;
  };
  for (let y = step / 2; y < plan.depthM; y += step) for (let x = step / 2; x < plan.widthM; x += step) {
    const img = Hi && apply(Hi, [x, y]), seen = img && img[0] >= 0 && img[0] <= 1 && img[1] >= 0 && img[1] <= 1;
    const inside = tall.some((f) => insidePoly([x, y], f.points));
    const state = inside ? 'furniture' : !seen ? (cam && img && img[1] > 1 ? 'below picture' : 'not seen') : blocked([x, y], 0.1) ? (blocked([x, y], 0.93) ? 'hidden' : 'body only') : 'feet';
    cells.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, state });
  }
  const count = (s) => cells.filter((c) => c.state === s).length, floor = cells.filter((c) => c.state !== 'furniture').length || 1;
  return { step, cells, summary: { feet: Math.round(100 * count('feet') / floor), bodyOnly: Math.round(100 * count('body only') / floor), unseen: Math.round(100 * (count('not seen') + count('below picture') + count('hidden')) / floor) } };
}
module.exports = { KP, candidates, place, looksSeated, Smoother, confidence, coverage, atHeight };
