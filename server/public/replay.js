// Replay: watch a recorded session back with every camera, the sound and the transcript in step.
//
// Everything runs on the session clock (seconds from the start of the session). Each camera is a run of
// files, each with its own offset on that clock; the sound is one file with its own offset. The chosen
// sound drives the clock while it plays; the cameras follow it and are nudged back whenever they drift.
// Camera pictures use the catalogue's light 720p copies when they exist, and the originals otherwise.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clock = (t) => { t = Math.max(0, t || 0); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };

  function parseTranscript(text) {   // "[12.3] #1 AI: words" → lines, used when there is no catalogue
    const out = [];
    for (const l of String(text).split('\n')) {
      const m = l.match(/^\[(\d+(?:\.\d+)?)\]\s*(?:#\d+\s+)?([^:]{1,40}):\s*(.*)$/);
      if (m) out.push({ start: +m[1], end: null, speaker: m[2], who: /^AI\b/i.test(m[2]) ? 'ai' : /director|you\b/i.test(m[2]) ? 'director' : 'participant', text: m[3] });
    }
    for (let i = 0; i < out.length; i++) out[i].end = out[i].end ?? Math.min(out[i].start + 6, out[i + 1]?.start ?? Infinity);
    return out;
  }

  async function fetchText(url) { try { const r = await fetch(url); return r.ok ? await r.text() : ''; } catch { return ''; } }

  function mount(root, { name, session: s, catalogue, transcript, f }) {
    const start = Date.parse(s.start_iso), end = Date.parse(s.end_iso || '') || 0;
    const ready = catalogue && catalogue.state !== 'running' && catalogue.state !== 'failed';
    // Cameras: group the video files by camera.
    const cams = [];
    for (const v of s.video || []) {
      let c = cams.find((x) => x.name === v.name);
      if (!c) cams.push(c = { name: v.name, segs: [] });
      c.segs.push({ file: v.file, offset: +v.offset || 0, duration: +v.duration || 0, proxy: v.file.replace(/^video\//, 'catalogue/proxies/') });
    }
    // Sound: the conversation mix when the catalogue made one, then what each phone heard, their mics, the room and you.
    const sounds = [];
    for (const p of s.participants || []) {
      if (ready) sounds.push({ label: `Phone ${p.phone} conversation (them left, what they heard right)`, file: `catalogue/mixes/phone${p.phone}-conversation.wav`, offset: 0 });
      sounds.push({ label: `Phone ${p.phone}: what they heard`, file: `audio/phone${p.phone}-heard.wav`, offset: 0 });
      sounds.push({ label: `Phone ${p.phone}: their microphone`, file: `audio/phone${p.phone}-mic.wav`, offset: 0 });
    }
    for (const r of s.room_audio || []) sounds.push({ label: `Room: ${r.name}`, file: r.file, offset: +r.offset || 0 });
    sounds.push({ label: 'Your microphone', file: 'audio/director-mic.wav', offset: 0 });
    sounds.push({ label: 'No sound', file: '', offset: 0 });

    let duration = end ? (end - start) / 1000 : 0;
    for (const c of cams) for (const g of c.segs) duration = Math.max(duration, g.offset + g.duration);
    if (!duration && !cams.length) { root.innerHTML = ''; return { destroy() {} }; }

    root.innerHTML = `<section class="replay">
      <div class="rp-screens rp-n${Math.min(cams.length, 4)}">${cams.map((c, i) => `<figure data-i="${i}"><video muted playsinline preload="metadata"></video><figcaption>${esc(c.name)}</figcaption><div class="rp-none">No picture here</div></figure>`).join('') || '<div class="rp-nocam hint">No cameras were recording in this session.</div>'}</div>
      <div class="rp-bar">
        <button class="rp-play" aria-label="Play">▶</button>
        <span class="rp-time">0:00 / ${clock(duration)}</span>
        <div class="rp-track"><div class="rp-lanes"></div><input class="rp-seek" type="range" min="0" max="${duration}" step="0.1" value="0" aria-label="Position"></div>
      </div>
      <div class="rp-opts">
        <label>Sound <select class="rp-sound">${sounds.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join('')}</select></label>
        <label>Speed <select class="rp-rate"><option>0.5</option><option selected>1</option><option>1.5</option><option>2</option></select></label>
        <label>Picture <select class="rp-q"><option value="light">Light copies (720p)</option><option value="full">Originals</option></select></label>
        <label class="rp-follow"><input type="checkbox" checked> Follow transcript</label>
        <span class="hint rp-keys">Space plays · ← → 5 s · click a picture to enlarge it · click a line to jump there</span>
      </div>
      <ol class="rp-lines"><li class="hint">Loading the transcript…</li></ol>
      <audio class="rp-audio" preload="auto"></audio>
    </section>`;
    const q = (sel) => root.querySelector(sel);
    const audio = q('.rp-audio'), seek = q('.rp-seek'), playBtn = q('.rp-play');
    const videos = [...root.querySelectorAll('.rp-screens video')];
    let T = 0, playing = false, rate = 1, lastWall = 0, raf = 0, dead = false, sound = sounds[0], scrubbing = false, lines = [], curLine = -1;
    const quality = () => q('.rp-q').value;

    // Pick the sound file that exists: try in order, skipping any that fails to load.
    function setSound(i) {
      sound = sounds[i]; q('.rp-sound').value = i;
      audio.removeAttribute('src'); audio.load();
      if (sound.file) { audio.src = f(sound.file); audio.playbackRate = rate; }
      sync(true);
    }
    audio.addEventListener('error', () => {
      if (!sound.file || dead) return;
      const i = sounds.indexOf(sound);
      if (i < sounds.length - 1 && audio.currentTime === 0 && !playing) setSound(i + 1);
    });

    function segAt(c, t) { return c.segs.find((g) => t >= g.offset && t < g.offset + (g.duration || 1e9)); }
    function placeVideo(v, c, tight) {
      const g = segAt(c, T), fig = v.parentElement;
      fig.classList.toggle('empty', !g);
      if (!g) { if (!v.paused) v.pause(); return; }
      const want = quality() === 'light' && !v.dataset.noproxy ? g.proxy : g.file;
      if (v.dataset.file !== want) {
        v.dataset.file = want; v.dataset.orig = g.file; v.src = f(want); v.playbackRate = rate;
        v.onloadedmetadata = () => { v.currentTime = Math.max(0, T - g.offset); v.playbackRate = rate; if (playing) v.play().catch(() => {}); };
        v.onerror = () => { if (v.dataset.file !== v.dataset.orig) { v.dataset.noproxy = '1'; v.dataset.file = ''; placeVideo(v, c, true); } };
        return;
      }
      if (v.readyState < 1 || v.seeking) return;
      const at = T - g.offset;
      // While a picture is still buffering, don't keep chasing the clock: one correction every 1.5 s at most.
      if (Math.abs(v.currentTime - at) > (tight ? 0.08 : 0.35) && (tight || performance.now() - (v._fixedAt || 0) > 1500)) { v._fixedAt = performance.now(); v.currentTime = Math.max(0, at); }
      if (playing && v.paused) v.play().catch(() => {});
      if (!playing && !v.paused) v.pause();
    }
    function placeAudio(tight) {
      if (!sound.file) return;
      const at = T - sound.offset, inside = at >= 0 && (!audio.duration || at < audio.duration);
      if (!inside) { if (!audio.paused) audio.pause(); return; }
      if (audio.readyState >= 1 && !audio.seeking && Math.abs(audio.currentTime - at) > (tight ? 0.05 : 0.4)) audio.currentTime = at;
      if (playing && audio.paused) audio.play().catch(() => {});
      if (!playing && !audio.paused) audio.pause();
    }
    function sync(tight) {
      cams.forEach((c, i) => placeVideo(videos[i], c, tight));
      placeAudio(tight);
      if (!scrubbing) seek.value = T;
      q('.rp-time').textContent = `${clock(T)} / ${clock(duration)}`;
      showLine();
    }
    function tick() {
      if (dead) return;
      const now = performance.now();
      if (playing) {
        const at = audio.currentTime + sound.offset;
        // The sound is the clock while it is actually playing; otherwise the wall clock carries on.
        if (sound.file && !audio.paused && !audio.seeking && audio.readyState >= 3 && Math.abs(at - T) < 2) T = at;
        else T += ((now - lastWall) / 1000) * rate;
        if (T >= duration) { T = duration; setPlaying(false); }
        sync(false);
      }
      lastWall = now;
    }
    function setPlaying(on) {
      playing = on; playBtn.textContent = on ? '❚❚' : '▶'; playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
      if (on && T >= duration - 0.2) T = 0;
      lastWall = performance.now(); sync(true);
    }
    function jump(t) { T = Math.max(0, Math.min(duration, t)); sync(true); }

    playBtn.onclick = () => setPlaying(!playing);
    seek.oninput = () => { scrubbing = true; T = +seek.value; sync(true); };
    seek.onchange = () => { scrubbing = false; };
    q('.rp-sound').onchange = (e) => setSound(+e.target.value);
    q('.rp-rate').onchange = (e) => { rate = +e.target.value; audio.playbackRate = rate; videos.forEach((v) => (v.playbackRate = rate)); };
    q('.rp-q').onchange = () => { videos.forEach((v) => { v.dataset.file = ''; delete v.dataset.noproxy; }); sync(true); };
    root.querySelector('.rp-screens').onclick = (e) => {
      const fig = e.target.closest('figure'); if (!fig) return;
      const big = fig.classList.contains('big');
      root.querySelectorAll('.rp-screens figure').forEach((x) => x.classList.remove('big'));
      if (!big) fig.classList.add('big');
      root.querySelector('.rp-screens').classList.toggle('has-big', !big);
    };
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement !== seek) return;
      if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); jump(T - 5); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); jump(T + 5); }
    };
    document.addEventListener('keydown', onKey);

    // Transcript and markers.
    function showLine() {
      let i = -1;
      for (let k = 0; k < lines.length; k++) if (lines[k].start <= T + 0.05) i = k; else break;
      if (i === curLine) return;
      const ol = q('.rp-lines'), items = ol.children;
      items[curLine]?.classList.remove('now'); curLine = i; const el = items[i];
      if (!el) return;
      el.classList.add('now');
      if (q('.rp-follow input').checked && playing) ol.scrollTop = el.offsetTop - ol.offsetTop - ol.clientHeight / 3;
    }
    (async () => {
      const raw = ready ? await fetchText(f('catalogue/utterances.jsonl')) : '';
      if (raw) lines = raw.split('\n').filter(Boolean).map((l) => { try { const u = JSON.parse(l); return { start: u.start, end: u.end, who: u.who, speaker: u.speaker, text: u.text }; } catch { return null; } }).filter(Boolean);
      if (!lines.length) lines = parseTranscript(transcript);
      lines.sort((a, b) => a.start - b.start);
      const markers = (await fetchText(f('exports/markers.csv'))).split('\n').slice(1).map((l) => l.match(/^[^,]*,([\d.]+),"?(.*?)"?$/)).filter(Boolean).map((m) => ({ t: +m[1], text: m[2].replace(/""/g, '"') }));
      if (dead) return;
      q('.rp-lines').innerHTML = lines.map((l, i) => `<li data-i="${i}" class="w-${esc(l.who)}"><time>${clock(l.start)}</time><b>${esc(l.speaker)}</b> ${esc(l.text)}</li>`).join('') || '<li class="hint">No transcript for this session.</li>';
      q('.rp-lines').onclick = (e) => { const li = e.target.closest('li[data-i]'); if (li) jump(lines[+li.dataset.i].start - 0.3); };
      const pct = (t) => (100 * t / duration).toFixed(3) + '%';
      q('.rp-lanes').innerHTML = lines.map((l) => `<i class="w-${esc(l.who)}" style="left:${pct(l.start)};width:${pct(Math.max(0.5, (l.end || l.start + 2) - l.start))}"></i>`).join('')
        + markers.map((m) => `<b style="left:${pct(m.t)}" title="${esc(clock(m.t) + '  ' + m.text)}"></b>`).join('')
        + cams.map((c, k) => c.segs.map((g) => `<u class="c${k % 4}" style="left:${pct(g.offset)};width:${pct(g.duration)}"></u>`).join('')).join('');
      curLine = -1; showLine();
    })();

    // Start where the first picture begins, not on a black screen.
    T = cams.length ? Math.min(...cams.flatMap((c) => c.segs.map((g) => g.offset))) : 0;
    setSound(0);
    sync(true);
    raf = setInterval(tick, 60);   // a timer, not animation frames, so the sound and pictures stay together in a background tab
    return {
      destroy() {
        dead = true; clearInterval(raf); document.removeEventListener('keydown', onKey);
        audio.pause(); audio.removeAttribute('src'); audio.load();
        videos.forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
      },
    };
  }
  window.Replay = { mount, parseTranscript };
})();
