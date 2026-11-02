// Small helpers shared by every page.
async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed (' + res.status + ')'); e.status = res.status; throw e; }
  return data;
}
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showMsg(el, text, kind) {
  el.className = 'msg ' + (kind || 'error');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}
// Toggle-button chips. options: [{value, label}] or strings. max 1 = radio, 0 = unlimited.
function renderChips(container, options, max, selected) {
  selected = (selected || []).map(String);
  container.innerHTML = '';
  options.forEach(opt => {
    const o = typeof opt === 'object' ? opt : { value: opt, label: opt };
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = o.label;
    b.dataset.value = o.value;
    b.setAttribute('aria-pressed', selected.includes(String(o.value)) ? 'true' : 'false');
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      if (!on && max === 1) container.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', 'false'));
      else if (!on && max && chipValues(container).length >= max) return;
      b.setAttribute('aria-pressed', on ? 'false' : 'true');
    });
    container.appendChild(b);
  });
}
function chipValues(container) {
  return Array.from(container.querySelectorAll('.chip[aria-pressed=true]')).map(b => b.dataset.value);
}
