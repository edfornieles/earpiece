// The live desk's camera bar: the turning camera's picture, its saved positions, nudges and follow,
// right under the talk buttons so the director can move the camera while speaking.
// Keys: Shift + arrows nudge, Shift + 1–9 go to a saved position. The server does the moving (as on
// the Room page); this only asks and shows.
(() => {
  const key = new URLSearchParams(location.search).get('k') || '';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const strip = $('camstrip'); if (!strip) return;
  const say = (t) => (window.toast ? window.toast(t) : console.log(t));
  const STEP = { small: 0.02, large: 0.08 };
  let status = {}, camId = '', acting = false, step = 'small', shownCam = '';

  async function api(body) {
    const r = await fetch('/api/room?k=' + encodeURIComponent(key), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {}
    if (!r.ok) throw Error(data?.error || text || 'The camera did not answer.');
    return data;
  }
  async function refresh() {
    try { const v = await api({ action: 'trackingView' }); status = v.cameraControl || {}; draw(v.cameraId); } catch {}
  }
  setInterval(() => { if (!document.hidden && !acting) refresh(); }, 1500);

  function draw(trackingCam) {
    const ids = Object.keys(status);
    camId = ids.includes(camId) ? camId : ids.includes(trackingCam) ? trackingCam : ids[0] || '';
    strip.hidden = !camId; if (!camId) return;
    const s = status[camId], img = $('cs-cam');
    if (shownCam !== camId) { shownCam = camId; img.src = `/cam/${encodeURIComponent(camId)}.mjpg?k=${encodeURIComponent(key)}`; }
    const busy = !!s.busy || !!s.sweep?.running || s.available === false || acting;
    const active = s.active?.viewId;
    $('cs-camstate').textContent = s.available === false ? 'motor not reachable'
      : s.busy ? s.busy + '…' : s.error ? s.error
      : active ? 'at ' + (s.views.find((v) => v.id === active)?.name || 'a saved position')
      : s.active ? 'aimed by hand: people are placed on the map again once it is back on a calibrated position' : 'not moved since start';
    const views = s.views.map((v, i) => `<button class="cs-view${v.id === active ? ' here' : ''}" data-id="${esc(v.id)}" title="Shift+${i + 1}${v.calibrated ? '' : ' · not calibrated: people are not placed from here'}">${esc(v.name)}${v.calibrated ? '' : ' <i>·</i>'}<kbd>⇧${i + 1}</kbd></button>`).join('');
    const box = $('cs-views'); if (box.dataset.html !== views) { box.innerHTML = views || '<span class="hint">No saved positions yet (save them on the Room page).</span>'; box.dataset.html = views; }
    for (const b of strip.querySelectorAll('button')) b.disabled = busy && !b.classList.contains('cs-follow');
    const f = $('cs-follow'); f.classList.toggle('on', !!s.follow?.on); f.textContent = s.follow?.on ? 'Following ✓' : 'Follow person';
    f.disabled = acting || s.views.length < 2; f.title = s.views.length < 2 ? 'Save two positions first' : 'Turn the camera to keep the person in view';
  }

  async function act(body) {
    if (acting || !camId) return; acting = true; draw();
    try { await api({ action: 'camera', cameraId: camId, ...body }); }
    catch (e) { say(e.message); }
    finally { acting = false; refresh(); }
  }
  const nudge = (dx, dy) => act({ op: 'nudge', dx: dx * STEP[step], dy: dy * STEP[step] });
  const goto = (i) => { const v = status[camId]?.views?.[i]; if (v) act({ op: 'goto', viewId: v.id }); };

  // Buttons never take focus: a held space bar (talking) must not press them when it is let go.
  strip.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  strip.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.dir) { const [dx, dy] = b.dataset.dir.split(',').map(Number); nudge(dx, dy); }
    else if (b.dataset.id) act({ op: 'goto', viewId: b.dataset.id });
    else if (b.id === 'cs-step') { step = step === 'small' ? 'large' : 'small'; b.textContent = step === 'small' ? 'Small steps' : 'Big steps'; }
    else if (b.id === 'cs-follow') act({ op: 'follow', on: !status[camId]?.follow?.on, wanted: 'auto' });
  });
  $('cs-cam').addEventListener('error', () => { setTimeout(() => { const img = $('cs-cam'); img.src = `/cam/${encodeURIComponent(camId)}.mjpg?k=${encodeURIComponent(key)}&r=${Date.now()}`; }, 3000); });
  $('cs-cam').addEventListener('click', () => { const z = $('zoom'); if (!z) return; z.querySelector('img').src = $('cs-cam').src; z.style.display = 'flex'; });

  // Called from the desk's key handler (Shift is held).
  window.deskCamera = {
    key(e) {
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[e.code]) { e.preventDefault(); nudge(...arrows[e.code]); return true; }
      if (/^Digit[1-9]$/.test(e.code)) { e.preventDefault(); goto(Number(e.code.slice(5)) - 1); return true; }
      return false;
    },
  };
  refresh();
})();
