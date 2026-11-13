// Follow view on the Room page: crops the fixed camera's 4K picture around one person.
// Framing logic is in follow-core.js; this file fetches pictures and draws.
(() => {
  const $ = (id) => document.getElementById(id), stage = $('stage'), cv = $('follow-canvas'), ctx = cv.getContext('2d');
  const who = $('follow-who'), note = $('follow-note'), live = $('live-picture');
  const view = new FollowCore.Follow();
  let tracks = [], tracking = false, full = null, fullAt = 0, loading = false, last = performance.now();
  let wanted = (() => { try { return localStorage.getItem('room.follow') || 'auto'; } catch { return 'auto'; } })();
  // Drawn whenever the pane is on screen (Follow, and Both), never left frozen on an old picture.
  const on = () => !document.hidden && cv.offsetParent !== null;
  const keyOf = (t) => t.binding?.person?.pid || t.id;
  const nameOf = (t) => t.binding?.person?.name || t.binding?.label || 'Unknown person ' + t.id.replace(/^\D+/, '');

  const camera = $('camera');
  addEventListener('room-tracking', (e) => {
    tracking = !!e.detail?.running && e.detail.cameraId === camera.value;
    tracks = tracking ? e.detail.tracks || [] : [];
    listPeople();
  });
  camera.addEventListener('change', () => {
    full?.close(); full = null; fullAt = 0; tracks = []; tracking = false; listPeople();
    ctx.clearRect(0, 0, cv.width, cv.height); note.textContent = '';
  });
  function listPeople() {
    const seen = tracks.filter((t) => t.visible && t.box), opts = [['auto', 'Auto']].concat(seen.map((t) => [keyOf(t), nameOf(t)]));
    if (wanted !== 'auto' && !opts.some(([k]) => k === wanted)) opts.push([wanted, 'Chosen person (out of view)']);
    const html = opts.map(([k, n]) => `<option value="${Setup.esc(k)}">${Setup.esc(n)}</option>`).join('');
    if (who.dataset.html !== html) { who.innerHTML = html; who.dataset.html = html; }
    who.value = wanted;
  }
  who.onchange = () => { wanted = who.value; try { localStorage.setItem('room.follow', wanted); } catch {} };

  // The newest 4K frame, only when it is newer than the one we have. The server has one only while tracking runs.
  async function fetchFull() {
    if (loading || !on()) return; loading = true;
    try {
      const id = camera.value;
      const q = new URLSearchParams(location.search); q.set('after', String(fullAt));
      const r = await fetch(`/cam/${encodeURIComponent(id)}/full.jpg?${q}`, { cache: 'no-store' });
      if (r.status === 200) {
        const bmp = await createImageBitmap(await r.blob());
        if (camera.value !== id) { bmp.close(); return; }
        if (full?.close) full.close();
        full = bmp; fullAt = Number(r.headers.get('x-frame-at')) || Date.now();
      }
    } catch {} finally { loading = false; }
  }
  setInterval(fetchFull, 100);

  function draw(now) {
    requestAnimationFrame(draw);
    const dt = (now - last) / 1000; last = now;
    if (!on()) return;
    const focus = tracking ? FollowCore.pickFocus(tracks, wanted) : null;
    const r = view.step(focus?.box || null, Date.now(), dt);
    const sharp = full && Date.now() - fullAt < 3000;
    const src = sharp ? full : live.naturalWidth ? live : null;
    const box = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1, w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
    if (w && h && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
    if (!src) { ctx.clearRect(0, 0, cv.width, cv.height); note.textContent = 'No picture from this camera.'; return; }
    const W = src.width || src.naturalWidth, H = src.height || src.naturalHeight;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, cv.width, cv.height);
    note.textContent = !tracking ? 'Start tracking to follow someone.' : focus ? `${nameOf(focus)} · ${sharp ? '4K' : 'preview, not sharp'}` : wanted !== 'auto' ? 'Selected person is out of view.' : 'Nobody in view: whole room';
  }
  requestAnimationFrame(draw);
})();
