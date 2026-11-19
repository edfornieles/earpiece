// Digital follow view: a virtual camera that crops the fixed 4K picture around one person.
// The real camera never moves, so floor positions stay calibrated; only the crop pans and zooms.
// All values are in picture units (0..1). The crop has the same shape as the picture (16:9), so
// its width and height are equal in these units.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FollowCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_H = 0.3, ZOOM = 1.45, HEADROOM = 0.1, LOST_MS = 2000, OMEGA = 3.2, DEAD = 0.05;
  const WIDE = { cx: 0.5, cy: 0.5, h: 1 };

  // Who to follow: the person the desk chose (by person id or track id), else a recognised person,
  // else the biggest body in the picture (usually the nearest).
  function pickFocus(tracks, wanted) {
    const seen = (tracks || []).filter((t) => t.visible && t.box);
    if (wanted && wanted !== 'auto') {
      const w = seen.find((t) => t.binding?.person?.pid === wanted || t.id === wanted);
      return w || null;
    }
    const named = seen.filter((t) => t.binding?.person);
    const pool = named.length ? named : seen;
    return pool.reduce((best, t) => (!best || t.box.h > best.box.h ? t : best), null);
  }

  // The crop that frames a body: a little wider than the body, with headroom above.
  function frameFor(box) {
    const h = Math.min(1, Math.max(MIN_H, box.h * ZOOM));
    const top = box.y - HEADROOM * h;
    return clamp({ cx: box.x + box.w / 2, cy: top + h / 2, h });
  }
  function clamp(f) {
    const h = Math.min(1, Math.max(0.05, f.h)), half = h / 2;
    return { cx: Math.min(1 - half, Math.max(half, f.cx)), cy: Math.min(1 - half, Math.max(half, f.cy)), h };
  }
  const rect = (f) => ({ x: f.cx - f.h / 2, y: f.cy - f.h / 2, w: f.h, h: f.h });

  // Critically damped spring: eases to the target without overshoot.
  function spring(x, v, target, dt) {
    const f = 1 + 2 * dt * OMEGA, oo = OMEGA * OMEGA, hoo = dt * oo, hhoo = dt * hoo, det = 1 / (f + hhoo);
    return [(f * x + dt * v + hhoo * target) * det, (v + hoo * (target - x)) * det];
  }

  class Follow {
    constructor() { this.f = { ...WIDE }; this.v = { cx: 0, cy: 0, h: 0 }; this.goal = { ...WIDE }; this.seenAt = 0; }
    // box: the followed person's box, or null when nobody is visible. Returns the crop rect.
    step(box, now, dt) {
      if (box) {
        this.seenAt = now;
        const want = frameFor(box), g = this.goal;
        // Small shifts are ignored, so the frame holds still while someone shifts their weight.
        const moved = Math.abs(want.cx - g.cx) > DEAD * g.h || Math.abs(want.cy - g.cy) > DEAD * g.h || Math.abs(want.h - g.h) > 2 * DEAD * g.h;
        if (moved) this.goal = want;
      } else if (now - this.seenAt > LOST_MS) this.goal = { ...WIDE };
      dt = Math.min(0.1, Math.max(0, dt));
      for (const k of ['cx', 'cy', 'h']) [this.f[k], this.v[k]] = spring(this.f[k], this.v[k], this.goal[k], dt);
      this.f = clamp(this.f);
      return rect(this.f);
    }
  }
  return { pickFocus, frameFor, Follow, rect, LOST_MS };
});
