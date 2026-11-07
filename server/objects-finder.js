// Named studio objects, found by description in the tracking camera (object_finder.py, OWLv2, local).
// The descriptions come from room-objects/objects.json ("query" for each object; "followOnPlan" for
// objects whose feet the camera sees, so their floor position can be trusted).
//
// Every few seconds while tracking runs, each object found is placed on the floor through the camera's
// calibration. An object with a plan outline of the same name moves that outline once it has settled
// somewhere new; an object without one gets an estimated outline ("placed by the camera").
// A person standing in front of an object never moves it.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { apply, areaFor } = require('./tracking');

const EVERY_MS = 2500, SETTLE_MS = 12000, MIN_SAMPLES = 3, MOVE_M = 0.4, SPREAD_M = 0.3, MIN_SCORE = 0.22;
const overlap = (a, b) => { const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); return x * y / (a.w * a.h || 1); };

class ObjectFinder {
  constructor({ root, cameras, tracking, room, identity, log = () => {}, spawnImpl = spawn }) {
    Object.assign(this, { root, cameras, tracking, room, identity, log, spawnImpl });
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
    this.proc = this.spawnImpl(this.py, [path.join(this.root, 'object_finder.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { this.onReply(JSON.parse(line)); } catch {} } });
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => { this.proc = null; this.device = null; this.busy = false; });
  }
  stop() { if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; } }
  tick(now = Date.now()) {
    const view = this.tracking.view(now);
    if (!view.running) { this.stop(); return; }   // only while someone is tracking: it uses the GPU
    this.start();
    if (!this.device || this.busy || now - this.lastAt < EVERY_MS) return;
    const cam = this.cameras.find((c) => c.id === this.tracking.cameraId); if (!cam) return;
    const full = this.identity?.full?.camId === cam.id && now - this.identity.full.at < 3000 ? this.identity.full.frame : null;
    const frame = full || (cam.frame && now - cam.frameAt < 2000 ? cam.frame : null); if (!frame) return;
    this.cat = this.catalogue(); if (!this.cat.length) return;
    this.busy = true; this.lastAt = now; this.pendingTracks = view.tracks.filter((t) => t.visible && t.box).map((t) => t.box);
    this.proc.stdin.write(JSON.stringify({ id: ++this.seq, jpeg: Buffer.from(frame).toString('base64'), queries: this.cat.map((o) => o.query) }) + '\n');
    setTimeout(() => { this.busy = false; }, 15000);
  }
  onReply(m) {
    if (m.ready) { this.device = m.device; this.log(`object finder ready (${m.device})`); return; }
    this.busy = false;
    if (m.error) { this.error = m.error; return; }
    this.error = '';
    this.place(m.found || [], m.w, m.h, this.pendingTracks || []);
  }
  // Floor position, and which way is "away from the camera" there, from the bottom-centre of the box.
  base(H, box) {
    const u = box.x + box.w / 2, v = box.y + box.h, p = apply(H, [u, v]), q = apply(H, [u, Math.max(0, v - 0.03)]);
    if (!p) return null;
    const dx = q ? q[0] - p[0] : 0, dy = q ? q[1] - p[1] : 0, n = Math.hypot(dx, dy) || 1;
    return { p, away: [dx / n, dy / n] };
  }
  place(found, w, h, people, now = Date.now()) {
    const cfg = this.room.config, cal = cfg.calibrations?.[this.tracking.cameraId], plan = cfg.floorPlan;
    for (const f of found) {
      const o = this.cat[f.query]; if (!o || f.score < MIN_SCORE) continue;
      const box = { x: f.box[0] / w, y: f.box[1] / h, w: f.box[2] / w, h: f.box[3] / h };
      const previous = this.objects.get(o.name);
      const rec = previous?.cameraId===this.tracking.cameraId ? previous :
        { name:o.name, cameraId:this.tracking.cameraId, samples:[], firstSeenAt:now };
      Object.assign(rec, { box, score: f.score, lastSeenAt: now, follow: o.followOnPlan !== false });
      rec.blocked = people.some((p) => overlap(box, p) > 0.2 || overlap(p, box) > 0.3);
      rec.feetVisible = box.y + box.h < 0.985;
      const b = cal && !cal.needsReview && plan ? this.base(cal.H, box) : null;
      if (b && (b.p[0] < -0.2 || b.p[1] < -0.2 || b.p[0] > plan.widthM + 0.2 || b.p[1] > plan.depthM + 0.2)) b.p = null;   // its box bottom is not where it meets the floor
      if (b?.p && !rec.blocked && rec.feetVisible && rec.follow) {
        rec.floor = b.p.map((v) => Math.round(v * 100) / 100); rec.away = b.away; rec.area = areaFor(plan, b.p);
        rec.samples = [...rec.samples, { at: now, p: b.p, away: b.away }].filter((s) => now - s.at <= SETTLE_MS);
        this.settle(rec, o, plan, now);
      }
      else { rec.proposal = null; rec.samples = []; }
      this.objects.set(o.name, rec);
    }
    for (const rec of this.objects.values()) {
      rec.visible = now - rec.lastSeenAt < EVERY_MS * 3;
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
    if (fp && dist < MOVE_M) { rec.proposal = null; return; }
    if (!rec.proposal || Math.hypot(...centre.map((v,i)=>v-rec.proposal.to[i])) > 0.15) {
      rec.proposal = { at:now, from, to:centre, delta, distanceM:dist, geometry:JSON.stringify(fp?.points),
        placement:{ name:o.name, centre, away, size:[fw,fd], heightM:o.heightM, note:o.description } };
    }
  }
  accept(name, at, now = Date.now()) {
    const rec = this.objects.get(name), proposal = rec?.proposal, plan = this.room.config.floorPlan;
    const fp = plan?.footprints.find(item=>item.name===name);
    if (!rec?.visible || rec.cameraId!==this.tracking.cameraId || rec.blocked || now-rec.lastSeenAt>=EVERY_MS*3 || !proposal || proposal.at!==at ||
        proposal.geometry!==JSON.stringify(fp?.points)) throw Error('That furniture proposal is no longer current.');
    const saved = fp ? this.room.moveFootprint(name,proposal.delta) : this.room.addFootprint(proposal.placement);
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
    return { ready: this.ready, running: !!this.proc, device: this.device, error: this.error,
      objects: [...this.objects.values()].filter((r) => r.cameraId===this.tracking.cameraId && now - r.lastSeenAt < 60000).map((r) => ({ name: r.name, score: r.score, visible: r.visible, box: r.box, floor: r.floor || null, area: r.area || null, blocked: r.blocked, follows: r.follow, proposal: r.visible&&r.proposal?{at:r.proposal.at,from:r.proposal.from,to:r.proposal.to,distanceM:r.proposal.distanceM}:null, secondsAgo: Math.round((now - r.lastSeenAt) / 1000) })) };
  }
}
module.exports = { ObjectFinder };
