// Automatic scores: programs Mother runs by itself in the space, one at a time (scores/*.js, listed in scores/index.js).
// A score declares its settings (params), its movements over the duration, and how to write one line for one person
// (prompt / finish). This runner does the timing: a line per participant every so often, never over other speech,
// hold / resume / next movement / stop from the desk, and settings marked "live" can change while it runs.
//
// The server passes in (h):
//   phones()                     ids of the phones taking part
//   see(id)                      { images: [{ jpeg, detail }], about, notes, file }
//   write(images, system, user, { fast, maxTokens })   one line from the vision model
//   speak(id, text, scoreTitle)  say it in that phone's Mother voice (transcript + recording)
//   busy(id)                     true while that phone is speaking, thinking or held
//   log(type, data), changed()
const SCORES = require('./scores');

class ScoreRunner {
  constructor(h) { this.h = h; this.reset(); }
  reset() { clearInterval(this.timer); Object.assign(this, { score: null, params: {}, running: false, held: false, startedAt: 0, heldAt: 0, heldFor: 0, skipTo: 0, people: new Map(), timer: null }); }
  list() { return SCORES.map(({ id, title, about, params }) => ({ id, title, about, params })); }

  defaults(score) { return Object.fromEntries(score.params.map((p) => [p.key, p.default])); }
  clean(score, given = {}, onlyLive = false) {
    const out = {};
    for (const p of score.params) {
      if (!(p.key in given) || (onlyLive && !p.live)) continue;
      const v = given[p.key], ok = p.options ? p.options.find((o) => String(o.value) === String(v)) : null;
      if (ok) out[p.key] = ok.value;
    }
    return out;
  }
  minutes() { return Number(this.params.minutes) || 15; }
  elapsed(now = Date.now()) { return this.running ? (Math.min(now, this.held ? this.heldAt : now) - this.startedAt - this.heldFor) / 1000 : 0; }
  progress(now) { return Math.min(1, Math.max(this.skipTo, this.elapsed(now) / (this.minutes() * 60))); }
  movement(p = this.progress()) { const ms = this.score.movements(this.params); return ms.find((m) => p < m.until) || ms[ms.length - 1]; }

  start(id, params = {}) {
    const score = SCORES.find((s) => s.id === id); if (!score) throw Error('No such score.');
    this.reset();
    Object.assign(this, { score, params: { ...this.defaults(score), ...this.clean(score, params) }, running: true, startedAt: Date.now() });
    this.h.log('score_start', { score: score.id, params: this.params, phones: this.h.phones() });
    this.timer = setInterval(() => this.tick().catch((e) => this.h.log('score_error', { message: e.message })), 1000);
    this.h.changed();
  }
  set(params) { if (!this.running) return; const ch = this.clean(this.score, params, true); Object.assign(this.params, ch); this.h.log('score_set', { score: this.score.id, ...ch }); this.h.changed(); }
  hold() { if (!this.running || this.held) return; this.held = true; this.heldAt = Date.now(); this.h.log('score_hold', { score: this.score.id }); this.h.changed(); }
  resume() { if (!this.held) return; this.heldFor += Date.now() - this.heldAt; this.held = false; this.h.log('score_resume', { score: this.score.id }); this.h.changed(); }
  next() { if (!this.running) return; const m = this.movement(); this.skipTo = Math.min(1, m.until); this.h.log('score_next', { score: this.score.id, to: this.movement(Math.min(0.999, this.skipTo)).name }); this.h.changed(); }
  stop(why = 'stopped from the desk') { if (!this.running) return; this.h.log('score_end', { score: this.score.id, why, elapsed: Math.round(this.elapsed()) }); this.reset(); this.h.changed(); }

  async tick() {
    if (!this.running || this.held) return;
    const now = Date.now(), p = this.progress(now);
    if (p >= 1) return this.stop('finished');
    const every = Number(this.params.every) || 22;
    for (const id of this.h.phones()) {
      const me = this.people.get(id) || { lines: [], next: now + 1500 + this.people.size * 3000, working: false };   // stagger the phones
      this.people.set(id, me);
      if (me.working || now < me.next || this.h.busy(id)) continue;
      me.working = true;
      this.line(id, me, p).finally(() => { me.working = false; me.next = Date.now() + every * 1000 * (0.85 + Math.random() * 0.3); });
    }
  }

  async line(id, me, p) {   // never lets an error escape: a fault in one line must not stop Mother
    try { await this.lineInner(id, me, p); } catch (e) { this.h.log('score_error', { score: this.score?.id, id, message: e.message }); console.error('  score line failed: ' + e.message); }
  }
  async lineInner(id, me, p) {
    const movement = this.movement(p), seen = await this.h.see(id);
    const ctx = { movement, progress: p, params: this.params, about: seen.about, notes: seen.notes, inMovement: me.lines.filter((l) => l.movement === movement.name).length,
      said: me.lines.slice(-8).map((l) => `- (${l.movement}) ${l.text}`).join('\n') };
    const ask = this.score.prompt(ctx);
    let text = null;
    try { text = this.score.finish(await this.h.write(seen.images, ask.system, ask.user, { fast: ask.fast, maxTokens: ask.maxTokens }), ctx); }
    catch (e) { this.h.log('score_error', { score: this.score.id, id, message: e.message }); return; }
    if (!text || !this.running || this.held) return;   // null: the score chose silence this time
    me.lines.push({ movement: movement.name, text });
    this.h.log('score_line', { score: this.score.id, id, movement: movement.name, progress: Math.round(p * 100), tone: this.params.tone, text, file: seen.file || null });
    this.h.speak(id, text, this.score.title);
    this.h.changed();
  }

  status() {
    if (!this.running) return { running: false, scores: this.list() };
    const p = this.progress();
    return { running: true, id: this.score.id, title: this.score.title, held: this.held, params: this.params, minutes: this.minutes(),
      elapsed: Math.round(this.elapsed()), progress: Math.round(p * 100), movement: this.movement(Math.min(0.999, p)).label,
      movements: this.score.movements(this.params).map((m) => ({ label: m.label, until: m.until })),
      phones: [...this.people].map(([id, m]) => ({ id, lines: m.lines.length, last: m.lines[m.lines.length - 1]?.text || '' })), scores: this.list() };
  }
}

module.exports = { ScoreRunner, SCORES };
