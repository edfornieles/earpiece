// Sign-ups and the schedule: people sign up to take part before the day, the team sends them the schedule,
// and each person books a slot with their own private link.
//
// This is not the welcome-station registration (registry.js, the /join form with photo and signature on the
// day). A sign-up is the earlier step: who they are, how to reach them, their experience in acting, dance or
// other performing arts, that they are 18 or over, and that they agree to what taking part involves (the same
// consent text they sign again on the day). The exact text they agreed to is stored with them.
//
// Stored in participants/signups.json (personal data; the participants folder is never committed):
//   { signups: [ … ], slots: [ … ], page: { title, intro, where } }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXPERIENCE = ['Acting or theatre', 'Dance or movement', 'Performance art', 'Improvisation', 'Music or singing', 'Film or TV'];
const LEVELS = ['None', 'Some, as a hobby', 'Trained', 'Professional'];
const DEFAULT_PAGE = {
  title: 'Take part in Mother',
  intro: 'Mother is a live performance. You wear an earpiece, and a voice guides you around a studio while cameras watch. Sign up here and we will email you the schedule, so you can choose a time that suits you.',
  where: '',
};

const clean = (s, n) => String(s ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const line = (s, n) => clean(s, n).replace(/\s+/g, ' ');
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

class Signups {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.file = path.join(dir, 'signups.json'); this.now = now;
    fs.mkdirSync(dir, { recursive: true });
    this.data = { signups: [], slots: [], page: {} };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch {}
  }
  write() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2)); fs.renameSync(tmp, this.file); }
  iso() { return new Date(this.now()).toISOString(); }
  page() { return { ...DEFAULT_PAGE, ...this.data.page }; }
  setPage(p) { for (const k of Object.keys(DEFAULT_PAGE)) if (p[k] != null) this.data.page[k] = clean(p[k], k === 'title' ? 120 : 3000); this.write(); return this.page(); }

  // ---- people ----
  get(id) { return this.data.signups.find((s) => s.id === id) || null; }
  byToken(token) { return token && typeof token === 'string' ? this.data.signups.find((s) => s.token === token && !s.removed) || null : null; }
  // A public sign-up. Signing up again with the same email updates their details and keeps their booking.
  add(d, consent) {
    const name = line(d.name, 80), email = line(d.email, 120).toLowerCase();
    if (name.length < 2) throw Error('Please give your name.');
    if (!isEmail(email)) throw Error('Please give a valid email address.');
    if (d.adult !== true) throw Error('You need to be 18 or over to take part.');
    if (d.agree !== true) throw Error('Please read what taking part involves and tick to agree.');
    if (d.contact !== true) throw Error('Please agree that we can email you about the schedule.');
    if (consent && d.version !== consent.version) throw Error('The information about taking part has just been updated. Please reload the page and read it again.');
    const fields = {
      name, email, phone: line(d.phone, 40), pronouns: line(d.pronouns, 40),
      experience: { kinds: (Array.isArray(d.experience?.kinds) ? d.experience.kinds : []).filter((k) => EXPERIENCE.includes(k)), level: LEVELS.includes(d.experience?.level) ? d.experience.level : 'None', details: clean(d.experience?.details, 2000) },
      availability: clean(d.availability, 1000), access: clean(d.access, 1000), heard: line(d.heard, 200),
      consent: consent ? { version: consent.version, text: consent.text, agreedAt: this.iso() } : null, updatedAt: this.iso(),
    };
    const old = this.data.signups.find((s) => s.email === email && !s.removed);
    if (old) { Object.assign(old, fields); this.write(); return { signup: old, isNew: false }; }
    const s = { id: crypto.randomUUID(), token: crypto.randomBytes(18).toString('base64url'), ...fields, createdAt: this.iso(), invitedAt: null, booking: null, notes: '' };
    this.data.signups.push(s); this.write(); return { signup: s, isNew: true };
  }
  update(id, d) {
    const s = this.get(id); if (!s) throw Error('That sign-up no longer exists.');
    if (d.notes != null) s.notes = clean(d.notes, 2000);
    this.write(); return s;
  }
  remove(id) { const s = this.get(id); if (!s) throw Error('That sign-up no longer exists.'); this.data.signups = this.data.signups.filter((x) => x !== s); this.write(); return s; }
  markInvited(id) { const s = this.get(id); if (s) { s.invitedAt = this.iso(); this.write(); } return s; }
  list() { return this.data.signups.filter((s) => !s.removed).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  // ---- slots ----
  slot(id) { return this.data.slots.find((x) => x.id === id) || null; }
  booked(slotId) { return this.data.signups.filter((s) => s.booking?.slot === slotId); }
  slots() { return [...this.data.slots].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map((x) => ({ ...x, taken: this.booked(x.id).length })); }
  addSlots({ date, start, end, minutes, places, note }) {
    if (!DATE.test(date || '')) throw Error('Choose a date.');
    if (!TIME.test(start || '')) throw Error('Choose a start time.');
    minutes = Math.round(Number(minutes)); places = Math.round(Number(places));
    if (!(minutes >= 5 && minutes <= 600)) throw Error('A slot lasts between 5 minutes and 10 hours.');
    if (!(places >= 1 && places <= 200)) throw Error('A slot has between 1 and 200 places.');
    const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3), fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const from = toMin(start), to = end && TIME.test(end) ? toMin(end) : from + minutes;
    if (to < from + minutes) throw Error('The end time is before the first slot finishes.');
    const made = [];
    for (let m = from; m + minutes <= to && made.length < 100; m += minutes) {
      const t = fmt(m);
      if (this.data.slots.some((x) => x.date === date && x.start === t)) continue;   // never two slots at the same time
      const x = { id: crypto.randomUUID().slice(0, 8), date, start: t, minutes, places, note: line(note, 200) };
      this.data.slots.push(x); made.push(x);
    }
    if (!made.length) throw Error('Those slots already exist.');
    this.write(); return made;
  }
  editSlot(id, d) {
    const x = this.slot(id); if (!x) throw Error('That slot no longer exists.');
    if (d.places != null) { const n = Math.round(Number(d.places)); if (!(n >= 1 && n <= 200)) throw Error('A slot has between 1 and 200 places.'); if (n < this.booked(id).length) throw Error(`${this.booked(id).length} people are already booked into this slot.`); x.places = n; }
    if (d.note != null) x.note = line(d.note, 200);
    if (d.closed != null) x.closed = !!d.closed;
    this.write(); return x;
  }
  removeSlot(id) {
    const x = this.slot(id); if (!x) throw Error('That slot no longer exists.');
    const people = this.booked(id); for (const s of people) s.booking = null;
    this.data.slots = this.data.slots.filter((y) => y !== x); this.write(); return { slot: x, unbooked: people };
  }
  // Book someone into a slot (they choose it, or the team does). by: 'self' or a team member.
  book(id, slotId, by = 'self') {
    const s = this.get(id), x = this.slot(slotId);
    if (!s) throw Error('That sign-up no longer exists.');
    if (!x) throw Error('That time is no longer on the schedule. Please choose another.');
    if (s.booking?.slot === slotId) return s;
    if (by === 'self' && x.closed) throw Error('That time is closed. Please choose another.');
    if (this.booked(slotId).length >= x.places) throw Error('That time has just filled up. Please choose another.');
    s.booking = { slot: slotId, at: this.iso(), by }; this.write(); return s;
  }
  cancel(id, by = 'self') { const s = this.get(id); if (!s) throw Error('That sign-up no longer exists.'); const was = s.booking; s.booking = null; s.cancelledAt = was ? this.iso() : s.cancelledAt; s.cancelledBy = was ? by : s.cancelledBy; this.write(); return { signup: s, was }; }

  // What the person's own booking page may see: their own details, and open times with places left (never other people).
  publicView(s) {
    const mine = s.booking && this.slot(s.booking.slot);
    return { name: s.name, page: this.page(), booking: mine ? { ...pickSlot(mine) } : null,
      slots: this.slots().filter((x) => !x.closed || x.id === s.booking?.slot).map((x) => ({ ...pickSlot(x), left: Math.max(0, x.places - x.taken), mine: x.id === s.booking?.slot })) };
  }
}
const pickSlot = (x) => ({ id: x.id, date: x.date, start: x.start, minutes: x.minutes, note: x.note || '' });

