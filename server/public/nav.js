// The Studio sidebar on each operator page: where you can go, and whether a session is recording.
// The control room always opens in its own tab (so it keeps listening while you browse the others).
// Operator pages have no logins: tell password managers (LastPass, 1Password, Bitwarden) to leave every field alone,
// including the ones added later (each phone's card), so they stop putting their icons in the desk's fields.
(() => {
  const quiet = (el) => {
    if (el.type === 'password' || el.dataset.quieted) return;
    el.dataset.quieted = '1';
    el.dataset.lpignore = 'true'; el.dataset['1pIgnore'] = ''; el.dataset.bwignore = ''; el.dataset.formType = 'other';
    if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
    // Newer LastPass ignores the markers above but never offers logins in a search box; it behaves like a text field.
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || 'text') === 'text') el.type = 'search';
  };
  const style = document.createElement('style');   // no clear (×) button or rounded search look
  style.textContent = 'input[type=search]{-webkit-appearance:none;appearance:none}input[type=search]::-webkit-search-cancel-button,input[type=search]::-webkit-search-decoration{-webkit-appearance:none;display:none}';
  document.head.appendChild(style);
  const sweep = (root) => { if (root.matches?.('input, textarea')) quiet(root); root.querySelectorAll?.('input, textarea').forEach(quiet); };
  sweep(document);
  new MutationObserver((changes) => { for (const c of changes) for (const n of c.addedNodes) if (n.nodeType === 1) sweep(n); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
(() => {
  const KEY = new URLSearchParams(location.search).get('k');
  // Signed in with Google at the director address there is no link key: the login itself is the key.
  const Q = KEY ? '?k=' + KEY : '';
  const here = location.pathname.replace(/\.html$/, '').replace(/^\/$/, '/control');
  const inControl = here === '/control';
  // Six sections. The section you are in lists its pages underneath.
  const sections = [
    ['Perform', [['/control', 'Live desk'], ['/session', 'Brief & notes']]],
    ['Programs', [['/programs', 'Programs']]],
    ['Room', [['/room', 'Room']]],
    ['Setup', [['/phones', 'Phones'], ['/screens', 'Screens'], ['/people', 'Registrations']]],
    ['Archive', [['/library', 'Library'], ['/files', 'Files'], ['/trash', 'Trash']]],
    ['Team', [['/team', 'Team']]],
  ];
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/studio.css';
  document.head.appendChild(css); document.body.classList.add('mother-shell');
  const bar = document.createElement('nav');
  bar.id = 'sitenav';
  const link = (href, label, cls = '') => {
    const a = document.createElement('a');
    a.href = href + Q; a.textContent = label; a.className = cls + (href === here ? ' on' : '');
    // the control room keeps one tab; from the control room, the other pages open in one shared tab beside it
    if (href === '/control' && !inControl) a.target = 'earpiece_control';
    else if (href !== '/control' && inControl) a.target = 'earpiece_pages';
    return a;
  };
  bar.innerHTML = '<span class="brand">Mother</span>';
  for (const [name, pages] of sections) {
    const current = pages.some(([href]) => href === here);
    const top = link(pages[0][0], name, 'section' + (current ? ' current' : ''));
    if (current && pages.length > 1) top.classList.remove('on');   // the page itself is highlighted below
    if (current) top.classList.add(pages.length > 1 ? 'open' : 'on');
    bar.appendChild(top);
    if (current && pages.length > 1) for (const [href, label] of pages) bar.appendChild(link(href, label, 'sub'));
  }
  bar.insertAdjacentHTML('beforeend', '<span class="sp"></span><span class="st" id="navstate">…</span>');
  document.body.prepend(bar);
  if (inControl) window.name = 'earpiece_control';

  // What is happening, and the one thing to do next.
  async function status() {
    const st = document.getElementById('navstate');
    try {
      const s = await (await fetch('/api/status' + Q)).json();
      const phones = s.phonesConnected || [], prog = s.program, launch = s.launch;
      st.className = 'st' + (s.standby ? '' : ' rec');
      const lines = [s.standby ? '○ Not recording' : '● Recording' + (s.title ? ' — ' + s.title : '')];
      lines.push(phones.length ? `Phone${phones.length > 1 ? 's' : ''} ${phones.join(', ')} connected` : 'No phones connected');
      if (prog && ['running', 'paused'].includes(prog.status)) lines.push(`▶ ${prog.title} · ${prog.status}`);
      if (launch?.waitingFor) lines.push(`Starting ${launch.title}: ` + (launch.waitingFor.map((w) => `phone ${w.phone} — ${w.reason}`).join('; ') || 'starting…'));
      else if (launch?.error) lines.push(launch.error);
      else if (!prog || !['running', 'paused'].includes(prog.status)) lines.push(!phones.length ? 'Next: connect a phone (Setup → Phones)' : 'Next: press ▶ Run on a program');
      if (s.observer?.enabled) lines.push('Vision on');
      st.innerHTML = lines.map((l, i) => `<span${i === lines.length - 1 && /^Next:/.test(l) ? ' class="next"' : ''}>${l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span>`).join('');
      st.title = s.standby ? 'Nothing is being recorded' : 'Recording since ' + new Date(s.since).toLocaleTimeString();
    } catch { st.textContent = 'server not reachable'; }
  }
  status(); setInterval(status, 5000);
})();
