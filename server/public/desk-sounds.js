// Live desk: Sounds. Upload audio tracks, then play them (or the beep) to every phone or chosen phones,
// once or on a loop, and stop them. The server keeps what is playing where; this panel polls it.
(() => {
  const root = document.getElementById('soundpad'); if (!root) return;
  const K = new URLSearchParams(location.search).get('k');
  const url = (p) => p + (K ? (p.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(K) : '');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const len = (s) => !s ? '' : s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
  const say = (t) => { const el = document.getElementById('toast'); if (!el) return alert(t); el.textContent = t; el.style.display = 'block'; clearTimeout(say.t); say.t = setTimeout(() => (el.style.display = 'none'), 3500); };
  const post = async (p, body) => {
    const r = await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw Error(j.error || 'Failed (' + r.status + ')');
    return j;
  };

  const style = document.createElement('style');
  style.textContent = `
    .soundpad { border-top:1px solid var(--line); margin-top:10px; padding-top:10px; display:flex; flex-direction:column; gap:8px; }
    .sp-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .sp-head .cs-label { margin-right:4px; }
    .sp-to { display:flex; gap:4px; flex-wrap:wrap; align-items:center; }
    .sp-to button, .sp-head > button, .sp-row button { padding:5px 10px; font-size:12px; }
    .sp-to button.on { background:var(--fg); color:#111; border-color:var(--fg); }
    .sp-loop { display:flex; align-items:center; gap:5px; font-size:12px; color:var(--dim); cursor:pointer; }
    .sp-loop input { width:auto; margin:0; }
    .sp-spacer { flex:1; }
    .sp-list { display:flex; flex-direction:column; gap:4px; max-height:220px; overflow-y:auto; }
    .sp-row { display:flex; align-items:center; gap:8px; padding:4px 6px; border:1px solid var(--line); border-radius:8px; font-size:13px; }
    .sp-row.live { border-color:var(--ok); }
    .sp-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sp-name small { color:var(--dim); margin-left:6px; }
    .sp-now { font-size:11px; color:var(--ok); white-space:nowrap; }
    .sp-row .sp-play { min-width:34px; }
    .sp-row .sp-del { color:var(--dim); background:transparent; border-color:transparent; }
    .sp-row .sp-del:hover { color:var(--hot); }
    .sp-busy { font-size:12px; color:var(--dim); }
    .sp-to button.sp-room { border-style:dashed; }
    .sp-to button.sp-room.on { border-style:solid; }
    .sp-to button.sp-room.off { opacity:.45; }
    .sp-say { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
    .sp-say .cs-label { white-space:nowrap; }
    .sp-say input { flex:1; min-width:160px; margin:0; padding:5px 8px; font-size:13px; }
    .sp-say select { width:auto; margin:0; padding:4px 6px; font-size:12px; }
    .sp-say button { padding:5px 10px; font-size:12px; }
    .sp-saying { font-size:11px; color:var(--ok); flex-basis:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }`;
  document.head.appendChild(style);

  root.innerHTML = `
    <div class="sp-head">
      <span class="cs-label">Sounds</span>
      <span class="sp-to" id="sp-to" title="Who hears it"></span>
      <label class="sp-loop" title="Play over and over until stopped"><input type="checkbox" id="sp-loop"> Loop</label>
      <button id="sp-beep" title="Beep to the chosen phones">Beep</button>
      <span class="sp-spacer"></span>
      <span class="sp-busy" id="sp-busy"></span>
      <button id="sp-stopall" title="Stop every sound on every phone">Stop all</button>
      <button id="sp-add" title="Upload audio files (MP3, WAV, M4A…)">+ Upload</button>
      <input type="file" id="sp-file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.aif,.aiff" multiple hidden>
    </div>
    <div class="sp-list" id="sp-list"></div>
    <div class="sp-say" title="The computer's own output: the amp on the headphone socket">
      <span class="cs-label">Room speaker</span>
      <input id="sp-text" placeholder="Type a line for the room speaker, then Enter" maxlength="2000">
      <select id="sp-voice" title="Voice"></select>
      <button id="sp-say">Say</button>
      <button id="sp-hush" title="Stop whatever the room speaker is playing">■ Stop</button>
      <span class="sp-saying" id="sp-saying"></span>
    </div>`;
  const $ = (id) => root.querySelector('#' + id);

  let list = [], playing = [], phones = [], chosen = 'all';   // 'all' or a Set of phone numbers and/or 'room'
  let speaker = null;   // the room speaker: { device, available, playing, voices }
  const targets = () => chosen === 'all' ? 'all' : [...chosen];
  const nobody = () => chosen !== 'all' && !chosen.size;

  function renderTo() {
    const html = `<button data-p="all" class="${chosen === 'all' ? 'on' : ''}" title="Every connected phone">All</button>` +
      phones.map((n) => `<button data-p="${n}" class="${chosen !== 'all' && chosen.has(n) ? 'on' : ''}" title="Phone ${n}">${n}</button>`).join('') +
      `<button data-p="room" class="sp-room${chosen !== 'all' && chosen.has('room') ? ' on' : ''}${speaker && !speaker.available ? ' off' : ''}" title="${speaker && !speaker.available ? 'Room speaker not connected (' + esc(speaker.device) + ')' : 'The room speaker: the amp on this computer\'s headphone socket'}">Room</button>`;
    if ($('sp-to').innerHTML !== html) $('sp-to').innerHTML = html;
  }
  function render() {
    renderTo();
    const files = list.filter((x) => !x.builtIn);
    $('sp-list').innerHTML = files.map((x) => {
      const on = playing.filter((p) => p.id === x.id);
      return `<div class="sp-row${on.length ? ' live' : ''}" data-id="${esc(x.id)}">
        <button class="sp-play" title="Play to the chosen phones">▶</button>
        <span class="sp-name">${esc(x.name)}<small>${len(x.duration)}</small></span>
        ${on.length ? `<span class="sp-now">${on.some((p) => p.loop) ? '↻ ' : ''}on ${on.map((p) => p.phone).join(', ')}</span><button class="sp-stop" title="Stop this sound">■ Stop</button>` : ''}
        <button class="sp-del" title="Delete this sound">✕</button></div>`;
    }).join('') || '<span class="hint">No sounds yet. Upload an audio file to play it into participants\' ears.</span>';
    const beeping = playing.filter((p) => p.id === 'beep');
    $('sp-beep').textContent = beeping.length ? `Beep ${beeping.some((p) => p.loop) ? '↻ ' : ''}on ${beeping.map((p) => p.phone).join(', ')} · stop` : 'Beep';
    $('sp-stopall').disabled = !playing.length && !speaker?.playing;
    const sp = speaker?.playing;
    $('sp-saying').textContent = sp ? (sp.kind === 'say' ? 'Saying: “' + sp.label + '”' : sp.kind === 'live' ? 'Live: your voice' : 'Playing: ' + sp.label + (sp.loop ? ' ↻' : '')) : '';
    $('sp-hush').disabled = !sp;
    if (speaker?.voices && !$('sp-voice').options.length) { $('sp-voice').innerHTML = speaker.voices.map((v) => `<option>${esc(v)}</option>`).join(''); $('sp-voice').value = speaker.voice || speaker.voices[0]; }
  }
  async function refresh() {
    try {
      const [s, st, sp] = await Promise.all([fetch(url('/api/sounds')).then((r) => r.json()), fetch(url('/api/status')).then((r) => r.json()), fetch(url('/api/speaker')).then((r) => r.json()).catch(() => null)]);
      speaker = sp && !sp.error ? sp : null;
      list = s.list || []; playing = s.playing || []; phones = (st.phonesConnected || []).map(Number).sort((a, b) => a - b);
      if (chosen !== 'all') for (const n of [...chosen]) if (n !== 'room' && !phones.includes(n)) chosen.delete(n);
      render();
    } catch {}
  }

  $('sp-to').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.p === 'all') chosen = 'all';
    else {
      const n = b.dataset.p === 'room' ? 'room' : Number(b.dataset.p);
      if (chosen === 'all') chosen = new Set([n]); else if (chosen.has(n)) chosen.delete(n); else chosen.add(n);
      if (chosen !== 'all' && !chosen.size) chosen = 'all';
    }
    render();
  };
  async function play(id) {
    if (nobody()) return say('Choose who hears it.');
    try { await post('/api/sound', { op: 'play', sound: id, targets: targets(), loop: $('sp-loop').checked }); refresh(); } catch (e) { say(e.message); }
  }
  async function stop(id) { try { await post('/api/sound', { op: 'stop', sound: id || '' }); if (!id) await post('/api/speaker', { op: 'stop' }); refresh(); } catch (e) { say(e.message); } }
  async function speak() {
    const text = $('sp-text').value.trim(); if (!text) return $('sp-text').focus();
    try { await post('/api/speaker', { op: 'say', text, voice: $('sp-voice').value }); $('sp-text').value = ''; refresh(); } catch (e) { say(e.message); }
  }
  $('sp-say').onclick = speak;
  $('sp-voice').onchange = async () => { try { await post('/api/speaker', { op: 'voice', voice: $('sp-voice').value }); } catch (e) { say(e.message); } };   // the room speakers' AI voice, for talk and typed lines too
  $('sp-text').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); speak(); } e.stopPropagation(); };
  $('sp-hush').onclick = async () => { try { await post('/api/speaker', { op: 'stop' }); refresh(); } catch (e) { say(e.message); } };
  $('sp-beep').onclick = () => playing.some((p) => p.id === 'beep') ? stop('beep') : play('beep');
  $('sp-stopall').onclick = () => stop('');
  $('sp-list').onclick = async (e) => {
    const row = e.target.closest('.sp-row'); if (!row) return;
    const id = row.dataset.id, name = list.find((x) => x.id === id)?.name || id;
    if (e.target.closest('.sp-play')) play(id);
    if (e.target.closest('.sp-stop')) stop(id);
    if (e.target.closest('.sp-del') && confirm(`Delete “${name}”? It stops wherever it is playing.`)) {
      try { await post('/api/sounds-delete', { id }); refresh(); } catch (err) { say(err.message); }
    }
  };
  $('sp-add').onclick = () => $('sp-file').click();
  $('sp-file').onchange = async () => {
    const files = [...$('sp-file').files]; $('sp-file').value = '';
    for (const [i, f] of files.entries()) {
      $('sp-busy').textContent = `Uploading ${files.length > 1 ? `${i + 1} of ${files.length}: ` : ''}${f.name}…`;
      try {
        const r = await fetch(url('/api/sounds?name=' + encodeURIComponent(f.name)), { method: 'POST', body: f });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw Error(j.error || 'Upload failed');
      } catch (e) { say(`${f.name}: ${e.message}`); }
    }
    $('sp-busy').textContent = '';
    refresh();
  };
  refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 2000);
})();
