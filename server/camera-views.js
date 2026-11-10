// Camera positions for a pan/tilt camera. Each position is a preset on the camera, a reference picture,
// and its own floor calibration. Moving to a position: turn (always arriving from the same side, see
// ptz.js), grab a fresh picture, measure how far it is from the reference picture and correct the
// calibration by that much. While the camera turns nobody is placed.
//
// Follow: when the person being followed leaves the picture, turn to the position that covers where
// they were heading (from their last floor position and speed), or failing that, the next position
// on the side they left by.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Ptz } = require('./ptz');
const { pickFocus } = require('./public/follow-core');

const LOST_MS = 1200, RECENT_MS = 6000, COOLDOWN_MS = 5000, EDGE = 0.05, MAX_SHIFT = 0.06, AHEAD_S = 1.0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'view';

function inv3(M) { const [a, b, c, d, e, f, g, h, i] = M, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C; return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det); }
function project(H, [x, y]) { const w = H[6] * x + H[7] * y + H[8]; if (!(w > 1e-9)) return null; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; }
// Can this calibration see a floor point (somewhere sensible in the picture)?
function sees(H, pt) { const q = H && project(inv3(H), pt); return q && q[0] > 0.05 && q[0] < 0.95 && q[1] > 0.05 && q[1] < 1.02 ? q : null; }

// Which position to turn to, or null. last: the followed person when last seen {box, floor, vel}.
// views: [{id, pos:[pan,tilt], calibration:{H}}]; current: {id, pos, H}.
function chooseView({ views, current, last, plan }) {
  if (!last) return null;
  const b = last.box, edge = b ? (b.x < EDGE ? 'left' : b.x + b.w > 1 - EDGE ? 'right' : null) : null;
  let ahead = null;
  if (last.floor) {
    const v = last.vel || [0, 0], clamp = (p, m) => Math.max(0, Math.min(m, p));
    ahead = [last.floor[0] + v[0] * AHEAD_S, last.floor[1] + v[1] * AHEAD_S];
    if (plan) ahead = [clamp(ahead[0], plan.widthM), clamp(ahead[1], plan.depthM)];
  }
  // Still inside this picture and not at its edge: probably hidden behind something, so stay.
  if (!edge && (!ahead || (current?.H && sees(current.H, ahead)))) return null;
  const others = views.filter((v) => v.id !== current?.id);
  if (ahead) {
    const fits = others.map((v) => ({ v, q: v.calibration?.H && sees(v.calibration.H, ahead) })).filter((x) => x.q)
      .sort((a, b) => Math.hypot(a.q[0] - 0.5, a.q[1] - 0.6) - Math.hypot(b.q[0] - 0.5, b.q[1] - 0.6));
    if (fits.length) return fits[0].v.id;
  }
  // No calibrated position covers it: turn towards the side they left by. +pan turns the camera right.
  if (edge && current?.pos) {
    const dir = edge === 'right' ? 1 : -1;
    const side = others.filter((v) => v.pos && (v.pos[0] - current.pos[0]) * dir > 0.02).sort((a, b) => Math.abs(a.pos[0] - current.pos[0]) - Math.abs(b.pos[0] - current.pos[0]));
    if (side.length) return side[0].id;
  }
  return null;
}