const dayName = (date) => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const endOf = (x) => { const m = +x.start.slice(0, 2) * 60 + +x.start.slice(3) + x.minutes; return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const when = (x) => `${dayName(x.date)}, ${x.start}–${endOf(x)}`;

// The three emails. Plain text; the booking link is the person's own and lets them change or cancel.
const emails = {
  received: (s, page, link) => ({ subject: `${page.title}: you are signed up`,
    text: `Hi ${s.name},\n\nThank you for signing up to take part in Mother. We will email you the schedule soon, with a link to choose a time.\n\nIf you already have the link, you can use it any time:\n${link}\n\nIf you have any questions, just reply to this email.\n\nMother\n` }),
  schedule: (s, page, link, slots) => ({ subject: `${page.title}: choose your time`,
    text: `Hi ${s.name},\n\nThe schedule for Mother is ready. Choose the time that suits you here:\n${link}\n\n${slots.length ? 'Times so far:\n' + summarise(slots) + '\n\n' : ''}${page.where ? 'Where: ' + page.where + '\n\n' : ''}The link is just for you: use it to book, change or cancel.\n\nMother\n` }),
  booked: (s, page, link, x) => ({ subject: `${page.title}: you are booked for ${dayName(x.date)} at ${x.start}`,
    text: `Hi ${s.name},\n\nYou are booked to take part in Mother:\n${when(x)}${x.note ? ' (' + x.note + ')' : ''}\n${page.where ? '\nWhere: ' + page.where + '\n' : ''}\nPlease arrive a few minutes early. On the day you will be asked to read and sign the consent form again, and to have your photo taken.\n\nTo change or cancel your time:\n${link}\n\nMother\n` }),
};
function summarise(slots) {
  const byDay = new Map(); for (const x of slots) byDay.set(x.date, [...(byDay.get(x.date) || []), x]);
  return [...byDay].map(([d, xs]) => `- ${dayName(d)}: ${xs[0].start} to ${endOf(xs.at(-1))}`).join('\n');
}

module.exports = { Signups, EXPERIENCE, LEVELS, DEFAULT_PAGE, emails, when, dayName };
