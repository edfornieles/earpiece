// The Studio sidebar on each operator page: where you can go, and whether a session is recording.
// The control room always opens in its own tab (so it keeps listening while you browse the others).
(() => {
  const KEY = new URLSearchParams(location.search).get('k');
  if (!KEY) return;
  const here = location.pathname.replace(/\.html$/, '').replace(/^\/$/, '/control');
  const inControl = here === '/control';
  const pages = [
    ['/control', 'Live desk'],
    ['/session', 'Session'],
    ['/people', 'Registrations'],
    ['/phones', 'Phones'],
    ['/screens', 'Screens'],
    ['/library', 'Library'],
    ['/files', 'Files'],
    ['/trash', 'Trash'],
  ];
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/studio.css';
  document.head.appendChild(css); document.body.classList.add('mother-shell');
  const bar = document.createElement('nav');
  bar.id = 'sitenav';
  const link = (href, label, cls = '') => {
    const a = document.createElement('a');
    a.href = `${href}?k=${KEY}`; a.textContent = label; a.className = cls + (href === here ? ' on' : '');
    // the control room keeps one tab; from the control room, the other pages open in one shared tab beside it
    if (href === '/control' && !inControl) a.target = 'earpiece_control';
    else if (href !== '/control' && inControl) a.target = 'earpiece_pages';
    return a;
  };
  bar.innerHTML = '<span class="brand">Mother</span>';
  for (const [href, label] of pages) {
    const group = ({'/control':'Workspace', '/phones':'Equipment', '/library':'Archive', '/people':'People'})[href];
    if (group) { const heading = document.createElement('span'); heading.className = 'nav-group'; heading.textContent = group; bar.appendChild(heading); }
    bar.appendChild(link(href, label));
  }
  bar.insertAdjacentHTML('beforeend', '<span class="sp"></span><span class="st" id="navstate">…</span>');
  document.body.prepend(bar);
  if (inControl) window.name = 'earpiece_control';

  async function status() {
    try {
      const s = await (await fetch('/api/status?k=' + KEY)).json();
      const st = document.getElementById('navstate');
      st.className = 'st' + (s.standby ? '' : ' rec');
      st.textContent = s.standby ? `○ Standby${s.title ? ' — next: ' + s.title : ''}` : `● Recording${s.title ? ' — ' + s.title : ''}`;
      st.title = s.standby ? 'Nothing is being recorded' : 'Recording since ' + new Date(s.since).toLocaleTimeString();
    } catch { document.getElementById('navstate').textContent = 'server not reachable'; }
  }
  status(); setInterval(status, 5000);
})();