class CameraViews {
  constructor({ root, cameras, room, identity, log = () => {}, PtzImpl = Ptz, grab = null, register = null, nap = sleep }) {
    Object.assign(this, { root, cameras, room, identity, log, PtzImpl, nap });
    this.dir = path.join(root, '.camera-views');
    this.py = path.join(root, '.faces-venv', 'bin', 'python');
    this.grab = grab || ((cam, since) => this.grabFull(cam, since));
    this.register = register || ((ref, cur) => this.registerPictures(ref, cur));
    this.ptz = new Map(); this.state = new Map(); this.turned = new Set();   // cameras Mother has moved since starting
    this.surveys = new Map();
    this.follow = { on: false, wanted: 'auto', cameraId: '' }; this.last = null; this.lostHandled = false;
    for (const cam of this.cameras) if (this.controllable(cam)) this.probe(cam.id);
  }
  controllable(cam) { return !!cam && /^rtsp:\/\/[^/]*@/.test(cam.main || ''); }
  cam(id) { const c = this.cameras.find((x) => x.id === id); if (!c) throw Error('Choose a camera.'); return c; }
  ctl(id) {
    const cam = this.cam(id); if (!this.controllable(cam)) throw Error('This camera cannot turn.');
    if (!this.ptz.has(id)) this.ptz.set(id, new this.PtzImpl(cam.main));
    return this.ptz.get(id);
  }
  st(id) { if (!this.state.has(id)) this.state.set(id, { available: null, busy: '', error: '', pos: null, lastMove: null }); return this.state.get(id); }
  views(id) { return this.room.config.cameraViews?.[id] || []; }
  moving(id) { return !!this.st(id).busy; }
  async probe(id) {
    const s = this.st(id);
    try { s.pos = await this.ctl(id).position(); s.available = !!s.pos; s.error = s.pos ? '' : 'The camera does not report a position.'; }
    catch (e) { s.available = false; s.error = e.message; }
    this.room.notify?.();
  }
  status(id) {
    const s = this.st(id), a = this.room.activeView?.()[id] || null;
    return { cameraId: id, sweep: { ...this.survey(id), views: this.sweepViews(id).length }, available: s.available, busy: s.busy, settledAt: s.settledAt || 0, error: s.error, pos: s.pos, lastMove: s.lastMove, active: a,
      follow: this.follow.cameraId === id ? { on: this.follow.on, wanted: this.follow.wanted } : { on: false, wanted: 'auto' },
      views: this.views(id).map((v) => ({ id: v.id, name: v.name, calibrated: !!v.calibration, pos: v.pos || null })) };
  }
  statusAll() { return Object.fromEntries(this.cameras.filter((c) => this.controllable(c)).map((c) => [c.id, this.status(c.id)])); }

