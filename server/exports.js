// Edit-ready exports for a finished session:
//   exports/<slot>.srt       subtitles per phone slot (participant, AI, director)
//   exports/markers.csv      every direction, note, interruption and dropout, as timecode
//   exports/timeline.fcpxml  one timeline with every audio track and camera clip already placed
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
  const names = {};   // slot -> current participant name, as the session went
  const lines = [];   // { slot, t, who, text }
  const markers = []; // { t, label }

  for (const e of events) {
    const t = Number(e.t);
    if (e.type === 'participant_start') { names[e.id] = e.name || `Participant ${e.id}`; markers.push({ t, label: `Phone ${e.id}: ${names[e.id]} starts` }); }
    if (e.type === 'participant_end') markers.push({ t, label: `Phone ${e.id}: ${e.name || ''} ends` });
    if (e.type === 'say') {
      const who = e.who === 'ai' ? 'AI' : e.who === 'typed' ? 'VOICE (typed)' : e.who === 'voiced' ? 'VOICE (spoken by director)' : e.who === 'director' ? 'DIRECTOR' : (names[e.id] || `PHONE ${e.id}`).toUpperCase();
      lines.push({ slot: e.id, t, who, text: e.text });
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
    const ls = lines.filter((l) => l.slot === s);
    const srt = ls.map((l, i) => {
      const words = l.text.split(/\s+/).length;
      const end = Math.min(ls[i + 1] ? ls[i + 1].t - 0.05 : Infinity, l.t + Math.max(1.5, words / 2.6));
      return `${i + 1}\n${srtTime(l.t)} --> ${srtTime(end)}\n${l.who}: ${l.text}\n`;
    }).join('\n');
    fs.writeFileSync(path.join(out, `phone${s}.srt`), srt);
  }

  // markers
  markers.sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(out, 'markers.csv'), 'timecode,seconds,marker\n' + markers.map((m) => `${tc(m.t)},${m.t.toFixed(2)},"${m.label.replace(/"/g, '""')}"`).join('\n') + '\n');

  // timeline
  const audioDir = path.join(dir, 'audio');
  const audio = fs.existsSync(audioDir) ? fs.readdirSync(audioDir).filter((f) => f.endsWith('.wav')).sort().map((f) => ({ file: path.join(audioDir, f), name: f.replace('.wav', ''), duration: wavDuration(path.join(audioDir, f)) })) : [];
  const clips = videoClips.filter((c) => c.duration > 0);
  const dims = clips.length ? probe(clips[0].file) : null;
  const W = dims?.w || 1920, H = dims?.h || 1080;
  const total = Math.max(1, ...audio.map((a) => a.duration), ...clips.map((c) => c.offset + c.duration), ...markers.map((m) => m.t + 1));
  const url = (f) => 'file://' + encodeURI(f).replace(/#/g, '%23').replace(/\?/g, '%3F');

  let id = 2;
  const assets = [], placed = [];
  audio.forEach((a, i) => {
    const r = 'r' + id++;
    assets.push(`<asset id="${r}" name="${esc(a.name)}" start="0s" duration="${rt(a.duration)}" hasAudio="1" audioSources="1" audioChannels="1" audioRate="24000"><media-rep kind="original-media" src="${esc(url(a.file))}"/></asset>`);
    placed.push(`<asset-clip ref="${r}" lane="-${i + 1}" offset="0s" name="${esc(a.name)}" start="0s" duration="${rt(a.duration)}" audioRole="dialogue"/>`);
  });
  const camLanes = [...new Set(clips.map((c) => c.cam))];
  clips.forEach((c) => {
    const r = 'r' + id++;
    const name = path.basename(c.file);
    assets.push(`<asset id="${r}" name="${esc(name)}" start="0s" duration="${rt(c.duration)}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="1" audioRate="48000"><media-rep kind="original-media" src="${esc(url(c.file))}"/></asset>`);
    placed.push(`<asset-clip ref="${r}" lane="${camLanes.indexOf(c.cam) + 1}" offset="${rt(c.offset)}" name="${esc(name)}" start="0s" duration="${rt(c.duration)}"/>`);
  });
  const mk = markers.map((m) => `<marker start="${rt(m.t)}" duration="1/${FPS}s" value="${esc(m.label.slice(0, 200))}"/>`);
  const title = `Earpiece ${path.basename(dir)}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="FFVideoFormat${H}p${FPS}" frameDuration="1/${FPS}s" width="${W}" height="${H}"/>
    ${assets.join('\n    ')}
  </resources>
  <library>
    <event name="${esc(title)}">
      <project name="${esc(title)}">
        <sequence format="r1" duration="${rt(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <gap name="Session" offset="0s" start="0s" duration="${rt(total)}">
              ${placed.join('\n              ')}
              ${mk.join('\n              ')}
            </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
  fs.writeFileSync(path.join(out, 'timeline.fcpxml'), xml);

  // index for the library
  session.exports = { at: new Date().toISOString(), subtitles: slots.map((s) => `phone${s}.srt`), markers: markers.length, video: clips.map((c) => path.relative(dir, c.file)), audio: audio.map((a) => path.relative(dir, a.file)), duration: total };
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session, null, 2));
  return session.exports;
}

module.exports = { exportSession, tc };
