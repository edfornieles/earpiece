// The Run sheet: choose which phone plays each role, then one button starts everything
// (recording if needed, the visits, the score). Used on Programs and on the live desk.
(() => {
  const key = new URLSearchParams(location.search).get('k') || '';
  const url = (r) => r + (r.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(key);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function api(route, body) {
    const res = await fetch(url('/api/' + route), body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const v = await res.json().catch(() => ({})); if (!res.ok || v.error) throw Error(v.error || 'Request failed'); return v;
  }
  const css = `
  .run-scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}
  .run-sheet{background:var(--card,#1a1a1a);color:var(--fg,#eee);border:1px solid var(--line,#333);border-radius:14px;width:min(440px,100%);padding:20px 22px;font:14px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  .run-sheet h2{margin:0 0 2px;font-size:17px}.run-sheet .sub{margin:0 0 16px;opacity:.7;font-size:13px}
  .run-sheet .role{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--line,#333)}
  .run-sheet .role>span{white-space:nowrap}.run-sheet select{font:inherit;padding:5px 8px;border-radius:8px;max-width:60%}
  .run-sheet .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#888}.run-sheet .dot.on{background:#3fa35a}
  .run-sheet .note{font-size:13px;opacity:.8;margin:14px 0 0}.run-sheet .warn{color:#d08a2a}
  .run-sheet .err{color:#e0533a;font-size:13px;min-height:1em;margin:8px 0 0}
  .run-sheet .act{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .run-sheet button{font:inherit;padding:8px 16px;border-radius:9px;border:1px solid var(--line,#444);background:transparent;color:inherit;cursor:pointer}
  .run-sheet button.go{background:#3fa35a;border-color:#3fa35a;color:#fff;font-weight:600}
  .run-sheet button:disabled{opacity:.5;cursor:default}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  async function open(id, { after } = {}) {
    let plan; try { plan = await api('run-plan?id=' + encodeURIComponent(id)); } catch (e) { return alert(e.message); }
    const scrim = document.createElement('div'); scrim.className = 'run-scrim';
    const phone = (n) => plan.phones.find((p) => p.id === n);
    const opt = (n, sel) => `<option value="${n}" ${sel ? 'selected' : ''}>Phone ${n}${phone(n)?.connected ? ' · connected' : ''}</option>`;
    scrim.innerHTML = `<div class="run-sheet" role="dialog" aria-modal="true" aria-label="Run program">
      <h2>${esc(plan.program.title)}</h2><p class="sub">${plan.program.roles.length} role${plan.program.roles.length > 1 ? 's' : ''} · version ${plan.program.revision}</p>
      ${plan.program.roles.map((r) => `<div class="role"><span><span class="dot ${phone(plan.assignments[r.id])?.connected ? 'on' : ''}"></span>${esc(r.name)}</span><select data-role="${esc(r.id)}">${Array.from({ length: plan.maxPhones }, (_, i) => opt(i + 1, plan.assignments[r.id] === i + 1)).join('')}</select></div>`).join('')}
      <p class="note">${plan.standby ? 'Mother will <b>start recording</b>, then start each phone as soon as it is connected, then play scene 1.' : 'Recording is on. Mother will start each phone as soon as it is connected, then play scene 1.'}</p>
      ${plan.busy ? `<p class="note warn">“${esc(plan.busy)}” is running. Starting this one stops it.</p>` : ''}
      <p class="err" role="status"></p>
      <div class="act"><button class="cancel">Cancel</button><button class="go">Run</button></div></div>`;
    document.body.appendChild(scrim);
    const sheet = scrim.firstElementChild, err = sheet.querySelector('.err'), go = sheet.querySelector('.go');
    const close = () => scrim.remove();
    for (const s of sheet.querySelectorAll('select')) s.onchange = () => { s.previousElementSibling.firstElementChild.className = 'dot ' + (phone(Number(s.value))?.connected ? 'on' : ''); };
    sheet.querySelector('.cancel').onclick = close; scrim.onclick = (e) => { if (e.target === scrim) close(); };
    document.addEventListener('keydown', function esc_(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_); } });
    go.focus();
    go.onclick = async () => {
      go.disabled = true; err.textContent = '';
      const assignments = Object.fromEntries([...sheet.querySelectorAll('select')].map((s) => [s.dataset.role, Number(s.value)]));
      try {
        const r = await api('run', { id, assignments, replace: !!plan.busy });
        go.textContent = r.phase === 'recording' ? 'Starting recording…' : 'Starting…';
        setTimeout(() => { close(); if (after) after(r); else location.href = url('/control'); }, r.phase === 'recording' ? 1500 : 300);
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    };
  }
  window.MotherRun = { open, api };
})();
