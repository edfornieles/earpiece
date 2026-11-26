// Describing (after Dan Graham, Performer/Audience/Mirror). An automatic program, 15 minutes by default.
//
// Mother watches each participant through the cameras and speaks, into that person's own earpiece only, what it
// notices about them. It moves gradually through three movements:
//   physical    only what can be seen: posture, position, hands, clothes, what they hold
//   behaviour   patterns over time: where they go and return to, what they repeat, how they relate to others
//   projection  speculation about their life and what they are thinking, built on what it has already observed
// A line every ~22 s per person, never while that phone is already speaking or held by the desk.
//
// The server passes in what this needs (h):
//   phones()          ids of the phones taking part
//   see(id)           { jpeg|null, notes, file } : a close-up of that participant now and what tracking knows
//   write(jpeg, sys, user)  one line from the vision model
//   speak(id, text)   say it in that phone's Mother voice (transcript + recording)
//   busy(id)          true while that phone is speaking, thinking or held
//   log(type, data), changed()
const MOVEMENTS = [
  { name: 'physical', label: 'Physical', guide: 'Describe only what is physically visible right now: posture, where they are in the room, their hands, what they hold, how they stand or move, their clothes. No interpretation at all.' },
  { name: 'behaviour', label: 'Behaviour', guide: 'Describe patterns over time and how they relate to the room and the other people in it: what they keep doing, where they return to, how long they stay still, who or what they look at. Mild interpretation of behaviour is allowed; no guesses about their life yet.' },
  { name: 'projection', label: 'Projection', guide: 'Project: speculate about their life outside this room and what they might be thinking or feeling, built on what you have observed. Always frame it as speculation ("perhaps", "as if", "maybe you"). Let it grow more intimate as the piece nears its end.' },
];

const SYSTEM = `You are Mother, a voice in one person's earpiece in a gallery, performing "Describing" (after Dan Graham's Performer/Audience/Mirror). You watch this person through a camera and tell them, privately, what you notice about them.
Speak to them as "you", in the present tense. One or two short sentences, at most 28 words. Calm, attentive, precise; never cruel, never flattering.
Never use names. Never give instructions or ask questions. Never repeat or closely paraphrase anything you have already said to them.
Never mention or guess race, ethnicity, nationality, religion, health, disability, sexuality, body size or weight, attractiveness, or age. Work from what they do, how they hold themselves, and what they wear or carry.
If the picture does not clearly show them, say something true about not seeing them right now, without guessing where they are.
Reply with the line only.`;

class Describing {
  constructor(h) { this.h = h; this.reset(); }
  reset() { this.running = false; this.held = false; this.startedAt = 0; this.heldAt = 0; this.heldFor = 0; this.skipTo = 0; this.minutes = 15; this.every = 22; this.people = new Map(); clearInterval(this.timer); this.timer = null; }

  elapsed(now = Date.now()) { return this.running ? (Math.min(now, this.held ? this.heldAt : now) - this.startedAt - this.heldFor) / 1000 : 0; }
  // 0..1 through the piece; a "skip" jumps to the start of the next movement
  progress(now) { return Math.min(1, Math.max(this.skipTo, this.elapsed(now) / (this.minutes * 60))); }
  movementAt(p) { return MOVEMENTS[Math.min(2, Math.floor(p * 3))]; }

  start({ minutes = 15, every = 22 } = {}) {
    this.reset();
    this.running = true; this.startedAt = Date.now(); this.minutes = Math.max(1, Math.min(120, Number(minutes) || 15)); this.every = Math.max(8, Math.min(120, Number(every) || 22));
    this.h.log('describing_start', { minutes: this.minutes, every: this.every, phones: this.h.phones() });
    this.timer = setInterval(() => this.tick().catch((e) => this.h.log('describing_error', { message: e.message })), 1000);
    this.h.changed();
  }
  hold() { if (!this.running || this.held) return; this.held = true; this.heldAt = Date.now(); this.h.log('describing_hold', {}); this.h.changed(); }
  resume() { if (!this.held) return; this.heldFor += Date.now() - this.heldAt; this.held = false; this.h.log('describing_resume', {}); this.h.changed(); }
  skip() { if (!this.running) return; const p = this.progress(); this.skipTo = Math.min(1, (Math.floor(p * 3) + 1) / 3); this.h.log('describing_skip', { to: this.movementAt(Math.min(0.99, this.skipTo)).name }); this.h.changed(); }
  stop(why = 'stopped from the desk') { if (!this.running) return; this.h.log('describing_end', { why, elapsed: Math.round(this.elapsed()) }); this.reset(); this.h.changed(); }

  async tick() {
    if (!this.running || this.held) return;
    const now = Date.now(), p = this.progress(now);
    if (p >= 1) return this.stop('finished');
    for (const id of this.h.phones()) {
      const me = this.people.get(id) || { lines: [], next: now + 2000 + this.people.size * 3000, working: false };   // stagger the phones
      this.people.set(id, me);
      if (me.working || now < me.next || this.h.busy(id)) continue;
      me.working = true;
      this.line(id, me, p).finally(() => { me.working = false; me.next = Date.now() + this.every * 1000 * (0.85 + Math.random() * 0.3); });
    }
  }

  async line(id, me, p) {
    const mv = this.movementAt(p), pct = Math.round(p * 100);
    const seen = await this.h.see(id);
    const said = me.lines.slice(-8).map((l) => `- (${l.movement}) ${l.text}`).join('\n') || '(nothing yet)';
    const user = `The piece is ${pct}% through (${Math.round(this.minutes * p)} of ${this.minutes} minutes). Current movement: ${mv.label}. ${mv.guide}
${pct % 33 > 25 && mv.name !== 'projection' ? 'You are near the end of this movement: begin to lean toward the next.\n' : ''}What tracking knows about them now: ${seen.notes || 'nothing'}
What you have already said to them (do not repeat):
${said}`;
    let text = '';
    try { text = (await this.h.write(seen.jpeg, SYSTEM, user)).replace(/^["“]|["”]$/g, '').trim(); }
    catch (e) { this.h.log('describing_error', { id, message: e.message }); return; }
    if (!text || !this.running || this.held) return;
    me.lines.push({ movement: mv.name, text, at: this.elapsed() });
    this.h.log('describing_line', { id, movement: mv.name, progress: pct, text, file: seen.file || null });
    this.h.speak(id, text);
    this.h.changed();
  }

  status() {
    const p = this.progress();
    return { running: this.running, held: this.held, minutes: this.minutes, every: this.every, elapsed: Math.round(this.elapsed()), progress: Math.round(p * 100),
      movement: this.running ? this.movementAt(Math.min(0.999, p)).label : null,
      phones: [...this.people].map(([id, m]) => ({ id, lines: m.lines.length, last: m.lines[m.lines.length - 1]?.text || '' })) };
  }
}

module.exports = { Describing, MOVEMENTS };
