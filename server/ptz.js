// Pan/tilt control for an ONVIF camera (the Tapo answers on port 2020), using the same camera
// account as its video stream. The Tapo's gears have slack: a preset reached from the right or from
// below stops ~100 px (4K) short. Reached from the left and from above it lands within a few pixels,
// so every move to a position first goes to a point just left of and above it.
const crypto = require('crypto');
const http = require('http');

const APPROACH = { x: -0.05, y: 0.05 }, STILL_MS = 350, MOVE_TIMEOUT_MS = 12000;
const NS = 'xmlns="http://www.onvif.org/ver20/ptz/wsdl"';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The point a move should pass through before settling on a target, from the side that lands exactly.
function approachPoint([x, y]) {
  const c = (v) => Math.max(-1, Math.min(1, v));
  return [c(x + APPROACH.x), c(y + APPROACH.y)];
}
const parsePos = (xml) => { const m = /PanTilt[^>]*?x="([-\d.]+)"[^>]*?y\s*="([-\d.]+)"/.exec(xml); return m ? [Number(m[1]), Number(m[2])] : null; };
function parsePresets(xml) {
  return [...xml.matchAll(/Preset[^>]*token="([^"]+)"[^>]*>([\s\S]*?)<\/[\w:]*Preset>/g)].map((m) => ({ token: m[1], name: (/Name>([^<]*)</.exec(m[2]) || [])[1] || '', pos: parsePos(m[2]) }));
}

class Ptz {
  // url: the camera's rtsp:// main stream (user:password@host). request: injectable for tests.
  constructor(url, { port = 2020, request = null } = {}) {
    const u = new URL(url);
    this.host = u.hostname; this.port = port;
    this.user = decodeURIComponent(u.username); this.pass = decodeURIComponent(u.password);
    this.request = request || ((xml) => this.post(xml));
    this.token = null; this.queue = Promise.resolve();
  }
  header() {
    const nonce = crypto.randomBytes(16), created = new Date().toISOString();
    const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(this.pass)])).digest('base64');
    return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${esc(this.user)}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`;
  }
  post(xml) {
    return new Promise((res, rej) => {
      const r = http.request({ host: this.host, port: this.port, path: '/onvif/service', method: 'POST', timeout: 6000, headers: { 'content-type': 'application/soap+xml; charset=utf-8', 'content-length': Buffer.byteLength(xml) } }, (x) => {
        let d = ''; x.on('data', (c) => (d += c));
        x.on('end', () => {
          if (x.statusCode < 400 && !/Fault>/.test(d)) return res(d);
          const why = (/Reason>[\s\S]*?>([^<]+)</.exec(d) || /Subcode>[\s\S]*?Value>([^<]+)</.exec(d) || [])[1] || `HTTP ${x.statusCode}`;
          rej(Error('Camera refused the command: ' + why.trim()));
        });
      });
      r.on('error', (e) => rej(Error('Camera control is unreachable: ' + e.message)));
      r.on('timeout', () => r.destroy(Error('timeout')));
      r.end(xml);
    });
  }
  // One command at a time: the Tapo rejects overlapping requests.
  soap(body) {
    const run = () => this.request(`<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema">${this.header()}<s:Body>${body}</s:Body></s:Envelope>`);
    const p = this.queue.then(run, run); this.queue = p.catch(() => {}); return p;
  }
  async profile() {
    if (!this.token) { const d = await this.soap('<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>'); this.token = (/Profiles[^>]*token="([^"]+)"/.exec(d) || [])[1]; if (!this.token) throw Error('The camera has no video profile.'); }
    return this.token;
  }
  async position() { const t = await this.profile(); return parsePos(await this.soap(`<GetStatus ${NS}><ProfileToken>${t}</ProfileToken></GetStatus>`)); }
  async presets() { const t = await this.profile(); return parsePresets(await this.soap(`<GetPresets ${NS}><ProfileToken>${t}</ProfileToken></GetPresets>`)); }
  async savePreset(name) {
    const t = await this.profile();
    const d = await this.soap(`<SetPreset ${NS}><ProfileToken>${t}</ProfileToken><PresetName>${esc(name.slice(0, 30))}</PresetName></SetPreset>`);
    const token = (/PresetToken>([^<]+)</.exec(d) || [])[1]; if (!token) throw Error('The camera did not save the position.');
    return token;
  }
  async removePreset(token) { const t = await this.profile(); await this.soap(`<RemovePreset ${NS}><ProfileToken>${t}</ProfileToken><PresetToken>${esc(token)}</PresetToken></RemovePreset>`); }
  async relative(dx, dy) {
    const t = await this.profile();
    await this.soap(`<RelativeMove ${NS}><ProfileToken>${t}</ProfileToken><Translation><tt:PanTilt x="${dx.toFixed(5)}" y="${dy.toFixed(5)}"/></Translation></RelativeMove>`);
  }
  // Wait until the motor stops (the Tapo does not report move status, so watch the position).
  async settle(nap = sleep) {
    let last = null, sameSince = 0; const t0 = Date.now();
    while (Date.now() - t0 < MOVE_TIMEOUT_MS) {
      await nap(200);
      const p = await this.position();
      if (last && p && Math.abs(p[0] - last[0]) < 1e-4 && Math.abs(p[1] - last[1]) < 1e-4) { if (Date.now() - sameSince >= STILL_MS) return p; }
      else sameSince = Date.now();
      last = p;
    }
    return last;
  }
  async nudge(dx, dy, nap) { await this.relative(dx, dy); return this.settle(nap); }
  // Go to a saved preset, always arriving from the left and from above.
  async goto(token, nap) {
    const t = await this.profile(), list = await this.presets(), preset = list.find((p) => p.token === token);
    if (!preset) throw Error('That position is no longer saved on the camera.');
    if (preset.pos) {
      const cur = await this.position(), via = approachPoint(preset.pos);
      if (cur) { await this.relative(via[0] - cur[0], via[1] - cur[1]); await this.settle(nap); }
    }
    await this.soap(`<GotoPreset ${NS}><ProfileToken>${t}</ProfileToken><PresetToken>${esc(token)}</PresetToken></GotoPreset>`);
    return this.settle(nap);
  }
}
module.exports = { Ptz, approachPoint, parsePresets, parsePos };
