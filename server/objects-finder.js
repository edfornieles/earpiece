// Named studio objects, found by description in the tracking camera (object_finder.py, OWLv2, local).
// The descriptions come from room-objects/objects.json ("query" for each object; "followOnPlan" for
// objects whose feet the camera sees, so their floor position can be trusted).
//
// The finder runs as short "room checks" (when tracking starts, every few minutes, when someone leaves a
// piece of furniture, or from the desk): it loads the model, looks a few times, updates the plan and
// unloads again, so its ~7 GB of memory and its GPU time never sit next to the voice for long. A check
// waits while the standard voice is busy or the Mac is. OBJECT_FINDER=always keeps the old behaviour
// (loaded and looking the whole time tracking runs).
//
// On each look, each object found is placed on the floor through the camera's calibration. An object with a plan outline of the same name moves that outline once it has settled
// somewhere new; an object without one gets an estimated outline ("placed by the camera").
// A person standing in front of an object never moves it.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { apply, invert, areaFor } = require('./tracking');
const { polyDist } = require('./world');
const { atHeight } = require('./positioning');

// Furniture rarely moves, and a search costs ~20 s of GPU shared with live tracking: look every 15 s.
const EVERY_MS = 15000, SETTLE_MS = 12000, MIN_SAMPLES = 3, MOVE_M = 0.4, SPREAD_M = 0.3, MIN_SCORE = 0.22;
// A room check: looks back to back until each object has enough steady sightings, then unloads.
const CHECK_EVERY_MS = (Number(process.env.OBJECT_CHECK_MINUTES) || 5) * 60000, PASSES = 4, CHECK_MAX_MS = 240000, START_DELAY_MS = 15000, QUIET_MS = 15000, HELD_UNLOAD_MS = 20000, GIVE_UP_MS = 180000, RETRY_MS = 60000, LEFT_MS = 4000, LEFT_GAP_MS = 60000, NEAR_M = 0.6;
const overlap = (a, b) => { const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); return x * y / (a.w * a.h || 1); };

// Match the projected tabletop outline to a detected tabletop box. The search only
// translates the known footprint, and rejects views where its outline cannot fit.
function tabletopCentre(cal, fp, plan, box) {
  const cam = cal.camera, height = fp?.heightM;
  if (!cam || !height || cam.z <= height || !fp.points?.length ||
      box.x <= .01 || box.y <= .01 || box.x+box.w >= .99 || box.y+box.h >= .99) return null;
  const inverse = invert(cal.H), scale = (cam.z-height)/cam.z;
  if (!inverse) return null;
  const [minX,minY,maxX,maxY] = [Math.min,Math.min,Math.max,Math.max].map((fn,i)=>fn(...fp.points.map(p=>p[i%2])));
  const centre = [(minX+maxX)/2,(minY+maxY)/2];
  let best = null, score = 0;
  const search = (x0,x1,y0,y1,step) => {
    for(let dx=x0;dx<=x1;dx+=step)for(let dy=y0;dy<=y1;dy+=step){
      if(minX+dx<0 || minY+dy<0 || maxX+dx>plan.widthM || maxY+dy>plan.depthM) continue;
      const pixels = fp.points.map(([x,y])=>apply(inverse,[cam.x+(x+dx-cam.x)/scale,cam.y+(y+dy-cam.y)/scale]));
      if(pixels.some(p=>!p))continue;
      const xs=pixels.map(p=>p[0]),ys=pixels.map(p=>p[1]),x=Math.min(...xs),y=Math.min(...ys);
      const predicted={x,y,w:Math.max(...xs)-x,h:Math.max(...ys)-y};
      const fit=Math.min(overlap(box,predicted),overlap(predicted,box));
      if(fit>score){score=fit;best=[dx,dy];}
    }
  };
  search(-minX,plan.widthM-maxX,-minY,plan.depthM-maxY,.12);
  if(best)search(best[0]-.12,best[0]+.12,best[1]-.12,best[1]+.12,.025);
  return best && score>=.8 ? centre.map((v,i)=>v+best[i]) : null;
}

