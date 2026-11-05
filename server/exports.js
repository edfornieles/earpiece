// Edit-ready exports for a finished session:
//   exports/<slot>.srt       subtitles per phone slot (participant, AI, director)
//   exports/markers.csv      every direction, note, interruption and dropout, as timecode
//   exports/timeline.fcpxml  one timeline with every audio track, room mic and camera clip already placed
//   exports/people/*.fcpxml  one timeline per participant visit, trimmed to it
// Opens in DaVinci Resolve (File → Import → Timeline) and Premiere (File → Import).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FPS = 25;
const tc = (sec) => {
  const f = Math.max(0, Math.round(sec * FPS));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(f / (3600 * FPS)))}:${p(Math.floor(f / (60 * FPS)) % 60)}:${p(Math.floor(f / FPS) % 60)}:${p(f % FPS)}`;
};
const srtTime = (sec) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const rt = (sec) => `${Math.max(0, Math.round(sec * FPS))}/${FPS}s`;   // FCPXML rational time
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function readEvents(dir) {
  try { return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function wavDuration(file) {
  try { const fd = fs.openSync(file, 'r'); const h = Buffer.alloc(44); fs.readSync(fd, h, 0, 44, 0); fs.closeSync(fd); return h.readUInt32LE(40) / h.readUInt32LE(28); } catch { return 0; }
}
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', file]);
  try { const s = JSON.parse(r.stdout.toString()).streams[0]; return { w: s.width, h: s.height }; } catch { return null; }
}

function exportSession(dir, videoClips = []) {
  const out = path.join(dir, 'exports');
  fs.mkdirSync(out, { recursive: true });
  const events = readEvents(dir);
  const session = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); } catch { return {}; } })();
  if (!videoClips.length && Array.isArray(session.video)) videoClips = session.video.map((c) => ({ ...c, file: path.isAbsolute(c.file) ? c.file : path.join(dir, c.file) }));
  const personName = {};   // the names as corrected in the control room / library
  try { for (const x of JSON.parse(fs.readFileSync(path.join(dir, 'people.json'), 'utf8'))) if (x.name) personName[x.pid] = x.name; } catch {}
  const names = {};   // slot -> current participant name, as the session went
  const lines = [];   // { slot, t, who, text }
  const markers = []; // { t, label }

  // when each AI-voiced line actually played on the phone
  const play = {};
  for (const e of events) {
    if (e.u == null) continue;
    const p = (play[e.u] = play[e.u] || {});
    if (e.type === 'play_start') p.start = Number(e.t);
    if (e.type === 'play_end' || (e.type === 'ai_cut' && e.played)) { p.end = Number(e.t); p.cut = e.type === 'ai_cut'; }
  }

  for (const e of events) {
    const t = Number(e.t);
    if (e.type === 'participant_start') { names[e.id] = (e.pid && personName[e.pid]) || e.name || `Participant ${e.id}`; markers.push({ t, label: `Phone ${e.id}: ${names[e.id]} starts` }); }
    if (e.type === 'participant_end') markers.push({ t, label: `Phone ${e.id}: ${(e.pid && personName[e.pid]) || e.name || ''} ends` });
    if (e.type === 'say') {
      const who = e.who === 'ai' ? 'AI' : e.who === 'typed' ? 'VOICE (typed)' : e.who === 'voiced' ? 'VOICE (spoken by director)' : e.who === 'director' ? 'DIRECTOR' : (names[e.id] || `PHONE ${e.id}`).toUpperCase();
      const p = e.u != null ? play[e.u] || {} : {};
      if (e.u != null && p.start == null) continue;   // never played (cut before it started)
      const start = e.start ?? p.start ?? t, end = e.end ?? p.end ?? null;
      lines.push({ slot: e.id, t: start, end, who, text: e.text + (p.cut ? ' —' : '') });
      if (['director', 'typed', 'voiced'].includes(e.who)) markers.push({ t, label: `${e.who === 'typed' ? 'Typed' : e.who === 'voiced' ? 'You (AI voice)' : 'You'} → ${e.id}: ${e.text}` });
    }
    if (e.type === 'instruct') markers.push({ t, label: `Note to AI (${e.id}): ${e.text}` });
    if (e.type === 'ai_cut') markers.push({ t, label: `AI cut off (${e.id}): ${e.why}` });
    if (['phone_hidden', 'phone_disconnected', 'camera_dropped', 'headset_lost', 'headset_connected'].includes(e.type)) markers.push({ t, label: `${e.type.replace('_', ' ')} ${e.id || e.name || ''}` });
    if (e.type === 'sync') markers.push({ t, label: 'SYNC' });
    if (e.type === 'mark') markers.push({ t, label: e.text || 'Mark' });
  }

  // subtitles, one file per phone slot
  const slots = [...new Set(lines.map((l) => l.slot))];
  for (const s of slots) {
    const ls = lines.filter((l) => l.slot === s).sort((a, b) => a.t - b.t);
    const srt = ls.map((l, i) => {
      const words = l.text.split(/\s+/).length;
      const end = l.end != null && l.end > l.t ? l.end : Math.min(ls[i + 1] ? ls[i + 1].t - 0.05 : Infinity, l.t + Math.max(1.5, words / 2.6));
      return `${i + 1}\n${srtTime(l.t)} --> ${srtTime(end)}\n${l.who}: ${l.text}\n`;
    }).join('\n');
    fs.writeFileSync(path.join(out, `phone${s}.srt`), srt);
  }

  // markers
  markers.sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(out, 'markers.csv'), 'timecode,seconds,marker\n' + markers.map((m) => `${tc(m.t)},${m.t.toFixed(2)},"${m.label.replace(/"/g, '""')}"`).join('\n') + '\n');

  // timeline
  const audioDir = path.join(dir, 'audio');
  const audio = fs.existsSync(audioDir) ? fs.readdirSync(audioDir).filter((f) => f.endsWith('.wav') && !f.startsWith('room-')).sort().map((f) => ({ file: path.join(audioDir, f), name: f.replace('.wav', ''), duration: wavDuration(path.join(audioDir, f)) })) : [];
  const clips = videoClips.filter((c) => c.duration > 0);
  const room = (session.room_audio || []).map((r) => ({ ...r, file: path.isAbsolute(r.file) ? r.file : path.join(dir, r.file) })).filter((r) => r.duration > 0 && fs.existsSync(r.file));
  const dims = clips.length ? probe(clips[0].file) : null;
  const W = dims?.w || 1920, H = dims?.h || 1080;
  const total = Math.max(1, ...audio.map((a) => a.duration), ...clips.map((c) => c.offset + c.duration), ...room.map((r) => r.offset + r.duration), ...markers.map((m) => m.t + 1));
  const url = (f) => 'file://' + encodeURI(f).replace(/#/g, '%23').replace(/\?/g, '%3F');

  // One FCPXML timeline for [a, b] on the session clock. Every source is trimmed to that window, so a
  // participant's timeline starts at the moment they began and holds only what was rolling then.
  const camLanes = [...new Set(clips.map((c) => c.cam))];
  function timeline(title, a, b, keepAudio = () => true) {
    let id = 2;
    const assets = [], placed = [];
    const place = (src, offset, duration, lane, attrs, extra = '') => {
      const s0 = Math.max(a, offset), s1 = Math.min(b, offset + duration);
      if (s1 - s0 < 0.1) return;
      const r = 'r' + id++;
      assets.push(`<asset id="${r}" name="${esc(path.basename(src))}" start="0s" duration="${rt(duration)}" ${attrs}><media-rep kind="original-media" src="${esc(url(src))}"/></asset>`);
      placed.push(`<asset-clip ref="${r}" lane="${lane}" offset="${rt(s0 - a)}" name="${esc(extra || path.basename(src))}" start="${rt(s0 - offset)}" duration="${rt(s1 - s0)}"${lane < 0 ? ` audioRole="${lane > -100 ? 'dialogue' : 'effects'}"` : ''}/>`);
    };
    audio.filter(keepAudio).forEach((x, i) => place(x.file, 0, x.duration, -(i + 1), 'hasAudio="1" audioSources="1" audioChannels="1" audioRate="24000"', x.name));
    room.forEach((x, i) => place(x.file, x.offset, x.duration, -(100 + i), 'hasAudio="1" audioSources="1" audioChannels="1" audioRate="48000"', x.name || path.basename(x.file, '.wav')));
    clips.forEach((c) => place(c.file, c.offset, c.duration, camLanes.indexOf(c.cam) + 1, 'hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="1" audioRate="48000"'));
    // lanes must be consecutive for some editors: renumber audio lanes -1, -2, …
    const audioLanes = [...new Set(placed.map((x) => Number(x.match(/lane="(-?\d+)"/)[1])).filter((l) => l < 0))].sort((x, y) => y - x);
    const fixed = placed.map((x) => x.replace(/lane="(-\d+)"/, (m, l) => `lane="-${audioLanes.indexOf(Number(l)) + 1}"`));
    const len = b - a;
    const mk = markers.filter((m) => m.t >= a && m.t <= b).map((m) => `<marker start="${rt(m.t - a)}" duration="1/${FPS}s" value="${esc(m.label.slice(0, 200))}"/>`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="FFVideoFormat${H}p${FPS}" frameDuration="1/${FPS}s" width="${W}" height="${H}"/>
    ${assets.join('\n    ')}
  </resources>
  <library>
    <event name="${esc('Earpiece ' + path.basename(dir))}">
      <project name="${esc(title)}">
        <sequence format="r1" duration="${rt(len)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <gap name="${esc(title)}" offset="0s" start="0s" duration="${rt(len)}">
              ${fixed.join('\n              ')}
              ${mk.join('\n              ')}
            </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
  }
  const sessionTitle = session.title ? `${session.title} (${path.basename(dir)})` : `Earpiece ${path.basename(dir)}`;
  fs.writeFileSync(path.join(out, 'timeline.fcpxml'), timeline(sessionTitle, 0, total));

  // one timeline per participant visit: their phone's audio, your mic, room mics and every camera
  const pdir = path.join(out, 'people');
  fs.rmSync(pdir, { recursive: true, force: true });
  const visits = (session.participants || []).filter((v) => v.start != null);
  if (visits.length) fs.mkdirSync(pdir, { recursive: true });
  const perPerson = [];
  visits.forEach((v, i) => {
    const nm = (v.pid && personName[v.pid]) || v.name || `Phone ${v.phone}`;
    const a = Math.max(0, v.start - 5), b = Math.min(total, (v.end ?? total) + 3);
    const file = `${String(i + 1).padStart(2, '0')} ${nm.replace(/[^\w\- ]+/g, '').trim() || 'participant'} (phone ${v.phone}).fcpxml`;
    fs.writeFileSync(path.join(pdir, file), timeline(`${nm} — phone ${v.phone}`, a, b, (x) => x.name === 'director-mic' || x.name.startsWith(`phone${v.phone}-`)));
    perPerson.push({ name: nm, phone: v.phone, file: 'exports/people/' + file, from: a, to: b });
  });

  // index for the library
  session.exports = { people: perPerson, at: new Date().toISOString(), subtitles: slots.map((s) => `phone${s}.srt`), markers: markers.length, video: clips.map((c) => path.relative(dir, c.file)), audio: audio.map((a) => path.relative(dir, a.file)), room: room.map((r) => path.relative(dir, r.file)), duration: total };
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session, null, 2));
  return session.exports;
}

module.exports = { exportSession, tc };
