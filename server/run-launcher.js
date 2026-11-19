// "Run" a program in one step. The desk picks a program and (optionally) which phone plays each role;
// Mother does the rest: starts recording if it is in standby (carrying the run through the restart),
// starts a visit on each assigned phone as soon as it is connected, and starts the score when every
// role is ready. While it waits it says exactly what it is waiting for.
const GIVE_UP_MS = 15 * 60 * 1000;

class Launcher {
  // h: { standby, maxPhones, program(id), phones() → [{id, connected, waiting, ready, problem}],
  //      runner, select(selection), remember(selection, pending), beginVisit(id), startRecording(), log }
  constructor(h) { this.h = h; this.pending = null; this.error = ''; }

  // Suggested assignment: roles in order onto connected phones first, then free slots.
  suggest(program) {
    const phones = this.h.phones(), max = this.h.maxPhones();
    const order = [...phones.filter((p) => p.connected).map((p) => p.id), ...Array.from({ length: max }, (_, i) => i + 1)];
    const used = new Set(), out = {};
    for (const role of program.roles) { const id = order.find((n) => !used.has(n)); if (id == null) break; used.add(id); out[role.id] = id; }
    return out;
  }
  plan(id) {
    const program = this.h.program(id); if (!program) throw Error('That program no longer exists.');
    const run = this.h.runner.view();
    return { program: { id: program.id, title: program.title, revision: program.revision, roles: program.roles.map((r) => ({ id: r.id, name: r.name })) },
      phones: this.h.phones(), maxPhones: this.h.maxPhones(), assignments: this.suggest(program), standby: this.h.standby,
      busy: ['running', 'paused'].includes(run.status) ? run.program?.title || 'a program' : null };
  }
  run({ id, assignments, replace = false }) {
    const program = this.h.program(id); if (!program) throw Error('That program no longer exists.');
    if (program.roles.length > this.h.maxPhones()) throw Error(`This program needs ${program.roles.length} phones. Add phone slots on Setup → Phones.`);
    const chosen = { ...this.suggest(program), ...(assignments || {}) }, used = new Set(), out = {};
    for (const role of program.roles) {
      const n = Number(chosen[role.id]);
      if (!Number.isInteger(n) || n < 1 || n > this.h.maxPhones() || used.has(n)) throw Error('Give every role its own phone.');
      used.add(n); out[role.id] = n;
    }
    const status = this.h.runner.view().status;
    if (['running', 'paused'].includes(status)) {
      if (!replace) throw Error('Another program is running. Stop it, or choose to replace it.');
      this.h.runner.stop();
    }
    const selection = { snapshot: program, assignments: out, timing: 'shared' };
    this.error = '';
    if (this.h.standby) {   // recording restarts the server; the run continues from what is remembered
      this.h.remember(selection, { at: Date.now() });
      this.h.log(`run: ${program.title} — starting recording`);
      this.h.startRecording();
      return { phase: 'recording' };
    }
    this.h.select(selection);
    this.pending = { since: Date.now(), assignments: out, title: program.title };
    this.h.log(`run: ${program.title}`);
    this.tick();
    return { phase: this.pending ? 'waiting' : 'running' };
  }
  // Play: no program, just Mother and one phone, with tracking on. Same start-up path as a run.
  play({ phone, replace = false } = {}) {
    const status = this.h.runner.view().status;
    if (['running', 'paused'].includes(status)) { if (!replace) throw Error('A program is running. Stop it, or choose to replace it.'); this.h.runner.stop(); }
    const n = Number(phone) || this.h.phones().find((p) => p.connected)?.id || 1;
    if (!Number.isInteger(n) || n < 1 || n > this.h.maxPhones()) throw Error('Choose a phone.');
    this.error = '';
    if (this.h.standby) { this.h.rememberPlay(n); this.h.log(`play on phone ${n} — starting recording`); this.h.startRecording(); return { phase: 'recording' }; }
    this.pending = { since: Date.now(), assignments: { play: n }, title: 'Play', play: true };
    this.tick();
    return { phase: this.pending ? 'waiting' : 'playing' };
  }
  resumePlay(phone) { this.pending = { since: Date.now(), assignments: { play: Number(phone) || 1 }, title: 'Play', play: true }; }
  // Called after a restart into recording when a run was remembered.
  resume(selection) { if (selection) this.pending = { since: Date.now(), assignments: selection.assignments, title: selection.snapshot.title }; }
  cancel() { this.pending = null; }

  tick(now = Date.now()) {
    const p = this.pending; if (!p || this.h.standby) return;
    if (now - p.since > GIVE_UP_MS) { this.pending = null; this.error = 'Gave up waiting for the phones. Press Run again when they are ready.'; return; }
    const phones = new Map(this.h.phones().map((x) => [x.id, x]));
    for (const id of Object.values(p.assignments)) { const ph = phones.get(id); if (ph?.connected && ph.waiting) this.h.beginVisit(id); }
    this.h.startTracking?.();
    const waiting = this.waitingFor(phones);
    if (waiting.length) return;
    if (p.play) { this.pending = null; this.h.startPlay(p.assignments.play); this.h.log(`play started on phone ${p.assignments.play}`); return; }
    try { this.h.runner.start(); this.pending = null; this.h.log(`run: ${p.title} started`); }
    catch (e) { this.error = e.message; }
  }
  waitingFor(phones = new Map(this.h.phones().map((x) => [x.id, x]))) {
    if (!this.pending) return [];
    return Object.values(this.pending.assignments).map((id) => ({ id, ...phones.get(id) })).filter((x) => !x.ready)
      .map((x) => ({ phone: x.id, reason: !x.connected ? 'connect the phone' : x.problem || 'starting its visit' }));
  }
  status() { return this.pending ? { title: this.pending.title, waitingFor: this.waitingFor(), since: this.pending.since, error: this.error } : this.error ? { error: this.error } : null; }
}
module.exports = { Launcher };
