// Camera lending: several agents (one per participant) share the cameras that can turn.
//
// Some cameras stay fixed and wide, so every agent always sees the whole room. The movable ones are lent out, one
// agent at a time, for a short spell: the camera turns to keep that participant's face in the middle of its picture
// (recognising which face is theirs from a close-up), sweeps slowly when it has lost them, and goes back to its own
// home position when the loan ends.
//
// Fairness: an agent that has lost its participant comes before one that only wants a closer look; then whoever has
// waited longest; nobody keeps a camera longer than LEASE_MS, and has to wait REST_MS before borrowing again. The desk
// always wins: a camera that is being turned or followed from the desk is never lent, and a loan ends if the desk
// takes it.
//
// h: { views (CameraViews), cameras, faces(camId, embed) -> [{ box, w, h, size, feat }], log, changed }
const LEASE_MS = 25000, REST_MS = 8000, STEP_MS = 1200, MATCH = 0.36;
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

class CameraLending {
  constructor(h, { movable = [] } = {}) {
    this.h = h; this.movable = movable; this.loans = new Map(); this.wants = new Map(); this.rested = new Map(); this.homes = new Map();
    this.timer = setInterval(() => this.tick().catch((e) => this.h.log('camera_loan_error', { message: e.message })), STEP_MS);
    this.timer.unref?.();
  }
  setMovable(ids) { this.movable = ids; for (const id of [...this.loans.keys()]) if (!ids.includes(id)) this.release(id, 'no longer movable'); this.h.changed(); }

  // An agent asks for a camera. reason: 'lost' (can't see them at all) or 'close' (wants a closer look). ref: their face vector.
  want(phone, reason = 'lost', ref = null) {
    const held = [...this.loans.values()].find((l) => l.phone === phone);
    if (held) { if (ref) held.ref = ref; return held.cam; }
    const w = this.wants.get(phone);
    this.wants.set(phone, { reason: w?.reason === 'lost' ? 'lost' : reason, ref: ref || w?.ref || null, since: w?.since || Date.now(), at: Date.now() });
    return null;
  }
  holding(phone) { return [...this.loans.values()].find((l) => l.phone === phone)?.cam || null; }
  free(camId) {
    const v = this.h.views, st = v.st(camId);
    return this.movable.includes(camId) && !this.loans.has(camId) && !st.busy && !(v.follow?.on && v.follow.cameraId === camId) && !v.surveys?.get(camId)?.running && st.available !== false;
  }

  async tick(now = Date.now()) {
    for (const [p, w] of this.wants) if (now - w.at > 15000) this.wants.delete(p);   // nobody asked again: forget it
    // hand out free cameras
    const queue = [...this.wants.entries()].filter(([p]) => now >= (this.rested.get(p) || 0))
      .sort(([, a], [, b]) => (a.reason === 'lost' ? 0 : 1) - (b.reason === 'lost' ? 0 : 1) || a.since - b.since);
    for (const [phone, w] of queue) {
      const cam = this.movable.find((id) => this.free(id)); if (!cam) break;
      this.wants.delete(phone);
      await this.lend(cam, phone, w);
    }
    // follow, and end loans
    for (const [cam, l] of [...this.loans]) {
      const st = this.h.views.st(cam);
      if (st.busy && st.busy !== 'lent') { this.release(cam, 'the desk took the camera', false); continue; }
      if (now > l.until) { this.release(cam, 'time up'); continue; }
      await this.follow(cam, l, now);
    }
  }

  async lend(cam, phone, w) {
    // remember where this camera belongs, so it can go back there afterwards
    if (!this.homes.has(cam)) {
      try { const ctl = this.h.views.ctl(cam); this.homes.set(cam, await ctl.savePreset(`Mother home ${cam}`)); } catch (e) { this.h.log('camera_loan_error', { cam, message: 'could not save its home position: ' + e.message }); }
    }
    this.loans.set(cam, { cam, phone, reason: w.reason, ref: w.ref, since: Date.now(), until: Date.now() + LEASE_MS, seenAt: 0, sweep: 0 });
    this.h.log('camera_lent', { cam, phone, reason: w.reason });
    this.h.changed();
  }

  async release(cam, why, goHome = true) {
    const l = this.loans.get(cam); if (!l) return;
    this.loans.delete(cam); this.rested.set(l.phone, Date.now() + REST_MS);
    this.h.log('camera_returned', { cam, phone: l.phone, why, secs: Math.round((Date.now() - l.since) / 1000) });
    if (goHome) this.goHome(cam);
    this.h.changed();
  }
  // Back to where it belongs. A following turn may still be finishing ("busy"): wait and try again, for up to 20 s.
  async goHome(cam) {
    const home = this.homes.get(cam); if (!home) return;
    for (let i = 0; i < 40; i++) {
      if (this.loans.has(cam)) return;   // lent again meanwhile
      try { await this.h.views.exclusive(cam, 'lent', () => this.h.views.ctl(cam).goto(home, this.h.views.nap)); this.h.log('camera_home', { cam }); return; }
      catch (e) { if (!/busy/i.test(e.message)) { this.h.log('camera_loan_error', { cam, message: 'could not go home: ' + e.message }); console.error(`  ${cam}: could not go home: ${e.message}`); return; } }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.error(`  ${cam}: still busy after 20 s, did not go home`);
  }

  // Keep their face in the middle of this camera's picture; sweep slowly if it isn't there.
  async follow(cam, l, now) {
    const faces = await this.h.faces(cam, !!l.ref);
    if (this.loans.get(cam) !== l) return;   // the loan ended while we were looking
    let target = null;
    if (l.ref) { let best = MATCH; for (const f of faces) if (f.feat) { const s = cos(f.feat, l.ref); if (s > best) { best = s; target = f; } } }
    else target = faces[0] || null;   // nobody to compare with yet: the clearest face
    let dx = 0, dy = 0;
    if (target) {
      l.seenAt = now; l.sweep = 0;
      const [x, y, w, h] = target.box, ox = (x + w / 2) / target.w - 0.5, oy = (y + h / 2) / target.h - 0.42;
      if (Math.abs(ox) > 0.08) dx = Math.max(-0.12, Math.min(0.12, ox * 0.35));
      if (Math.abs(oy) > 0.12) dy = Math.max(-0.08, Math.min(0.08, -oy * 0.3));
    } else if (now - l.seenAt > 3000) {
      // lost: look left and right in widening steps
      const pattern = [0.08, 0.08, -0.24, -0.08, 0.32, 0.08, -0.4];
      dx = pattern[l.sweep % pattern.length]; l.sweep++;
    }
    if (!dx && !dy) return;
    try { await this.h.views.exclusive(cam, 'lent', () => this.h.views.ctl(cam).nudge(dx, dy, this.h.views.nap)); }
    catch (e) { this.h.log('camera_loan_error', { cam, message: e.message }); }
  }

  status() {
    const name = (id) => this.h.cameras.find((c) => c.id === id)?.name || id;
    return { movable: this.movable.map(name), loans: [...this.loans.values()].map((l) => ({ camera: name(l.cam), phone: l.phone, reason: l.reason, secs: Math.round((Date.now() - l.since) / 1000), sees: Date.now() - l.seenAt < 3000 })),
      waiting: [...this.wants.entries()].map(([phone, w]) => ({ phone, reason: w.reason })) };
  }
}

module.exports = { CameraLending };
