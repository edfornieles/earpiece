// The bar across the top of every page: where you can go, and whether a session is recording.
// The control room always opens in its own tab (so it keeps listening while you browse the others).
(() => {
  const KEY = new URLSearchParams(location.search).get('k');
  if (!KEY) return;
  const here = location.pathname.replace(/\.html$/, '').replace(/^\/$/, '/control');
  const inControl = here === '/control';
  const pages = [
    ['/control', 'Control room'],
    ['/phones', 'Phones'],
    ['/session', 'Session'],
    ['/screens', 'Screens'],
    ['/library', 'Library'],
    ['/files', 'Files'],
    ['/people', 'Registrations'],
    ['/trash', 'Trash'],
  ];
  const css = document.createElement('style');
  css.textContent = `
    #sitenav { display:flex; align-items:center; gap:4px; padding:6px 14px; min-height:40px; flex-wrap:wrap; background:#080808; border-bottom:1px solid #222; font:13px -apple-system, system-ui, sans-serif; position:relative; z-index:30; }
    #sitenav .brand { font-weight:600; letter-spacing:.08em; font-size:11px; color:#8a8780; margin-right:10px; text-transform:uppercase; }
    #sitenav a { color:#b9b6ae; text-decoration:none; padding:6px 10px; border-radius:7px; white-space:nowrap; }
    #sitenav a:hover { background:#1a1a1a; color:#fff; }
    #sitenav a.on { background:#222; color:#fff; }
    #sitenav .sp { flex:1; }
    #sitenav .st { color:#8a8780; font-size:12px; padding:4px 10px; border:1px solid #2a2a2a; border-radius:20px; white-space:nowrap; max-width:340px; overflow:hidden; text-overflow:ellipsis; }
    #sitenav .st.rec { color:#ff7a5c; border-color:#5a2a1e; }
    #sitenav .ext { color:#8a8780; }`;
  document.head.appendChild(css);
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
  for (const [href, label] of pages) bar.appendChild(link(href, label));
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
