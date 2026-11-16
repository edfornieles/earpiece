// Protocols: the actions a session can deploy, and the four caregiver voices.
//
// Each session the control team adopts one caregiver voice (Warm or Cold, Selfless or Selfish). It sets
// Mother's attitude and tone, and changes the objectives of whatever action is running. A protocol is one
// action: title, what is involved, how many people it works with, how it plays under each of the four voices,
// and optional extras (instructions to Mother, setup, care, debrief questions). A session deploys one or more
// protocols, one running at a time; their exact wording is copied into the session when deployed, so later
// edits never change what a recording says it used.
//
// Stored in protocols.json next to this file (not in git): { voices: { id: text }, protocols: [ … ] }.
const fs = require('fs');
const crypto = require('crypto');

const VOICES = [
  { id: 'warm-selfless', name: 'Warm / Selfless', warm: true, selfless: true },
  { id: 'cold-selfless', name: 'Cold / Selfless', warm: false, selfless: true },
  { id: 'warm-selfish', name: 'Warm / Selfish', warm: true, selfless: false },
  { id: 'cold-selfish', name: 'Cold / Selfish', warm: false, selfless: false },
];
// Starting points only: the team rewrites these on the Protocols page.
const DEFAULT_VOICE_TEXT = {
  'warm-selfless': 'Attitude: affectionate, patient, encouraging; praise freely and reassure.\nObjective: the participant\'s own wellbeing and growth. Everything you ask is for their benefit; let them go at their pace.',
  'cold-selfless': 'Attitude: detached, brisk, procedural; few words, no praise, no small talk.\nObjective: still the participant\'s own good, delivered like a strict professional who knows what is best for them.',
  'warm-selfish': 'Attitude: affectionate, intimate, flattering; make them feel special.\nObjective: your own needs as the caregiver. You want to be needed, obeyed and kept close; use warmth to get it.',
  'cold-selfish': 'Attitude: detached, demanding, impatient; correct rather than encourage.\nObjective: your own needs as the caregiver. Their comfort matters only as far as it serves what you want from them.',
};

const clean = (s, n) => String(s ?? '').replace(/\r\n/g, '\n').trim().slice(0, n);
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo ? Math.min(hi, n) : null; };

function normalise(p, old = {}) {
  const title = clean(p.title, 120); if (!title) throw Error('Give the protocol a title.');
  let min = int(p.people?.min, 1, 99), max = int(p.people?.max, 1, 99);
  if (min && max && max < min) [min, max] = [max, min];
  const voices = {}; for (const v of VOICES) { const t = clean(p.voices?.[v.id], 3000); if (t) voices[v.id] = t; }
  const tags = [...new Set((Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).map((t) => clean(t, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
  const more = {}; for (const k of ['mother', 'setup', 'care', 'debrief']) { const t = clean(p.more?.[k], 6000); if (t) more[k] = t; }
  const minutes = int(p.more?.minutes, 1, 600); if (minutes) more.minutes = minutes;
  return { id: old.id || crypto.randomUUID(), title, description: clean(p.description, 4000), people: { min, max }, voices, tags, more,
    revision: (old.revision || 0) + 1, createdAt: old.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
}

class ProtocolStore {
  constructor(file) {
    this.file = file; this.data = { voices: {}, protocols: [] };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  }
  write() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2)); fs.renameSync(tmp, this.file); }
  voices() { return VOICES.map((v) => ({ ...v, text: this.data.voices[v.id] ?? DEFAULT_VOICE_TEXT[v.id], defaultText: DEFAULT_VOICE_TEXT[v.id] })); }
  voice(id) { return this.voices().find((v) => v.id === id) || null; }
  setVoiceText(id, text) {
    if (!VOICES.some((v) => v.id === id)) throw Error('Choose one of the four voices.');
    const t = clean(text, 3000); if (!t || t === DEFAULT_VOICE_TEXT[id]) delete this.data.voices[id]; else this.data.voices[id] = t;
    this.write(); return this.voice(id);
  }
  list() { return [...this.data.protocols].sort((a, b) => a.title.localeCompare(b.title)); }
  get(id) { return this.data.protocols.find((p) => p.id === id) || null; }
  save(p) {
    const old = p.id ? this.get(p.id) : null;
    if (p.id && !old) throw Error('That protocol no longer exists.');
    if (old && p.revision != null && p.revision !== old.revision) throw Error('Someone else saved this protocol meanwhile. Reload it before saving.');
    const next = normalise(p, old || {});
    this.data.protocols = old ? this.data.protocols.map((x) => (x === old ? next : x)) : [...this.data.protocols, next];
    this.write(); return next;
  }
  remove(id) { const p = this.get(id); if (!p) throw Error('That protocol no longer exists.'); this.data.protocols = this.data.protocols.filter((x) => x !== p); this.write(); return p; }
}

// What Mother is told: the session's caregiver voice, and the running action under that voice.
function motherPrompt({ voice, action } = {}) {
  const out = [];
  if (voice) out.push(`CAREGIVER VOICE FOR THIS SESSION: ${voice.name}\n${voice.text}\nHold this attitude, tone and objective in everything you say, including when you adapt or improvise.`);
  if (action) {
    const p = action.snapshot, how = voice && p.voices?.[voice.id];
    out.push([`CURRENT ACTION: ${p.title}`, p.description, p.people?.min || p.people?.max ? `Works with ${p.people.min || '?'}–${p.people.max || p.people.min} people.` : '',
      how ? `Under the ${voice.name} voice: ${how}` : '', p.more?.mother ? `Instructions for this action: ${p.more.mother}` : '',
      p.more?.care ? `Care and stop conditions (always respect these): ${p.more.care}` : ''].filter(Boolean).join('\n'));
  }
  return out.length ? '\n\n---\n' + out.join('\n\n') : '';
}

module.exports = { VOICES, DEFAULT_VOICE_TEXT, ProtocolStore, motherPrompt, normalise };
