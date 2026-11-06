// Shared helpers for operator setup pages. These pages never open a microphone or relay audio.
const Setup = (() => {
  const key = new URLSearchParams(location.search).get('k') || '';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const url = (route) => `${route}${route.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}`;
  async function api(route, body, options = {}) {
    const res = await fetch(url('/api/' + route), { ...(body === undefined ? {} : { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }), signal:options.signal });
    let data; try { data = await res.json(); } catch { throw new Error(res.status === 403 ? 'Open this page from the control room using its current link.' : 'The server could not complete this request.'); }
    if (!res.ok || data.error) throw new Error(data.error || 'Request failed.');
    return data;
  }
  function toast(message) { $('toast').textContent = message; $('toast').style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').style.display = 'none'; }, 4500); }
  async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Link copied'); } catch { toast('Select and copy the link displayed here.'); } }
  for (const a of document.querySelectorAll('[data-route]')) a.href = url(a.dataset.route);
  return { $, esc, url, api, toast, copy };
})();