  // Run one camera move at a time; the picture is not trusted for positions until it is done.
  async exclusive(id, label, fn) {
    const s = this.st(id); if (s.busy || (this.surveys.get(id)?.running && label!=='sweep')) throw Error('The camera is busy.');
    s.busy = label; s.error = ''; const untouched = !this.turned.has(id); this.turned.add(id); this.room.setMoving(id, true);
    try { return await fn(untouched); }
    catch (e) { s.error = e.message; throw e; }
    finally {
      s.settledAt = Date.now();
      this.onSettled?.(id, label, s.settledAt);
      s.busy = '';
      if (this.room.active?.[id]?.moving) this.room.setMoving(id, false);
      this.room.notify?.();
    }
  }
  async nudge(id, dx, dy) {
    if (![dx, dy].every(Number.isFinite) || Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) throw Error('Choose a small turn.');
    return this.exclusive(id, 'aiming', async () => {
      this.st(id).pos = await this.ctl(id).nudge(dx, dy, this.nap);
      if (this.follow.on && this.follow.cameraId === id) this.setFollow(id, { on: false });
      this.room.setActive(id, null);   // aimed by hand: no calibrated position until one is saved or chosen
    });
  }
  async save(id, name) {
    name = String(name || '').trim().slice(0, 40); if (!name) throw Error('Name this position.');
    if (this.views(id).length >= 8) throw Error('Keep to eight positions per camera.');
    return this.exclusive(id, 'saving', async (untouched) => {
      const ptz = this.ctl(id), token = await ptz.savePreset('mother_' + slug(name)), pos = await ptz.position();
      const vid = 'v' + require('crypto').randomUUID().slice(0, 8), ref = await this.saveRef(id, vid, 0);
      // The camera has not been turned by Mother since its calibration was made: keep that calibration.
      const keep = untouched && this.room.config.calibrations?.[id] && !this.room.config.calibrations[id].needsReview;
      const view = { id: vid, name, token, pos, ref, calibration: keep ? { ...this.room.config.calibrations[id] } : null, createdAt: new Date().toISOString() };
      this.room.saveViews(id, [...this.views(id), view]);
      this.room.setActive(id, vid, { correction: { ok: true, fresh: true } });
      this.st(id).pos = pos; this.log(`camera position saved: ${name}`);
      return view;
    });
  }
  async remove(id, vid) {
    if(this.surveys.get(id)?.running)throw Error('Wait for the room sweep to finish.');
    const v = this.views(id).find((x) => x.id === vid); if (!v) throw Error('That position was already removed.');
    try { await this.ctl(id).removePreset(v.token); } catch {}
    try { fs.unlinkSync(path.join(this.dir, v.ref)); } catch {}
    this.room.saveViews(id, this.views(id).filter((x) => x.id !== vid));
    if (this.room.active?.[id]?.viewId === vid) this.room.setActive(id, null);
  }
  async goto(id, vid, reason = 'desk') {
    const v = this.views(id).find((x) => x.id === vid); if (!v) throw Error('That position was removed.');
    return this.exclusive(id, reason==='sweep'?'sweep':'turning', () => this.aim(id, v, reason));
  }
  async aim(id, v, reason) {
    const vid = v.id;
    this.st(id).pos = await this.ctl(id).goto(v.token, this.nap);
    const done = Date.now();
    let G = null, correction = { ok: false, bad: !!v.calibration, error: 'no reference picture' };
    if (v.ref && fs.existsSync(path.join(this.dir, v.ref))) {
      const cur = path.join(this.dir, `${id}-now.jpg`);
      fs.mkdirSync(this.dir, { recursive: true });
      const compare = async since => {
        const frame = await this.grab(this.cam(id), since);
        fs.writeFileSync(cur, frame);
        return this.register(path.join(this.dir, v.ref), cur);
      };
      let r = await compare(done + 600);
      // A frame can still be in the stream buffer while the camera settles.
      if (!r.ok || Math.hypot(...r.shift) > MAX_SHIFT) r = await compare(Date.now() + 1200);
      if (r.ok && Math.hypot(...r.shift) <= MAX_SHIFT) { G = r.G; correction = { ok: true, shift: r.shift, inliers: r.inliers }; }
      else if (r.ok) correction = { ok: false, bad: true, shift: r.shift, error: 'The camera stopped somewhere else. Go to the position again or recalibrate it.' };
      else correction = { ok: false, bad:true, error: r.error || 'Could not compare with the reference picture.' };
    }
    this.room.setActive(id, vid, { G, correction });
    this.st(id).lastMove = { at: Date.now(), to: v.name, reason };
    this.log(`camera turned to ${v.name} (${reason})${correction.ok ? `, corrected ${Math.round(Math.hypot(...correction.shift) * 3840)} px` : ': ' + correction.error}`);
    return correction;
  }
  // Hold the camera across the whole look so a second turn cannot capture the wrong view.
  async look(id, { viewId, direction }) {
    const views = this.views(id);
    const v = views.find(view => view.id === viewId);
    const active = this.room.active?.[id];
    const home = views.find(view => view.id === active?.viewId) ||
      (!active && !this.turned.has(id) && views.find(view => view.name.toLowerCase() === 'home'));
    const offsets = new Map([
      ['left', [-.4, 0]], ['right', [.4, 0]], ['up', [0, -.35]], ['down', [0, .35]],
      ['left_down', [-.4, .35]], ['right_down', [.4, .35]],
    ]);
    const offset = offsets.get(direction);
    if ((!v && !offset) || !home) throw Error('The desk must select a saved camera view before Mother can look around.');
    return this.exclusive(id, 'looking for Mother', async () => {
      try {
        const ptz = this.ctl(id);
        if (v) await ptz.goto(v.token, this.nap);
        else await ptz.nudge(offset[0], offset[1], this.nap);
        return await this.grab(this.cam(id), Date.now() + 600);
      } finally {
        try {
          await this.aim(id, home, 'return after look');
        } catch (error) {
          this.room.setActive(id, null);
          throw error;
        }
      }
    });
  }
  // After a position is recalibrated, its reference picture is the picture it was calibrated on.
  async refreshRef(id, vid) {
    try { const ref = await this.saveRef(id, vid, 0); this.room.saveViews(id, this.views(id).map((v) => (v.id === vid ? { ...v, ref } : v))); }
    catch (e) { this.st(id).error = 'Could not save the reference picture: ' + e.message; }
  }
  async saveRef(id, vid, since) {
    const frame = await this.grab(this.cam(id), since); fs.mkdirSync(this.dir, { recursive: true });
    const name = `${id}-${vid}.jpg`; fs.writeFileSync(path.join(this.dir, name), frame); return name;
  }

  // A 4K frame newer than `since`: from the tracker's stream when it is running, else one straight from the camera.
  async grabFull(cam, since = 0) {
    for (let i = 0; i < 25; i++) {
      const f = this.identity?.full;
      if (f?.camId === cam.id && f.frame && f.at > since) return Buffer.from(f.frame);
      if (!f || f.camId !== cam.id) break;
      await this.nap(120);
    }
    if (since > Date.now()) await this.nap(since - Date.now());
    return new Promise((res, rej) => {
      const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', cam.main, '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const out = []; const t = setTimeout(() => p.kill(), 10000);
      p.stdout.on('data', (d) => out.push(d));
      p.on('exit', () => { clearTimeout(t); const b = Buffer.concat(out); b.length ? res(b) : rej(Error('no picture from the camera')); });
    });
  }
  registerPictures(ref, cur) {
    return new Promise((res) => {
      const p = spawn(this.py, ['-I', path.join(this.root, 'register_view.py'), ref, cur]); let out = '';
      p.stdout.on('data', (d) => (out += d)); const t = setTimeout(() => p.kill(), 20000);
      p.on('exit', () => { clearTimeout(t); try { res(JSON.parse(out)); } catch { res({ ok: false, error: 'picture comparison failed' }); } });
      p.on('error', () => res({ ok: false, error: 'picture comparison is not set up' }));
    });
  }

