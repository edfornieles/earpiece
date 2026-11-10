// The room on the live desk: where people are on the plan, a close-up that follows them, and exactly
// what Mother perceives (the same words it is given) plus its last camera close-up.
(() => {
  const key = new URLSearchParams(location.search).get('k') || '';
  const $ = (id) => document.getElementById(id);
  const url = (r) => r + (r.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(key);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = $('desk-room'); if (!root) return;
  $('dr-open').href = url('/room');
  let state = null, last = performance.now(), lookShown = '';
  const view = new FollowCore.Follow(), cv = $('dr-follow'), ctx = cv.getContext('2d');

  async function poll() {
    try { state = await (await fetch(url('/api/desk-room'))).json(); drawPlan(); drawSees(); drawWorld(); } catch {}
    setTimeout(poll, 700);
  }
  const colour = { sure: '#3fa35a', rough: '#d08a2a', unsure: '#e0533a' };
  function drawPlan() {
    const svg = $('dr-plan'), plan = state?.floorPlan; if (!plan || !svg) return;
    const W = plan.widthM, D = plan.depthM;
    svg.setAttribute('viewBox', `-0.15 -0.15 ${W + 0.3} ${D + 0.3}`);
    const shapes = (plan.footprints || []).filter((f) => (f.heightM ?? 1) > 0.05).map((f) => {
      const pts = f.points.map((p) => p.join(',')).join(' '), cx = f.points.reduce((a, p) => a + p[0], 0) / f.points.length, cy = f.points.reduce((a, p) => a + p[1], 0) / f.points.length;
      return `<polygon class="fp" points="${pts}"/><text class="fpl" x="${cx}" y="${cy}">${esc(f.name)}</text>`;
    }).join('');
    const people = (state?.people || []).filter((p) => p.floor).map((p) => {
      const c = p.visible ? colour[p.confidence] || colour.unsure : '#888', r = Math.max(0.12, Math.min(1, p.radiusM || 0.3));
      return `<circle cx="${p.floor[0]}" cy="${p.floor[1]}" r="${r}" fill="${c}" fill-opacity=".15" stroke="${c}" stroke-width=".02" ${p.visible ? '' : 'stroke-dasharray=".06 .05"'}/><circle cx="${p.floor[0]}" cy="${p.floor[1]}" r=".09" fill="${c}"/><text class="pl" x="${p.floor[0] + 0.14}" y="${p.floor[1] - 0.12}">${esc([p.name || (p.phone ? 'Phone ' + p.phone : 'Person'), p.activity?.label].filter(Boolean).join(' · '))}</text>`;
    }).join('');
    svg.innerHTML = `<rect class="room" x="0" y="0" width="${W}" height="${D}"/>${shapes}${people}`;
  }
  function drawSees() {
    const s = state; if (!s) return;
    const cam = s.camera?.busy ? ` · camera ${s.camera.busy}` : '';
    $('dr-state').textContent = s.tracking ? `Tracking on${s.pose?.fps ? ` · ${s.pose.fps} fps` : ''}${cam}` : 'Tracking off';
    const ph = s.phones[0];
    $('dr-perception').textContent = ph ? ph.perception : 'Nobody is on a phone visit yet. Press ▶ Play or ▶ Run.';
    const look = ph?.look, sig = look ? look.at + look.file : '';
    if (sig !== lookShown) {
      lookShown = sig;
      $('dr-look').innerHTML = look ? `${look.file ? `<img src="${esc(url('/api/look-image?file=' + encodeURIComponent(look.file)))}" alt="Mother's last camera close-up">` : ''}<div><b>“${esc(look.question)}”</b><br>${esc(look.answer)}<br><span class="hint">${new Date(look.at).toLocaleTimeString()}</span></div>` : '<span class="hint">Ask “what am I holding?” and Mother’s close-up appears here.</span>';
    }
  }
  // The camera's furniture checks: when the last one was, what moved, and a way to put a wrong move back.
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
  async function act(body) {
    const r = await fetch(url('/api/room'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error || 'That did not work.');
  }
  let changesShown = '', note = '';
  function drawWorld() {
    const w = state?.world; if (!w) return;
    const f = w.finder || {}, c = f.check;
    $('dr-check').textContent = note || (!f.ready ? 'The object finder is not set up on this computer.'
      : f.mode === 'off' ? 'Switched off (Room page → Objects).'
      : !state.tracking ? `Runs while tracking is on.${w.lastCheckAt ? ' Last check ' + ago(w.lastCheckAt) + '.' : ''}`
      : c ? (c.waiting ? `Check ${c.waiting}…` : `Checking the room now (look ${Math.min(c.passes + 1, c.of)} of ${c.of})…`)
      : `${w.lastCheckAt ? 'Last check ' + ago(w.lastCheckAt) : 'Not checked yet'}${f.mode === 'always' ? ' · looking continuously' : f.nextCheckAt ? ` · next in ${Math.max(1, Math.round((f.nextCheckAt - Date.now()) / 60000))} min` : ''}.${f.error ? ' ' + f.error : ''}`);
    $('dr-check-now').disabled = !f.ready || !state.tracking || !!c;
    const rows = (w.changes || []).map((e) => `<li class="${e.undone ? 'undone' : ''}"><span>${esc(e.name)} → ${esc(e.to)} <span class="hint">${esc(e.distanceM)} m · ${e.by === 'camera' ? 'by the camera' : 'from the desk'} · ${ago(e.at)}</span></span>${e.undone ? '' : `<button data-undo="${esc(e.id)}">Undo</button>`}</li>`).join('');
    if (rows !== changesShown) { changesShown = rows; $('dr-changes').innerHTML = rows || '<li class="hint">No furniture has moved.</li>'; }
  }
  const say = (text) => { note = text; drawWorld(); setTimeout(() => { note = ''; drawWorld(); }, 4000); };
  $('dr-check-now').onclick = () => act({ action: 'roomCheck' }).then(() => say('Check asked for…'), (e) => say(e.message));
  $('dr-changes').onclick = (e) => { const id = e.target.dataset?.undo; if (id) act({ action: 'undoMove', id }).catch((x) => say(x.message)); };
  // The close-up reuses the camera preview this page already shows (no extra downloads or 4K decoding:
  // a small panel does not need 4K, and decoding it here made the Mac too busy for clean audio).
  const preview = () => document.querySelector(`#cams [data-id="${CSS.escape(state?.cameraId || '')}"] img`);
  function draw(now) {
    requestAnimationFrame(draw);
    if (now - last < 66 || document.hidden) return;   // ~15 frames a second is plenty for a thumbnail
    const dt = (now - last) / 1000; last = now;
    const people = (state?.people || []).filter((p) => p.visible && p.box).map((p) => ({ ...p, binding: p.phone ? { phone: p.phone } : null }));
    const focus = people.find((p) => p.phone) || FollowCore.pickFocus(people, 'auto');
    const r = view.step(focus?.box || null, Date.now(), dt);
    const box = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1, w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
    if (w && h && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
    const src = preview(); const ok = src && src.naturalWidth > 0;
    if (!state?.tracking || !ok) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#888'; ctx.font = `${13 * dpr}px -apple-system, system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(state?.tracking ? 'Waiting for the camera…' : 'Close-up appears while tracking is on', cv.width / 2, cv.height / 2);
      return;
    }
    const W = src.naturalWidth, H = src.naturalHeight;
    ctx.drawImage(src, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, cv.width, cv.height);
  }
  requestAnimationFrame(draw);
  poll();
})();