class ObjectFinder {
  // hooks: gate({force}) → null or {why, urgent} (hold the check: the voice or the Mac is busy), canAuto(name),
  //        confirmed(name, now) (seen where the plan has it), checked(now) (a check finished)
  constructor({ root, cameras, tracking, room, identity, log = () => {}, spawnImpl = spawn, hooks = {} }) {
    Object.assign(this, { root, cameras, tracking, room, identity, log, spawnImpl, h: hooks });
    this.autoMove = process.env.OBJECT_AUTO_MOVE === 'on';
    this.always = process.env.OBJECT_FINDER === 'always';
    this.enabled = this.always || process.env.OBJECT_FINDER !== 'off';   // room checks are on unless switched off
    this.check = null; this.wanted = null; this.lastCheckAt = 0; this.waiting = ''; this.near = new Map(); this.lastLeftAt = 0;
    this.py = path.join(root, '.faces-venv', 'bin', 'python');
    this.objects = new Map(); this.seq = 0; this.busy = false; this.error = ''; this.device = null; this.lastAt = 0;
    this.ready = fs.existsSync(this.py) && fs.existsSync(path.join(root, 'object_finder.py'));
    if (this.ready) this.timer = setInterval(() => this.tick(), 500);
  }
  catalogue() {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, 'room-objects', 'objects.json'), 'utf8')).objects.filter((o) => o.query); } catch { return []; }
  }
  start() {
    if (this.proc) return;
    const proc = this.proc = this.spawnImpl(this.py, [path.join(this.root, 'object_finder.py')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', VECLIB_MAXIMUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2' } });   // few threads: the workers share the Mac with live audio
    this.proc.stdin?.on?.('error', () => {});
    try { require('os').setPriority(this.proc.pid, 10); } catch {}   // vision runs below the voice and the audio loop   // the worker may exit first, e.g. while the server shuts down
    let buf = '';
    this.proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { if (this.proc===proc) this.onReply(JSON.parse(line)); } catch {} } });
    this.proc.stderr.on('data', () => {});
    proc.on('exit', () => { if (this.proc === proc) this.stop(); });
  }
  stop() {
    const proc = this.proc;
    this.proc = null;
    this.device = null;
    this.busy = false;
    this.pending = null;
    clearTimeout(this.timeout);
    if (proc) { try { proc.kill(); } catch {} }
  }
  calibration(cameraId) {
    const all = this.room.cals ? this.room.cals() : this.room.config.calibrations;
    const cal = all?.[cameraId];
    return cal?.needsReview ? null : cal;
  }
  tick(now = Date.now()) {
    const view = this.tracking.view(now);
    if (!view.running || !this.enabled) { this.check = null; this.since = 0; this.waiting = ''; this.stop(); return; }
    if (!this.since) { this.since = now; this.wanted = { at: now + START_DELAY_MS, reason: 'tracking started' }; }
    if (!this.always && !this.checking(view, now)) return;
    this.start();
    if (!this.device || this.busy || (this.always && now - this.lastAt < EVERY_MS)) return;
    const cam = this.cameras.find((c) => c.id === this.tracking.cameraId); if (!cam) return;
    const full = this.identity?.full?.camId === cam.id && now - this.identity.full.at < 3000 ? this.identity.full.frame : null;
    const frame = full || (cam.frame && now - cam.frameAt < 2000 ? cam.frame : null); if (!frame) return;
    this.cat = this.catalogue(); if (!this.cat.length) return;
    this.busy = true; this.lastAt = now;
    const id = ++this.seq;
    this.pending = { id, cameraId: cam.id, calibration: JSON.stringify(this.calibration(cam.id)?.H),
      people: view.tracks.filter(t => t.visible && t.box).map(t => t.box) };
    this.proc.stdin.write(JSON.stringify({ id, jpeg: Buffer.from(frame).toString('base64'), queries: this.cat.map((o) => o.query) }) + '\n');
    // Allow slow inference to finish without queuing another request behind it.
    this.timeout = setTimeout(() => { if (this.check) this.check.passes++; this.stop(); }, 90000);
  }
  // Ask for a room check now (the desk's button forces it past the "Mac is busy" hold, never past the voice).
  request(reason, { force = false, now = Date.now() } = {}) {
    if (this.check) { this.check.force ||= force; return; }
    this.wanted = { at: now, reason, force };
  }
  nextCheckAt() { return this.wanted ? this.wanted.at : this.lastCheckAt + CHECK_EVERY_MS; }
  // One step of the room-check cycle. True when a look may start now.
  checking(view, now) {
    this.watchLeaving(view, now);
    if (!this.check) {
      if (now < this.nextCheckAt()) { this.stop(); return false; }
      this.check = { startedAt: now, passes: 0, reason: this.wanted?.reason || 'regular check', force: !!this.wanted?.force, heldSince: 0 };
      this.wanted = null; this.lastReplyAt = 0; this.quietSince = 0;   // the gap since the last check is not a search time
    }
    const c = this.check;
    if (c.passes >= PASSES || (c.loadedAt && now - c.loadedAt > CHECK_MAX_MS)) { this.finish(now, true); return false; }
    const held = this.h.gate?.({ force: c.force }) || null;
    if (held) {
      this.waiting = held.why; this.quietSince = 0; c.heldSince ||= now;
      if (held.urgent || now - c.heldSince > HELD_UNLOAD_MS) { this.stop(); c.loadedAt = 0; }   // give the memory and the GPU back; time spent waiting is not time spent looking
      if (now - c.heldSince > GIVE_UP_MS) { this.finish(now, false); this.wanted = { at: now + RETRY_MS, reason: c.reason, force: c.force }; }
      return false;
    }
    c.heldSince = 0; this.quietSince ||= now;
    // Do not load 7 GB between two sentences: wait until the voice has been quiet for a little while.
    if (!this.proc && !c.force && now - this.quietSince < QUIET_MS) { this.waiting = 'waiting for a quiet moment'; return false; }
    this.waiting = ''; c.loadedAt ||= now;
    return true;
  }
  finish(now, done) {
    const c = this.check; this.check = null; this.waiting = ''; this.stop();
    if (!done) return;
    this.lastCheckAt = now; this.h.checked?.(now);
    this.log(`room check done (${c.reason}): ${[...this.objects.values()].filter((r) => now - r.lastSeenAt < CHECK_MAX_MS).length} objects seen`);
  }
  // Someone was at a piece of furniture and has stepped away: worth a look, it may have moved.
  watchLeaving(view, now) {
    if (now - (this.catAt || 0) > 30000) { this.catAt = now; this.movable = new Set(this.catalogue().filter((o) => o.followOnPlan !== false).map((o) => o.name)); }
    const people = view.tracks.filter((t) => t.visible && t.floor);
    for (const fp of this.room.config.floorPlan?.footprints || []) {
      if (!this.movable.has(fp.name) || !fp.points?.length) continue;
      if (people.some((t) => polyDist(t.floor, fp.points) <= NEAR_M)) this.near.set(fp.name, now);
      else if (this.near.has(fp.name) && now - this.near.get(fp.name) > LEFT_MS) {
        this.near.delete(fp.name);
        if (!this.check && now - this.lastLeftAt > LEFT_GAP_MS && now - this.lastCheckAt > LEFT_GAP_MS) { this.lastLeftAt = now; this.request(`someone was at the ${fp.name}`, { now }); }
      }
    }
  }
  onReply(m) {
    if (m.ready) { this.device = m.device; this.log(`object finder ready (${m.device})`); return; }
    const pending = this.pending;
    if (!pending || m.id !== pending.id) return;
    this.busy = false;
    this.pending = null;
    clearTimeout(this.timeout);
    if (pending.cameraId !== this.tracking.cameraId ||
        pending.calibration !== JSON.stringify(this.calibration(pending.cameraId)?.H)) return;
    // How long one search of the room really takes (≈20 s when it shares the GPU with body tracking).
    const t = Date.now(); if (this.lastReplyAt) { const gap = t - this.lastReplyAt; this.cycleMs = this.cycleMs ? 0.7 * this.cycleMs + 0.3 * gap : gap; } this.lastReplyAt = t;
    if (this.check) this.check.passes++;
    if (m.error) { this.error = m.error; return; }
    this.error = '';
    this.place(m.found || [], m.w, m.h, pending.people);
  }
  // Windows scale with the real search time, so a slow finder can still settle and propose moves.
  settleWindow() { return Math.max(SETTLE_MS, 3.5 * (this.cycleMs || 0)); }
  // Between room checks a sighting (and a move waiting for the desk) stays current until the next check.
  seenWindow() { return Math.max(EVERY_MS * 3, 1.6 * (this.cycleMs || 0), this.always ? 0 : CHECK_EVERY_MS + CHECK_MAX_MS); }
  // Floor position, and which way is "away from the camera" there, from the bottom-centre of the box.
  base(H, box) {
    const u = box.x + box.w / 2, v = box.y + box.h, p = apply(H, [u, v]), q = apply(H, [u, Math.max(0, v - 0.03)]);
    if (!p) return null;
    const dx = q ? q[0] - p[0] : 0, dy = q ? q[1] - p[1] : 0, n = Math.hypot(dx, dy) || 1;
    return { p, away: [dx / n, dy / n] };
  }
  place(found, w, h, people, now = Date.now()) {
    const cfg = this.room.config, cal = this.calibration(this.tracking.cameraId), plan = cfg.floorPlan;
    const calibrationKey = JSON.stringify(cal?.H);
    for (const f of found) {
      const o = this.cat[f.query]; if (!o || f.score < MIN_SCORE) continue;
      const box = { x: f.box[0] / w, y: f.box[1] / h, w: f.box[2] / w, h: f.box[3] / h };
      const previous = this.objects.get(o.name);
      const rec = previous?.cameraId===this.tracking.cameraId && previous.calibrationKey===calibrationKey ? previous :
        { name:o.name, cameraId:this.tracking.cameraId, calibrationKey, samples:[], firstSeenAt:now };
      Object.assign(rec, { box, score: f.score, visible: true, lastSeenAt: now, follow: o.followOnPlan !== false });
      rec.blocked = people.some((p) => overlap(box, p) > 0.2 || overlap(p, box) > 0.3);
      rec.feetVisible = box.y + box.h < 0.985;
      const fp = plan?.footprints?.find(item=>item.name===o.name);
      const moveScore = o.minMoveScore ?? .3;
      const top = o.locateBy === 'tabletop';
      let centre = cal && plan && top && !rec.blocked && f.score>=moveScore ? tabletopCentre(cal,fp,plan,box) : null;
      const croppedSeat = o.croppedSeat && box.y+box.h>=.985 && box.w>=.04 && box.h>=.1;
      if (!centre && cal && fp && croppedSeat && !rec.blocked && f.score>=.45) {
        // On this low stool the detector can return the whole silhouette even for a seat query.
        // The visible seat is near its top. Use its known height when the legs leave the picture.
        centre = atHeight(cal.H,cal.camera,[box.x+box.w*.5,box.y+box.h*.18],fp.heightM);
      }
      const b = cal && plan ? (top ? centre && {p:centre,away:[0,0]} : this.base(cal.H,box)) : null;
      if (b && (b.p[0] < -0.2 || b.p[1] < -0.2 || b.p[0] > plan.widthM + 0.2 || b.p[1] > plan.depthM + 0.2)) b.p = null;   // its box bottom is not where it meets the floor
      if (b?.p && !rec.blocked && (rec.feetVisible || top) && rec.follow) {
        rec.floor = b.p.map((v) => Math.round(v * 100) / 100); rec.away = b.away; rec.area = areaFor(plan, b.p);
        const last = rec.samples.at(-1);
        if (last && Math.hypot(b.p[0]-last.p[0],b.p[1]-last.p[1]) > MOVE_M) rec.samples = [];
        rec.samples = [...rec.samples, { at: now, p: b.p, away: b.away, score: f.score }].filter((s) => now - s.at <= this.settleWindow());
        this.settle(rec, o, plan, now);
        if ((o.autoMove ?? this.autoMove) && fp && rec.proposal && this.h.canAuto?.(o.name) !== false && rec.samples.every(sample=>sample.score>=moveScore)) {
          this.objects.set(o.name,rec);
          try { this.accept(o.name,rec.proposal.at,now,'camera'); } catch (error) { this.error=error.message; }
        }
      }
      else { rec.proposal = null; rec.samples = []; }
      this.objects.set(o.name, rec);
    }
    for (const rec of this.objects.values()) {
      rec.visible = now - rec.lastSeenAt < this.seenWindow();
      if (!rec.visible) rec.proposal = null;
    }
  }
  // Once an object's position has been steady for a while: add its outline, or move it if it has moved.
  settle(rec, o, plan, now) {
    const s = rec.samples; if (s.length < MIN_SAMPLES) { rec.proposal = null; return; }
    const mx = s.reduce((a, q) => a + q.p[0], 0) / s.length, my = s.reduce((a, q) => a + q.p[1], 0) / s.length;
    if (Math.max(...s.map((q) => Math.hypot(q.p[0] - mx, q.p[1] - my))) > SPREAD_M) { rec.proposal = null; return; }
    const away = s.at(-1).away, [fw, fd] = o.footprintM || [0.5, 0.5];
    // The box's bottom edge is the front of the object as the camera sees it: its centre is half a depth further away.
    const centre = [mx + away[0] * fd / 2, my + away[1] * fd / 2];
    const fp = (plan.footprints || []).find((x) => x.name === o.name);
    const from = fp ? [0,1].map(axis=>fp.points.reduce((sum,p)=>sum+p[axis],0)/fp.points.length) : null;
    const delta = from?.map((v,i)=>centre[i]-v);
    const dist = delta ? Math.hypot(...delta) : 0;
    if (fp && dist < (o.moveM ?? MOVE_M)) { rec.proposal = null; this.h.confirmed?.(o.name, now); return; }   // still where the plan has it
    if (!rec.proposal || Math.hypot(...centre.map((v,i)=>v-rec.proposal.to[i])) > 0.15) {
      rec.proposal = { at:now, from, to:centre, delta, distanceM:dist, geometry:JSON.stringify(fp?.points),
        placement:{ name:o.name, centre, away, size:[fw,fd], heightM:o.heightM, note:o.description } };
    }
  }
  accept(name, at, now = Date.now(), by = 'desk') {
    const rec = this.objects.get(name), proposal = rec?.proposal, plan = this.room.config.floorPlan;
    const fp = plan?.footprints.find(item=>item.name===name);
    const cal = this.calibration(this.tracking.cameraId);
    if (!cal || rec?.calibrationKey!==JSON.stringify(cal.H) || !rec?.visible || rec.cameraId!==this.tracking.cameraId || rec.blocked || now-rec.lastSeenAt>=this.seenWindow() || !proposal || proposal.at!==at ||
        proposal.geometry!==JSON.stringify(fp?.points)) throw Error('That furniture proposal is no longer current.');
    const saved = fp ? this.room.moveFootprint(name,proposal.delta,by) : this.room.addFootprint(proposal.placement);
    if (!saved) throw Error('The proposed furniture position could not be saved.');
    this.event(rec,proposal.from?areaFor(plan,proposal.from):null,areaFor(saved,proposal.to),proposal.distanceM);
    rec.samples = []; rec.proposal = null;
  }
  event(rec, from, to, dist) {
    const t = this.tracking, entry = { at: Date.now(), track: 'N:' + rec.name, who: rec.name, from, to, object: true, distanceM: Math.round(dist * 10) / 10 };
    t.movement.push(entry); t.movement = t.movement.slice(-40);
    t.h.event?.('room_object_moved', { footprint: rec.name, from, to, by: 'finder' });
  }
  status(now = Date.now()) {
    return { enabled: this.enabled, mode: !this.enabled ? 'off' : this.always ? 'always' : 'checks', ready: this.ready, running: !!this.proc, device: this.device, error: this.error,
      check: this.check ? { reason: this.check.reason, passes: this.check.passes, of: PASSES, waiting: this.waiting } : null, lastCheckAt: this.lastCheckAt, nextCheckAt: this.enabled && !this.always && this.since ? this.nextCheckAt() : 0,
      objects: [...this.objects.values()].filter((r) => r.cameraId===this.tracking.cameraId && now - r.lastSeenAt < Math.max(60000, this.seenWindow())).map((r) => ({ name: r.name, score: r.score, visible: r.visible && now-r.lastSeenAt<this.seenWindow(), box: r.box, floor: r.floor || null, area: r.area || null, blocked: r.blocked, follows: r.follow, proposal: r.visible&&now-r.lastSeenAt<this.seenWindow()&&r.proposal?{at:r.proposal.at,from:r.proposal.from,to:r.proposal.to,distanceM:r.proposal.distanceM}:null, secondsAgo: Math.round((now - r.lastSeenAt) / 1000) })) };
  }
}
module.exports = { ObjectFinder };
