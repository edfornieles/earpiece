// Who may use Mother from outside the studio, and privacy mode.
//
// Everything arriving through the Cloudflare tunnel carries a cf-connecting-ip header; anything without it
// came from this Mac or the studio network and is trusted as before (link keys).
//
// Directors log in with an emailed code through Cloudflare Access on the director address
// (mother.edfornieles.com). Cloudflare then sends a signed token (Cf-Access-Jwt-Assertion). Mother checks
// its signature against Cloudflare's published keys, its audience and its expiry, and only then believes the
// email inside. A plain email header is never trusted: it could be sent by anyone to the other address.
//
// Privacy mode shuts out everyone outside the studio: open connections are closed and nothing new gets in.
// It can only be switched from the studio, and it survives a restart.
//
// Settings live in .access.json (not in git):
//   { "users": [{ "email": "...", "name": "..." }], "requireLogin": false, "privacy": false,
//     "teamDomain": "yourteam.cloudflareaccess.com", "aud": "<application audience tag>" }
const fs = require('fs');
const crypto = require('crypto');

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

class Access {
  constructor(file, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.file = file; this.fetch = fetchImpl; this.now = now;
    this.cfg = { users: [], requireLogin: false, privacy: false, teamDomain: '', aud: '' };
    try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
    this.cfg.users = (this.cfg.users || []).map((u) => ({ email: String(u.email || '').trim().toLowerCase(), name: String(u.name || u.email || '').trim() })).filter((u) => u.email);
    this.keys = new Map(); this.keysAt = 0;
    this.onPrivacy = null;
  }
  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2)); fs.renameSync(tmp, this.file); }
  get privacy() { return !!this.cfg.privacy; }
  get configured() { return !!(this.cfg.teamDomain && this.cfg.aud); }
  setPrivacy(on) {
    this.cfg.privacy = !!on; this.save();
    this.onPrivacy?.(this.cfg.privacy);
  }
  // Cloudflare's signing keys for this team, refreshed hourly (and on an unknown key id).
  async refreshKeys() {
    if (!this.configured || !this.fetch) return;
    const r = await this.fetch(`https://${this.cfg.teamDomain}/cdn-cgi/access/certs`);
    if (!r.ok) throw Error('Cloudflare Access keys: ' + r.status);
    const { keys = [] } = await r.json();
    this.keys = new Map(keys.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
    this.keysAt = this.now();
  }
  start() {
    const go = () => this.refreshKeys().catch((e) => console.log('  ! ' + e.message));
    go(); setInterval(go, 3600e3).unref?.();
  }
  // The verified email in a Cloudflare Access token, or ''.
  verify(token) {
    if (!token || !this.configured) return '';
    const parts = String(token).split('.'); if (parts.length !== 3) return '';
    let head, body;
    try { head = JSON.parse(b64url(parts[0])); body = JSON.parse(b64url(parts[1])); } catch { return ''; }
    if (head.alg !== 'RS256') return '';
    const key = this.keys.get(head.kid);
    if (!key) { if (this.now() - this.keysAt > 60e3) this.refreshKeys().catch(() => {}); return ''; }
    if (!crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, b64url(parts[2]))) return '';
    const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
    const t = this.now() / 1000;
    if (!aud.includes(this.cfg.aud) || !(body.exp > t) || (body.nbf && body.nbf > t + 60)) return '';
    if (body.iss && body.iss !== `https://${this.cfg.teamDomain}`) return '';
    return String(body.email || '').toLowerCase();
  }
  // What this request may do. remote: it came through the tunnel. director: a logged-in, listed person.
  // needsLogin: remote, not logged in, and link keys no longer count for the desk.
  check(req) {
    const remote = !!req.headers['cf-connecting-ip'];
    if (!remote) return { remote: false };
    if (this.privacy) return { remote, blocked: 'private' };
    const email = this.verify(req.headers['cf-access-jwt-assertion']);
    if (email) {
      const user = this.cfg.users.find((u) => u.email === email);
      if (!user) return { remote, blocked: 'not-listed', email };
      return { remote, director: true, email, name: user.name };
    }
    return { remote, needsLogin: !!this.cfg.requireLogin };
  }
  page(why, email = '') {
    const msg = why === 'private' ? 'Mother is private right now. Please try again later.'
      : `${email ? String(email).replace(/[&<>"']/g, '') + ' is' : 'You are'} not on the list of people who can use Mother. Ask Ed to add you.`;
    return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mother</title>
<body style="font:16px system-ui;background:#0e0e0e;color:#e8e6e1;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px"><p>${msg}</p></body>`;
  }
  view() { return { privacy: this.privacy, requireLogin: !!this.cfg.requireLogin, configured: this.configured, users: this.cfg.users }; }
}

module.exports = { Access };
