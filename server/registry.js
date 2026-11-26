// Everyone who registers at the welcome station, across all sessions.
//   participants/registry.json        the list
//   participants/<pid>/photo.jpg      the photo they took
//   participants/<pid>/consent.md     the exact consent text they agreed to, with their signature and the time
// A registration is copied into a session (documents/<Name>_<pid>/) when they start on a phone or are linked by hand,
// so every session folder stays complete on its own. Contains personal data: never commit or publish this folder.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->\s*/g, '');
const PHOTO_FILES = { front:'photo.jpg', left:'photo-left.jpg', right:'photo-right.jpg' };
function decodePhotos(input) {
  const source=input.photos || {front:input.photo}, photos={};
  for(const angle of Object.keys(PHOTO_FILES)) {
    const value=source?.[angle];
    if(value==null || value==='')continue;
    if(typeof value!=='string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(value))throw Error('Please provide JPEG photos.');
    const bytes=Buffer.from(value.split(',')[1],'base64');
    if(bytes.length<2000 || bytes.length>3e6 || bytes[0]!==0xff || bytes[1]!==0xd8 || bytes.at(-2)!==0xff || bytes.at(-1)!==0xd9)throw Error('A photo is invalid or too large. Please take it again.');
    photos[angle]=bytes;
  }
  if(!photos.front)throw Error('Please take a front photo.');
  return photos;
}

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

  add({ name, email, face, signature, photo, photos, ip }) {
    const pid = 'p' + crypto.randomBytes(3).toString('hex');
    const now = new Date();
    const today = now.toDateString();
    const number = this.list.filter((x) => new Date(x.registered).toDateString() === today).length + 1;
    const { text, version } = this.consent();
    const d = path.join(this.dir, pid);
    fs.mkdirSync(d, { recursive: true });
    photos=photos || {front:photo};
    for(const [angle,file] of Object.entries(PHOTO_FILES))if(photos[angle])fs.writeFileSync(path.join(d,file),photos[angle]);
    fs.writeFileSync(path.join(d, 'consent.md'), `${text}\n\n---\n\n` +
      `**Agreed by:** ${name}  \n**Signed (typed name):** ${signature}  \n**Email:** ${email}  \n` +
      `**Confirmed 18 or over:** yes  \n**Face matching:** ${face ? 'YES — agreed' : 'no'}  \n` +
      `**When:** ${now.toISOString()} (${now.toString()})  \n**Consent version:** ${version}  \n**Registration:** ${pid}${ip ? `  \n**From:** ${ip}` : ''}\n`);
    const x = { pid, number, name, email, adult: true, face: !!face, signature, consentVersion: version, registered: now.toISOString(),
      photo: `participants/${pid}/photo.jpg`, photos:Object.fromEntries(Object.keys(PHOTO_FILES).filter(a=>photos[a]).map(a=>[a,`participants/${pid}/${PHOTO_FILES[a]}`])), consent: `participants/${pid}/consent.md`, sessions: [] };
    this.list.push(x); this.save();
    return x;
  }
  update(pid, d) {
    const x = this.get(pid); if (!x) return null;
    for (const k of ['name', 'email', 'notes']) if (typeof d[k] === 'string') x[k] = d[k].slice(0, k === 'notes' ? 4000 : 200);
    this.save(); return x;
  }
  // A better portrait added by the studio after registration (the registration photo is never replaced).
  // Keeps the original, writes a face-centred square crop as portrait.jpg; crop {x,y,size} nudges it.
  setPortrait(pid, bytes, by = '', crop = null) {
    const x = this.get(pid); if (!x) throw Error('No such person.');
    const d = path.join(this.dir, pid);
    if (bytes) {
      if (bytes.length < 2000 || bytes.length > 40e6) throw Error('That photo is empty or too large (up to 40 MB).');
      fs.writeFileSync(path.join(d, 'portrait-upload'), bytes);
      // any format the Mac can read (JPEG, PNG, HEIC…) becomes the kept original JPEG
      const r = spawnSync('sips', ['-s', 'format', 'jpeg', path.join(d, 'portrait-upload'), '--out', path.join(d, 'portrait-original.jpg')], { encoding: 'utf8' });
      fs.rmSync(path.join(d, 'portrait-upload'), { force: true });
      if (r.status !== 0) throw Error('That file is not a photo this computer can read.');
    } else if (!fs.existsSync(path.join(d, 'portrait-original.jpg'))) throw Error('Add a portrait first.');
    const py = fs.existsSync(path.join(this.root, '.faces-venv', 'bin', 'python')) ? path.join(this.root, '.faces-venv', 'bin', 'python') : 'python3';
    const args = [path.join(this.root, 'portrait_crop.py'), path.join(d, 'portrait-original.jpg'), path.join(d, 'portrait.jpg'), ...(crop ? [crop.x, crop.y, crop.size].map(String) : [])];
    const r = spawnSync(py, args, { encoding: 'utf8' });
    if (r.status !== 0) throw Error((r.stderr || '').trim().split('\n').pop() || 'Could not crop the portrait.');
    x.portrait = `participants/${pid}/portrait.jpg`;
    x.portraitInfo = { by, at: new Date().toISOString(), crop: JSON.parse(r.stdout.trim()) };
    this.save(); return x;
  }
  removePortrait(pid) {
    const x = this.get(pid); if (!x) return null;
    for (const f of ['portrait.jpg', 'portrait-original.jpg']) fs.rmSync(path.join(this.dir, pid, f), { force: true });
    delete x.portrait; delete x.portraitInfo; this.save(); return x;
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
    for (const [src, name] of [[x.photo, 'photo.jpg'], ...['left','right'].filter(a=>x.photos?.[a]).map(a=>[x.photos[a],PHOTO_FILES[a]]), ...(x.portrait ? [[x.portrait, 'portrait.jpg']] : []), [x.consent, 'consent (signed).md']]) {
      const to = path.join(sessionDir, rel, name);
      try { if (!fs.existsSync(to) || name === 'portrait.jpg') fs.copyFileSync(path.join(this.root, src), to); files.push({ file: path.join(rel, name), name, size: fs.statSync(to).size, added: new Date().toISOString() }); } catch {}
    }
    return { files, photo: path.join(rel, 'photo.jpg'), portrait: x.portrait ? path.join(rel, 'portrait.jpg') : null };
  }
}

module.exports = { Registry, decodePhotos };