  sweepViews(id) {
    return this.views(id).filter(view=>view.calibration && !view.calibration.needsReview && view.ref);
  }
  survey(id) {
    if (!this.surveys.has(id)) this.surveys.set(id, { enabled: false, nextAt: Date.now() + 300000 });
    return this.surveys.get(id);
  }
  setAutoSweep(id, enabled) {
    if (!this.controllable(this.cam(id))) throw Error('This camera cannot turn.');
    Object.assign(this.survey(id), { enabled: !!enabled, nextAt: Date.now() + 300000 });
  }
  async sweep(id, inspect) {
    const views=this.sweepViews(id), active=this.room.active?.[id];
    const home=views.find(v=>v.id===active?.viewId) || (!active && views.find(v=>v.name.toLowerCase()==='home'));
    const state = this.survey(id);
    if (views.length<2 || !home) throw Error('Select a calibrated saved position and add a second calibrated view to sweep.');
    if(state.running || this.moving(id))throw Error('The camera is busy.');
    if(this.follow.on && this.follow.cameraId===id)throw Error('Pause physical follow to run a room sweep.');
    Object.assign(state,{running:true,view:'',error:'',nextAt:Date.now()+300000});
    try {
      for(const view of views){
        state.view=view.name;
        const correction=await this.goto(id,view.id,'sweep');
        if (correction.ok) await inspect(view);
        else state.error = `Could not match ${view.name}: ${correction.error}`;
      }
    } catch(error){state.error=error.message;}
    finally {
      try { if (this.room.active?.[id]?.viewId !== home.id || this.room.active[id].correction?.ok === false) await this.goto(id, home.id, 'sweep'); }
      catch(error){state.error=error.message;}
      state.running=false;state.view='';state.nextAt=Date.now()+300000;
    }
  }

  // ---- follow ----
  setFollow(id, { on, wanted }) {
    if (on && this.surveys.get(id)?.running) throw Error('Wait for the room sweep to finish.');
    if (on && this.st(id).available === false) throw Error('This camera cannot turn.');
    if (on && this.views(id).length < 2) throw Error('Save at least two camera positions first.');
    this.follow = { on: !!on, wanted: String(wanted || 'auto').slice(0, 40), cameraId: id }; this.last = null; this.lostHandled = false;
    this.room.notify?.();
  }
  tick(now = Date.now()) {
    const f = this.follow; if (!f.on) return null;
    const id = f.cameraId, t = this.room.tracking, s = this.st(id);
    if (s.busy || this.surveys.get(id)?.running || t.cameraId !== id || !t.view(now).running) return null;
    const focus = pickFocus(t.view(now).tracks, f.wanted);
    if (focus) {
      const prev = this.last, floor = focus.floor || null;
      let vel = prev?.vel || [0, 0];
      if (floor && prev?.floor && now > prev.at) { const dt = (now - prev.at) / 1000; if (dt < 1.5) vel = [0, 1].map((k) => 0.6 * vel[k] + 0.4 * (floor[k] - prev.floor[k]) / dt); }
      this.last = { box: focus.box, floor: floor || prev?.floor || null, vel, at: now, key: focus.binding?.person?.pid || focus.id };
      this.lostHandled = false; return null;
    }
    const last = this.last;
    if (!last || this.lostHandled || now - last.at < LOST_MS || now - last.at > RECENT_MS) return null;
    if (s.lastMove && now - s.lastMove.at < COOLDOWN_MS) return null;
    const a = this.room.active?.[id], cur = a?.viewId ? this.views(id).find((v) => v.id === a.viewId) : null;
    const current = { id: cur?.id || null, pos: s.pos || cur?.pos || null, H: this.room.cals()[id]?.H || null };
    const target = chooseView({ views: this.views(id), current, last, plan: this.room.config.floorPlan });
    this.lostHandled = true;
    if (!target) return null;
    this.goto(id, target, 'following').catch((e) => this.log('camera follow: ' + e.message));
    return target;
  }
}
module.exports = { CameraViews, chooseView, sees };
