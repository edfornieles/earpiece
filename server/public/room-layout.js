// Room page layout: which views the stage shows, and the setup drawer.
(() => {
  const $ = (id) => document.getElementById(id), stage = $('stage');
  const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

  function setView(v) {
    stage.dataset.view = v;
    for (const b of stage.querySelectorAll('.rm-stage-bar [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    remember('room.view', v);
  }
  for (const b of stage.querySelectorAll('.rm-stage-bar [data-view]')) b.onclick = () => setView(b.dataset.view);
  setView(recall('room.view') || 'both');

  const drawer = $('setup'), scrim = $('setup-scrim');
  function openSetup(tab) {
    drawer.hidden = false; scrim.hidden = false; $('open-setup').setAttribute('aria-expanded', 'true');
    if (tab) showTab(tab);
  }
  function closeSetup() { drawer.hidden = true; scrim.hidden = true; $('open-setup').setAttribute('aria-expanded', 'false'); }
  function showTab(t) {
    for (const b of drawer.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    for (const p of drawer.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t;
    remember('room.tab', t);
  }
  for (const b of drawer.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab);
  showTab(recall('room.tab') || 'calibration');
  if (/^#setup/.test(location.hash)) openSetup(location.hash.split('-')[1]);
  $('open-setup').onclick = () => (drawer.hidden ? openSetup() : closeSetup());
  $('close-setup').onclick = closeSetup; scrim.onclick = closeSetup;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) closeSetup(); });

  // Calibrating needs the picture and the plan side by side, with the drawer out of the way.
  $('calibrate').addEventListener('click', () => { closeSetup(); setView('both'); });
  // Naming an object happens on the analysed frame: keep the camera in view.
  for (const id of ['observe', 'draw']) $(id).addEventListener('click', () => { if (stage.dataset.view === 'plan') setView('both'); });
})();
