// Everyone who registers at the welcome station, across all sessions.
//   participants/registry.json        the list
//   participants/<pid>/photo.jpg      the photo they took
//   participants/<pid>/consent.md     the exact consent text they agreed to, with their signature and the time
// A registration is copied into a session (documents/<Name>_<pid>/) when they start on a phone or are linked by hand,
// so every session folder stays complete on its own. Contains personal data: never commit or publish this folder.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->\s*/g, '');

class Registry {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, 'participants');
    this.file = path.join(this.dir, 'registry.json');
    fs.mkdirSync(this.dir, { recursive: true });
    try { this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.list = []; }
  }
  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.list, null, 2)); fs.renameSync(tmp, this.file); }
  get(pid) { return this.list.find((x) => x.pid === pid); }

  // the consent text people see: consent.md if Ed has written one, otherwise the draft
  consent() {
    const own = path.join(this.root, 'consent.md'), draft = path.join(this.root, 'consent.example.md');
    const file = fs.existsSync(own) ? own : draft;
    const text = stripComments(fs.readFileSync(file, 'utf8')).trim();
    return { text, version: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12), draft: file === draft };
  }

  add({ name, email, face, signature, photo, ip }) {
    const pid = 'p' + crypto.randomBytes(3).toString('hex');
    const now = new Date();
    const today = now.toDateString();
    const number = this.list.filter((x) => new Date(x.registered).toDateString() === today).length + 1;
    const { text, version } = this.consent();
    const d = path.join(this.dir, pid);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'photo.jpg'), photo);
    fs.writeFileSync(path.join(d, 'consent.md'), `${text}\n\n---\n\n` +
      `**Agreed by:** ${name}  \n**Signed (typed name):** ${signature}  \n**Email:** ${email}  \n` +
      `**Confirmed 18 or over:** yes  \n**Face matching:** ${face ? 'YES — agreed' : 'no'}  \n` +
      `**When:** ${now.toISOString()} (${now.toString()})  \n**Consent version:** ${version}  \n**Registration:** ${pid}${ip ? `  \n**From:** ${ip}` : ''}\n`);
    const x = { pid, number, name, email, adult: true, face: !!face, signature, consentVersion: version, registered: now.toISOString(),
      photo: `participants/${pid}/photo.jpg`, consent: `participants/${pid}/consent.md`, sessions: [] };
    this.list.push(x); this.save();
    return x;
  }
  update(pid, d) {
    const x = this.get(pid); if (!x) return null;
    for (const k of ['name', 'email', 'notes']) if (typeof d[k] === 'string') x[k] = d[k].slice(0, k === 'notes' ? 4000 : 200);
    this.save(); return x;
  }
  noteSession(pid, session, how) {
    const x = this.get(pid); if (!x) return;
    if (!x.sessions.find((s) => s.session === session)) x.sessions.push({ session, how, at: new Date().toISOString() });
    this.save();
  }
  forgetSession(pid, session) {
    const x = this.get(pid); if (!x) return;
    x.sessions = x.sessions.filter((s) => s.session !== session); this.save();
  }
  // copy their photo and signed consent into a session folder; returns the session-relative paths
  copyInto(sessionDir, pid, safeName) {
    const x = this.get(pid);
    const rel = path.join('documents', `${safeName(x.name || 'person').replace(/ /g, '_')}_${pid}`);
    fs.mkdirSync(path.join(sessionDir, rel), { recursive: true });
    const files = [];
    for (const [src, name] of [[x.photo, 'photo.jpg'], [x.consent, 'consent (signed).md']]) {
      const to = path.join(sessionDir, rel, name);
      try { if (!fs.existsSync(to)) fs.copyFileSync(path.join(this.root, src), to); files.push({ file: path.join(rel, name), name, size: fs.statSync(to).size, added: new Date().toISOString() }); } catch {}
    }
    return { files, photo: path.join(rel, 'photo.jpg') };
  }
}

module.exports = { Registry };
