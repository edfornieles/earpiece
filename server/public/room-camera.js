// Room page: camera positions for a pan/tilt camera (Setup → Calibration) and "turn to follow"
// in the Follow view. The server does the moving; this only asks and shows.
(() => {
  const { $, esc, api, toast } = Setup;
  const panel = $('camera-positions'), list = $('position-list'), state = $('position-state'), follow = $('camera-follow'), followNote = $('camera-follow-note');
  let status = {}, lastEvent = 0, acting = false;
  const cam = () => $('camera').value;
  const mine = () => status[cam()] || null;

  addEventListener('room-tracking', (e) => { lastEvent = Date.now(); status = e.detail?.cameraControl || {}; finderOn(e.detail?.finder); draw(); });
  // The object finder switch (Objects section).
  const finderBox = $('finder-on');
  function finderOn(f) { if (finderBox && f && document.activeElement !== finderBox) finderBox.checked = !!f.enabled; }
  if (finderBox) finderBox.onchange = async () => { try { const v = await api('room', { action: 'objectFinder', on: finderBox.checked }); finderOn(v.finder); toast(finderBox.checked ? 'Furniture checks on' : 'Furniture checks off'); } catch (e) { toast(e.message); } };
  async function refresh() {
    try { const v = await api('room', { action: 'trackingView' }); status = v.cameraControl || {}; finderOn(v.finder); draw(); } catch {}
  }
  setInterval(() => {
    const visible = !$('setup').hidden || $('stage').dataset.view === 'follow';
    if (visible && Date.now() - lastEvent > 1200) refresh();
  }, 1500);
  $('camera').addEventListener('change', draw);

  function draw() {
    const s = mine();
    panel.hidden = !s; follow.closest('label').hidden = !s;
    if (!s) return;
    const active = s.active?.viewId, c = s.active?.correction;
    state.textContent = s.available === false ? `Cannot reach the camera's motor: ${s.error}`
      : s.busy ? `Camera ${s.busy}…`
      : s.error ? s.error
      : active ? `At ${s.views.find((v) => v.id === active)?.name || 'a saved position'}${c?.ok && c.shift ? ` · picture matched within ${Math.round(Math.hypot(...c.shift) * 3840)} px` : c && !c.ok && !c.fresh ? ` · ${c.error}` : ''}`
      : s.active ? 'Aimed by hand: not calibrated. Save this view as a position, then calibrate it.'
      : 'Not moved since Mother started: using the saved calibration.';
    const rows = s.views.map((v) => `<li data-id="${esc(v.id)}" class="${v.id === active ? 'here' : ''}"><span class="pos-name">${esc(v.name)}</span><span class="pill ${v.calibrated ? 'ok' : 'warn'}">${v.calibrated ? 'calibrated' : 'not calibrated'}</span>${v.id === active ? '<span class="pill">here</span>' : ''}<span class="rm-spacer"></span><button class="rm-btn go" ${s.busy ? 'disabled' : ''}>Go</button><button class="rm-btn remove" aria-label="Remove ${esc(v.name)}">✕</button></li>`).join('');
    if (list.dataset.html !== rows) { list.innerHTML = rows || '<li class="rm-dim">No positions yet. Aim the camera, then save the view.</li>'; list.dataset.html = rows; }
    for (const b of panel.querySelectorAll('.nudge, #position-save')) b.disabled = !!s.busy || s.available === false;
    follow.checked = !!s.follow?.on; follow.disabled = s.views.length < 2;
    followNote.textContent = s.views.length < 2 ? '(save two positions first)' : s.busy === 'turning' ? 'turning…' : s.lastMove ? `last turned to ${s.lastMove.to}` : '';
    const calNote = $('position-calibrate-note');
    if (calNote) calNote.textContent = active && !s.views.find((v) => v.id === active)?.calibrated ? 'This position is not calibrated yet: Calibrate camera to floor below.' : '';
  }

  async function act(body, done) {
    if (acting) return; acting = true;
    try { room = await api('room', { action: 'camera', cameraId: cam(), ...body }); status = room.tracking?.cameraControl || status; render(); draw(); if (done) toast(done); }
    catch (e) { toast(e.message); refresh(); }
    finally { acting = false; }
  }
  const STEP = { small: 0.02, large: 0.08 };
  for (const b of panel.querySelectorAll('.nudge')) b.onclick = () => {
    const k = STEP[$('nudge-size').value] || 0.02, [dx, dy] = b.dataset.dir.split(',').map(Number);
    act({ op: 'nudge', dx: dx * k, dy: dy * k });
  };
  $('position-save').onclick = () => { const name = $('position-name').value.trim(); if (!name) return toast('Name this position.'); act({ op: 'save', name }, `Saved “${name}”`).then(() => { $('position-name').value = ''; }); };
  list.onclick = (e) => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    if (e.target.closest('.go')) act({ op: 'goto', viewId: li.dataset.id });
    if (e.target.closest('.remove') && confirm('Remove this camera position and its calibration?')) act({ op: 'remove', viewId: li.dataset.id });
  };
  follow.onchange = () => act({ op: 'follow', on: follow.checked, wanted: $('follow-who').value });
  $('follow-who').addEventListener('change', () => { if (follow.checked) act({ op: 'follow', on: true, wanted: $('follow-who').value }); });
  refresh();
})();
