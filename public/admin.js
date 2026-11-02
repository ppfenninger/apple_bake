// Organizer admin page.
let D = null;            // everything from /api/admin/data
let viewEvent = null;    // event id being viewed (null = live event)
let tab = 'overview';
try { tab = sessionStorage.getItem('adminTab') || 'overview'; } catch (e) {}

const TABS = [
  ['overview', 'Overview'], ['judges', 'Judges'], ['dishes', 'Dishes'], ['judging', 'Judging'], ['votes', 'Votes'],
  ['results', 'Results'], ['categories', 'Categories'], ['settings', 'Settings'], ['texts', 'Texts'],
];

const q = (path) => path + (viewEvent ? (path.includes('?') ? '&' : '?') + 'event=' + viewEvent : '');
const catName = id => (D.categories.find(c => c.id === id) || {}).display || ('#' + id);
const judgeName = id => (D.judges.find(j => j.id === id) || {}).name || '?';
let flashTimer = null;
const flash = (text, kind) => {
  clearTimeout(flashTimer);
  showMsg($('msg'), text, kind || 'ok');
  if (kind !== 'error') flashTimer = setTimeout(() => showMsg($('msg'), ''), 5000);
};
const fail = e => flash(e.message, 'error');
const isLive = () => D && D.event.id === D.activeEventId;

async function refresh() {
  try {
    D = await api(q('/api/admin/data'));
  } catch (e) {
    if (e.status === 401) { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); return; }
    return fail(e);
  }
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  viewEvent = D.event.id;
  $('eventTitle').textContent = D.event.name;
  document.title = D.event.name + ' admin';
  $('liveNote').textContent = isLive() ? 'Live event: signup, check-in, voting and results use this one.' : 'Past event (not live). You can still view and edit it.';
  $('makeLive').classList.toggle('hidden', isLive());
  $('eventPick').innerHTML = D.events.map(e => '<option value="' + e.id + '">' + esc(e.name) + (e.id === D.activeEventId ? ' (live)' : '') + '</option>').join('');
  $('eventPick').value = String(D.event.id);
  $('neCopy').innerHTML = D.events.map(e => '<option value="' + e.id + '">Settings and categories from ' + esc(e.name) + '</option>').join('') +
    '<option value="defaults">The built-in default categories</option>';
  renderTabs();
  render();
}

function renderTabs() {
  $('tabs').innerHTML = TABS.map(([k, label]) => '<button data-tab="' + k + '" class="' + (k === tab ? 'on' : '') + '">' + label + '</button>').join('');
  $('tabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    clearTimeout(flashTimer); showMsg($('msg'), '');
    try { sessionStorage.setItem('adminTab', tab); } catch (e) {}
    renderTabs();
    render();
  }));
}

function render() {
  const fn = { overview, judges, dishes, judging, votes, results, categories, settings, texts }[tab] || overview;
  $('view').innerHTML = '';
  fn($('view'));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------------------------------------------------------------------------
// Editable table
// ---------------------------------------------------------------------------
// cols: [{key, label, type: text|int|bool|select|ids|readonly, options, get(row), fmt(row)}]
function editTable(container, table, rows, cols, opts = {}) {
  const wrap = el('<div class="scroll"><table class="edit"><thead><tr></tr></thead><tbody></tbody></table></div>');
  const head = wrap.querySelector('tr');
  cols.forEach(c => head.appendChild(el('<th>' + esc(c.label) + '</th>')));
  if (opts.actions) head.appendChild(el('<th></th>'));
  const tbody = wrap.querySelector('tbody');
  if (!rows.length) tbody.appendChild(el('<tr><td colspan="' + (cols.length + 1) + '" class="muted">Nothing here yet.</td></tr>'));
  rows.forEach(row => {
    const tr = document.createElement('tr');
    cols.forEach(c => {
      const td = document.createElement('td');
      const value = c.get ? c.get(row) : row[c.key];
      if (c.type === 'bool') {
        const box = el('<input type="checkbox"' + (value ? ' checked' : '') + ' aria-label="' + esc(c.label) + '">');
        box.addEventListener('change', () => save(table, row.id, { [c.key]: box.checked }));
        td.appendChild(box);
      } else {
        td.innerHTML = c.fmt ? c.fmt(row) : esc(value === null || value === undefined ? '' : value);
        if (c.type && c.type !== 'readonly') {
          td.className = 'cell';
          td.title = 'Click to edit';
          td.addEventListener('click', ev => { if (!td.querySelector('input,select')) startEdit(td, table, row, c, value, ev); });
        }
      }
      tr.appendChild(td);
    });
    if (opts.actions) {
      const td = document.createElement('td');
      td.style.whiteSpace = 'nowrap';
      opts.actions(row).forEach(a => td.appendChild(a));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  container.appendChild(wrap);
}

function startEdit(td, table, row, col, value, ev) {
  if (col.type === 'ids') return idsPopover(td, table, row, col, value || []);
  let input;
  if (col.type === 'select') {
    input = el('<select>' + col.options.map(o => '<option' + (String(o) === String(value) ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>');
  } else {
    input = el('<input type="' + (col.type === 'int' ? 'number' : 'text') + '">');
    input.value = value === null || value === undefined ? '' : value;
  }
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    if (String(input.value) === String(value === null || value === undefined ? '' : value)) return render();
    save(table, row.id, { [col.key]: input.value });
  };
  input.addEventListener('blur', commit);
  input.addEventListener('change', () => { if (col.type === 'select') commit(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { done = true; render(); }
  });
}

function idsPopover(td, table, row, col, value) {
  document.querySelectorAll('.popover').forEach(p => p.remove());
  const options = col.options();
  const pop = el('<div class="popover"></div>');
  options.forEach(o => {
    pop.appendChild(el('<label><input type="checkbox" value="' + o.id + '"' + (value.includes(o.id) ? ' checked' : '') + '> ' + esc(o.name) + '</label>'));
  });
  const bar = el('<div class="toolbar" style="margin:8px 0 0"><button class="primary" style="width:auto;padding:8px 14px;font-size:14px">Save</button><button>Cancel</button></div>');
  bar.children[0].addEventListener('click', () => {
    const ids = Array.from(pop.querySelectorAll('input:checked')).map(i => Number(i.value));
    pop.remove();
    save(table, row.id, { [col.key]: ids });
  });
  bar.children[1].addEventListener('click', () => pop.remove());
  pop.appendChild(bar);
  const r = td.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - 280)) + 'px';
  pop.style.top = (window.scrollY + r.bottom + 4) + 'px';
  document.body.appendChild(pop);
}

async function save(table, id, values) {
  try {
    await api(q('/api/admin/rows/' + table + '/' + id), { method: 'PATCH', body: { values } });
    await refresh();
  } catch (e) { fail(e); render(); }
}

function button(label, onClick, cls) {
  const b = el('<button type="button" class="' + (cls || '') + '">' + esc(label) + '</button>');
  b.addEventListener('click', onClick);
  return b;
}

/** A delete button that asks "Sure?" on the first click instead of a browser dialog. */
function deleteButton(table, id, label) {
  const b = button(label || 'Delete', async () => {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Sure?'; b.classList.add('danger'); setTimeout(() => { delete b.dataset.armed; b.textContent = label || 'Delete'; b.classList.remove('danger'); }, 3000); return; }
    try { await api(q('/api/admin/rows/' + table + '/' + id), { method: 'DELETE' }); await refresh(); } catch (e) { fail(e); }
  }, 'link-btn');
  return b;
}

async function addRow(table, values) {
  try { await api(q('/api/admin/rows/' + table), { body: { values: values || {} } }); await refresh(); } catch (e) { fail(e); }
}

function exportLink(what, label) {
  return el('<a class="sub" href="' + q('/api/admin/export/' + what + '.csv') + '">' + esc(label || 'Download CSV') + '</a>');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function overview(v) {
  const s = D.settings;
  const judgedCats = D.categories.filter(c => c.kind === 'judged' && c.active);
  const res = D.computed.results;
  const decided = res.filter(r => r.status === 'decided').length;
  const pending = res.filter(r => r.status === 'pending');
  v.appendChild(el('<div class="stats">' +
    '<div class="stat"><b>' + D.judges.filter(j => j.checked_in).length + ' / ' + D.judges.length + '</b>judges checked in</div>' +
    '<div class="stat"><b>' + D.entries.length + '</b>dishes</div>' +
    '<div class="stat"><b>' + decided + ' / ' + res.filter(r => r.status !== 'none').length + '</b>awards decided</div>' +
    '<div class="stat"><b>' + D.votes.reduce((n, x) => n + (x.votes || 0), 0) + '</b>votes</div></div>'));

  const sw = el('<section class="card"><h2>Switches</h2></section>');
  [['signup_open', 'Judge signup page is open'], ['checkin_open', 'Check-in is open'], ['voting_open', 'Voting is open'],
    ['results_public', 'Results are public'], ['test_mode', 'Test mode: texts are logged on the Texts tab instead of sent']].forEach(([k, label]) => {
    const row = el('<label class="switch"><input type="checkbox"' + (/^true$/i.test(s[k]) ? ' checked' : '') + '> ' + esc(label) + '</label>');
    row.querySelector('input').addEventListener('change', async e => {
      try { await api(q('/api/admin/settings'), { method: 'PUT', body: { values: { [k]: e.target.checked } } }); await refresh(); } catch (err) { fail(err); }
    });
    sw.appendChild(row);
  });

  const steps = el('<section class="card steps"><h2>Steps</h2></section>');
  const report = el('<pre class="report hidden"></pre>');
  const step = (title, desc, btn) => {
    const r = el('<div class="step"><div class="what"><b>' + title + '</b><div class="sub">' + desc + '</div></div></div>');
    if (btn) r.appendChild(btn);
    steps.appendChild(r);
  };
  step('1. Share the judge signup link', 'Send it in the judge email. Answers appear on the Judges tab. Pasting a Google Form export works too (Judges tab > Import).');
  step('2. Assign judges', 'At least ' + (s.judges_per_category || 2) + ' per category from different floors, diet-safe, max ' + (s.max_categories_per_judge || 2) + ' each. Edit by hand after; tick Lock to keep a change.',
    button('Assign judges', async () => {
      try {
        const r = await api(q('/api/admin/assign'), { body: {} });
        const lines = ['Assigned ' + r.judges + ' judges to ' + r.categories + ' categories.'];
        if (r.shortages.length) lines.push('', 'Short on judges:', ...r.shortages.map(x => '  ' + x.category + ' (' + x.have + ' of ' + x.need + ')'));
        if (r.overloaded.length) lines.push('', 'Given one extra category to cover gaps: ' + r.overloaded.join(', '));
        if (r.unassigned.length) lines.push('', 'Backups (if they check in, they fill a gap or join a category when judging starts): ' + r.unassigned.join(', '));
        if (r.noFloor.length) lines.push('', 'Unknown floor, so the floor rule could not be checked: ' + r.noFloor.join(', '));
        await refresh();
        const rep = $('view').querySelector('pre.report');
        rep.textContent = lines.join('\n');
        rep.classList.remove('hidden');
      } catch (e) { fail(e); }
    }, 'primary'));
  const hereCount = D.judges.filter(j => j.checked_in).length;
  step('3. Judges check in at the event', hereCount + ' of ' + D.judges.length + ' checked in. Judges look up their name on <a href="/here" target="_blank">' + esc(D.origin) + '/here</a> (also linked from the check-in laptop), or tick "Here" on the Judges tab. Only checked-in judges get texts.');
  const sendWrap = el('<div style="display:flex;flex-direction:column;gap:6px;align-items:stretch;min-width:240px"></div>');
  const started = D.judging.length > 0;
  sendWrap.appendChild(button(started ? 'Text judges who still need a link' : 'Start judging', () => previewSend(), 'primary'));
  step('4. Start judging', 'Texts each checked-in judge a personal link listing their dish numbers. Backups fill categories short on judges. You see who will be texted before anything is sent. Afterwards, a judge who checks in gets a text right away, and a dish checked in later is added to its category.', sendWrap);
  steps.appendChild(sendPanel());
  step('5. Watch it come in', 'Ties go to a third judge automatically. Add paper tallies on the Votes tab, fix anything on the Results tab, then turn on "Results are public".');
  steps.appendChild(report);

  const row = el('<div class="row"></div>');
  const left = el('<div></div>');
  left.appendChild(sw);
  left.appendChild(textingCard());
  row.appendChild(left);
  row.appendChild(steps);
  v.appendChild(row);

  if (pending.length) {
    v.appendChild(el('<section class="card"><h2>Still waiting</h2><table><tbody>' +
      pending.map(r => '<tr><td>' + esc(r.category) + '</td><td class="muted">' + esc(r.how) + '</td></tr>').join('') + '</tbody></table></section>'));
  }

  const links = el('<section class="card"><h2>Links</h2></section>');
  const o = D.origin;
  [['Voting (print the QR for the tables)', '/vote'], ['Results', '/results'], ['Judge signup', '/signup'], ['Judge check-in (at the event)', '/here'],
    ['Check-in (entry-table laptop) · PIN ' + s.checkin_pin, '/checkin'], ['Home', '/']].forEach(([label, path]) => {
    const r = el('<div style="margin:8px 0"><div class="sub">' + esc(label) + '</div><a href="' + path + '" target="_blank">' + esc(o + path) + '</a></div>');
    links.appendChild(r);
  });
  const qrBox = el('<div class="qr" id="voteQr"></div>');
  links.appendChild(qrBox);
  try { new QRCode(qrBox, { text: o + '/vote', width: 160, height: 160 }); } catch (e) { qrBox.remove(); }
  v.appendChild(links);
}

// ---------------------------------------------------------------------------
// Texting: setup checklist, test text, and the Start judging preview
// ---------------------------------------------------------------------------

const statusClass = st => /^(delivered|TEST)/.test(st) ? 'good' : /^not /.test(st) ? 'bad' : 'pending';

function textingCard() {
  const t = D.twilio;
  const item = (cls, text) => '<li class="' + cls + '">' + text + '</li>';
  const sidBad = t.problems.find(p => /ACCOUNT_SID/.test(p));
  const card = el('<section class="card"><h2>Texting</h2><ul class="checks">' +
    item(sidBad ? 'bad' : 'good', sidBad ? esc(sidBad) : 'Twilio account SID is set (' + esc(t.sid) + ')') +
    item(t.token ? 'good' : 'bad', t.token ? 'Twilio auth token is set' : 'The TWILIO_AUTH_TOKEN secret is missing in Cloudflare') +
    item(t.from ? 'good' : 'bad', t.from ? 'Texts come from ' + esc(t.from) : esc(t.problems.find(p => /phone number/.test(p)) || 'No Twilio phone number on the Settings tab.')) +
    (t.testMode ? item('pending', 'Test mode is on: judges\' texts are only logged on the Texts tab, nothing reaches phones. Turn it off under Switches when you\'re ready.')
      : item('good', 'Test mode is off: judges get real texts')) +
    '</ul><label>Send yourself a real test text</label><div class="toolbar"><input type="tel" placeholder="617-555-1234" style="max-width:200px"></div>' +
    '<div class="msg hidden"></div></section>');
  const input = card.querySelector('input');
  const out = card.querySelector('.msg');
  const show = (text, cls) => { out.className = 'msg ' + (cls === 'good' ? 'ok' : cls === 'bad' ? 'error' : 'pending'); out.textContent = text; };
  const sendBtn = button('Send', async () => {
    sendBtn.disabled = true;
    show('Sending...', 'pending');
    try {
      const r = await api(q('/api/admin/test-sms'), { body: { to: input.value, real: true } });
      show(r.ok ? 'Twilio accepted it. Checking whether it reached the phone...' : r.status, r.ok ? 'pending' : 'bad');
      if (r.ok && r.id) await watchDelivery(r.id, st => show(st, statusClass(st)));
    } catch (e) { show(e.message, 'bad'); }
    sendBtn.disabled = false;
  });
  card.querySelector('.toolbar').appendChild(sendBtn);
  return card;
}

/** Asks Twilio about one text a few times until it is delivered or fails. */
async function watchDelivery(id, onStatus) {
  for (const wait of [3000, 5000, 8000, 15000, 30000]) {
    await new Promise(r => setTimeout(r, wait));
    try {
      const r = await api(q('/api/admin/check-delivery'), { body: { id } });
      const row = r.rows.find(x => x.id === id);
      if (!row) return;
      onStatus(row.status.startsWith('delivered') ? 'Delivered! Texting works.' : row.status);
      if (/^(delivered|not delivered)/.test(row.status)) return;
    } catch (e) { onStatus('Could not check delivery: ' + e.message); return; }
  }
  onStatus('Twilio has not reported delivery yet. Check the Texts tab in a minute, or the message log in the Twilio console.');
}

let sendState = null; // {mode: 'preview' | 'result', data}

async function previewSend() {
  try {
    sendState = { mode: 'preview', data: await api(q('/api/admin/send-judging'), { body: { dryRun: true } }) };
  } catch (e) { sendState = { mode: 'error', error: e.message }; }
  await refresh();
}

function sendPanel() {
  const box = el('<div class="send-panel"></div>');
  if (!sendState) return box;
  const d = sendState.data;
  const close = button('Close', () => { sendState = null; render(); });
  const list = items => '<ul>' + items.map(x => '<li>' + x + '</li>').join('') + '</ul>';
  if (sendState.mode === 'error') {
    box.appendChild(el('<div class="msg error">' + esc(sendState.error) + '</div>'));
    box.appendChild(close);
    return box;
  }
  const warnings = [];
  if (d.gaps.length) warnings.push('These categories have dishes but no checked-in judge: ' + esc(d.gaps.join(', ')) + '. Check someone in, or assign a judge on the Judges tab.');
  if (d.oneJudge.length) warnings.push('Only one checked-in judge, who decides alone: ' + esc(d.oneJudge.join(', ')) + '.');
  if (d.notHere.length) warnings.push('Assigned but not checked in, so not texted: ' + esc(d.notHere.join(', ')) + '. They get a text as soon as they check in.');
  if (d.autoWon.length) warnings.push('Only one dish, so it wins without judging: ' + esc(d.autoWon.join(', ')) + '.');
  if (d.noPhone.length) warnings.push('No phone number, so no text: ' + esc(d.noPhone.join(', ')) + '. Their link is on the Judges tab.');
  if (!d.testMode && !d.twilio.ready) warnings.push('Real texts can\'t go out yet: ' + esc(d.twilio.problems.join(' ')));

  if (sendState.mode === 'preview') {
    if (!d.judges) {
      box.appendChild(el('<div class="msg error"><b>Nobody to text yet.</b>' + list(d.why.map(esc)) + '</div>'));
      if (warnings.length) box.appendChild(el('<div class="sub">' + list(warnings) + '</div>'));
      box.appendChild(close);
      return box;
    }
    box.appendChild(el('<div class="msg ' + (d.testMode ? 'pending' : 'ok') + '"><b>' +
      d.here + ' of ' + d.total + ' judges checked in. ' + (d.testMode ? 'Test mode is on: these ' + d.judges + ' text' + (d.judges === 1 ? '' : 's') + ' will only be logged on the Texts tab. Nothing reaches phones.'
        : 'This sends ' + d.judges + ' real text' + (d.judges === 1 ? '' : 's') + '.') + '</b>' +
      list(d.preview.map(p => esc(p.name) + (p.phone ? ' (' + esc(p.phone) + ')' : ' (no phone)') + ': ' + esc(p.categories.join(', ')))) + '</div>'));
    if (d.backups.length) box.appendChild(el('<div class="sub"><b>Backup judges placed:</b>' + list(d.backups.map(b => esc(b.name) + ' to ' + esc(b.category) + ' (' + esc(b.reason) + ')')) + '</div>'));
    if (warnings.length) box.appendChild(el('<div class="sub">' + list(warnings) + '</div>'));
    const closeBox = el('<label class="switch" style="padding:0;font-size:14px"><input type="checkbox"> Also close check-in</label>');
    box.appendChild(closeBox);
    const bar = el('<div class="toolbar"></div>');
    const go = button(d.testMode ? 'Log ' + d.judges + ' test text' + (d.judges === 1 ? '' : 's') : 'Send ' + d.judges + ' text' + (d.judges === 1 ? '' : 's'), async () => {
      go.disabled = true; go.textContent = 'Sending...';
      try {
        sendState = { mode: 'result', data: await api(q('/api/admin/send-judging'), { body: { closeCheckin: closeBox.querySelector('input').checked } }) };
      } catch (e) { sendState = { mode: 'error', error: e.message }; }
      await refresh();
    }, 'primary');
    go.style.width = 'auto';
    bar.appendChild(go);
    bar.appendChild(button('Cancel', () => { sendState = null; render(); }));
    box.appendChild(bar);
    return box;
  }

  // Result
  const failed = d.results.filter(r => !r.ok);
  box.appendChild(el('<div class="msg ' + (failed.length ? 'error' : 'ok') + '"><b>' +
    (d.testMode ? 'Logged ' + d.texted + ' of ' + d.judges + ' test texts. Open the Texts tab to try the links.' : 'Sent ' + d.texted + ' of ' + d.judges + ' texts to Twilio.') + '</b>' +
    list(d.results.map(r => esc(r.name) + ': ' + esc(r.status))) + '</div>'));
  if (d.backups.length) box.appendChild(el('<div class="sub"><b>Backup judges placed:</b>' + list(d.backups.map(b => esc(b.name) + ' to ' + esc(b.category) + ' (' + esc(b.reason) + ')')) + '</div>'));
  if (!d.testMode && d.texted) box.appendChild(el('<p class="sub">Delivery reports from Twilio show up on the Texts tab (click "Check delivery").</p>'));
  if (warnings.length) box.appendChild(el('<div class="sub">' + list(warnings) + '</div>'));
  if (d.flagged) box.appendChild(el('<p class="sub">' + d.flagged + ' judging row(s) have a warning; see the Judging tab.</p>'));
  box.appendChild(close);
  return box;
}

function judges(v) {
  const cats = () => D.categories.filter(c => c.kind === 'judged').map(c => ({ id: c.id, name: c.display }));
  const bar = el('<div class="toolbar"></div>');
  bar.appendChild(button('+ Add judge', () => addRow('judges')));
  bar.appendChild(button('Import CSV', () => imp.classList.toggle('hidden')));
  bar.appendChild(button('Check in everyone', async () => {
    try { await api(q('/api/admin/checkin-all'), { body: { value: true } }); await refresh(); flash('Everyone is checked in.'); } catch (e) { fail(e); }
  }));
  bar.appendChild(button('Clear check-ins', async () => {
    try { await api(q('/api/admin/checkin-all'), { body: { value: false } }); await refresh(); flash('Check-ins cleared.'); } catch (e) { fail(e); }
  }));
  bar.appendChild(el('<span class="grow"></span>'));
  bar.appendChild(exportLink('judges'));
  v.appendChild(bar);
  const imp = el('<section class="card hidden"><h2>Import judges</h2><p class="sub">Paste a CSV, for example a Google Form export. Columns are found by name: Name, Email/Kerberos, Floor, Cell/Phone, Allergies/Dietary, Categories. Floors like "b3rd", phones and diets are cleaned up; judges with the same kerberos are updated.</p><textarea rows="6"></textarea><div class="toolbar" style="margin-top:8px"></div><pre class="report hidden"></pre></section>');
  imp.querySelector('.toolbar').appendChild(button('Import', async () => {
    try {
      const r = await api(q('/api/admin/import-judges'), { body: { csv: imp.querySelector('textarea').value } });
      await refresh();
      flash('Imported: ' + r.added + ' added, ' + r.updated + ' updated.' + (r.problems.length ? ' Check: ' + r.problems.join('; ') : ''), r.problems.length ? 'error' : 'ok');
    } catch (e) { fail(e); }
  }, 'primary'));
  v.appendChild(imp);
  const sentTo = new Set(D.judging.map(r => r.judge_id));
  editTable(v, 'judges', D.judges, [
    { key: 'checked_in', label: 'Here', type: 'bool' },
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'kerberos', label: 'Kerberos', type: 'text' },
    { key: 'floor', label: 'Floor', type: 'text', fmt: r => r.floor ? esc(r.floor) : '<span class="pill warn">?</span>' },
    { key: 'phone', label: 'Phone', type: 'text', fmt: r => /^\+\d{8,}$/.test(r.phone) ? esc(r.phone) : '<span class="pill warn">' + (esc(r.phone) || 'none') + '</span>' },
    { key: 'restrictions', label: 'Restrictions', type: 'text', fmt: r => r.tags.map(t => '<span class="pill' + (t === 'other' ? ' warn' : '') + '">' + esc(t) + '</span>').join('') },
    { key: 'restriction_details', label: 'Diet notes', type: 'text' },
    { key: 'preferred', label: 'Asked for', type: 'ids', options: cats, fmt: r => r.preferred.map(id => '<span class="pill">' + esc(catName(id)) + '</span>').join('') },
    { key: 'assigned', label: 'Assigned', type: 'ids', options: cats, fmt: r => r.assigned.length ? r.assigned.map(id => '<span class="pill' + (r.preferred.includes(id) ? ' good' : '') + '">' + esc(catName(id)) + '</span>').join('') : '<span class="sub">backup</span>' },
    { key: 'locked', label: 'Lock', type: 'bool' },
    { key: 'skip_tiebreak', label: 'No tiebreaks', type: 'bool' },
  ], {
    actions: r => {
      const out = [];
      const copy = button('Link', () => { navigator.clipboard && navigator.clipboard.writeText(D.origin + '/j/' + r.token); flash('Copied ' + r.name + '\'s judging link.'); }, 'link-btn');
      copy.title = D.origin + '/j/' + r.token;
      out.push(copy, el('<span> · </span>'));
      if (sentTo.has(r.id)) {
        out.push(button('Re-send', async () => {
          try { const x = await api(q('/api/admin/resend/' + r.id), { body: {} }); await refresh(); flash(r.name + ': ' + x.status + (x.added ? ' (' + x.added + ' new categor' + (x.added === 1 ? 'y' : 'ies') + ')' : '')); } catch (e) { fail(e); }
        }, 'link-btn'), el('<span> · </span>'));
      }
      out.push(deleteButton('judges', r.id));
      return out;
    },
  });
  v.appendChild(el('<p class="sub">Click a cell to edit. Green categories are ones the judge asked for. Judges with no category are backups. "Here" means checked in at the event; only checked-in judges get texts, and after judging starts, ticking it texts them right away. "Link" copies the judge\'s personal judging link.</p>'));
}

function dishes(v) {
  const cats = () => D.categories.filter(c => c.kind === 'judged').map(c => ({ id: c.id, name: c.display }));
  const bar = el('<div class="toolbar"></div>');
  bar.appendChild(button('+ Add dish', () => addRow('entries', { name: 'New baker' })));
  bar.appendChild(el('<span class="grow"></span>'));
  bar.appendChild(exportLink('entries'));
  v.appendChild(bar);
  editTable(v, 'entries', D.entries, [
    { key: 'number', label: '#', type: 'int' },
    { key: 'dish', label: 'Dish', type: 'text' },
    { key: 'name', label: 'Baker', type: 'text' },
    { key: 'kerberos', label: 'Kerberos', type: 'text' },
    { key: 'floor', label: 'Floor', type: 'text' },
    { key: 'categories', label: 'Category', type: 'ids', options: cats, fmt: r => r.categories.map(id => '<span class="pill">' + esc(catName(id)) + '</span>').join('') },
  ], { actions: r => [deleteButton('entries', r.id)] });
}

function judging(v) {
  v.appendChild(el('<p class="sub" style="margin-top:0">One row per judge per category, created when judging starts. Tiebreak rows are added automatically. You can type a pick for a judge who tells you in person. To take a judge off a category, change their Assigned categories on the Judges tab.</p>'));
  const rows = D.judging.slice().sort((a, b) => catName(a.category_id).localeCompare(catName(b.category_id)) || a.id - b.id);
  editTable(v, 'judging', rows, [
    { key: 'category', label: 'Category', get: r => catName(r.category_id) },
    { key: 'judge', label: 'Judge', get: r => judgeName(r.judge_id) },
    { key: 'role', label: 'Role' },
    { key: 'entries', label: 'Dishes', get: r => r.entries.map(n => '#' + n).join(', ') },
    { key: 'pick', label: 'Pick', type: 'int', fmt: r => r.pick !== null ? '<b>#' + r.pick + '</b>'
      : r.recheck ? '<span class="pill warn">re-checking (was #' + r.previous + ')</span>'
        : (r.closed ? '<span class="muted">closed</span>' : '<span class="pill warn">waiting</span>') },
    { key: 'flags', label: 'Notes', type: 'text' },
  ], { actions: r => [deleteButton('judging', r.id)] });
}

function votes(v) {
  const special = D.categories.filter(c => c.kind === 'special');
  const add = el('<section class="card"><h2>Add a tally</h2><p class="sub" style="margin-top:0">For paper ballots, or a single pick like GRA\'s Choice.</p>' +
    '<div class="toolbar"><select style="max-width:240px">' + special.map(c => '<option value="' + c.id + '">' + esc(c.display) + '</option>').join('') + '</select>' +
    '<input type="number" placeholder="Dish #" style="max-width:110px"><input type="number" placeholder="Votes" value="1" style="max-width:100px"></div></section>');
  add.querySelector('.toolbar').appendChild(button('Add', async () => {
    const [sel, num, cnt] = add.querySelectorAll('select, input');
    if (!num.value) return fail(new Error('Type the dish number.'));
    await addRow('votes', { category_id: sel.value, entry: num.value, votes: cnt.value || 1, source: 'paper' });
  }, 'primary'));
  v.appendChild(add);
  const tally = el('<section class="card"><h2>Standings</h2></section>');
  special.forEach(c => {
    const counts = {};
    D.votes.filter(x => x.category_id === c.id).forEach(x => { counts[x.entry] = (counts[x.entry] || 0) + x.votes; });
    const top = Object.keys(counts).map(k => [Number(k), counts[k]]).sort((a, b) => b[1] - a[1]).slice(0, 5);
    tally.appendChild(el('<div style="margin:8px 0"><b>' + esc(c.display) + '</b> <span class="sub">' +
      (top.length ? top.map(([n, k]) => '#' + n + ' (' + k + ')').join(', ') : 'no votes yet') + '</span></div>'));
  });
  v.appendChild(tally);
  const bar = el('<div class="toolbar"><span class="grow"></span></div>');
  bar.appendChild(exportLink('votes'));
  v.appendChild(bar);
  editTable(v, 'votes', D.votes.slice().reverse(), [
    { key: 'created_at', label: 'Time', get: r => new Date(r.created_at).toLocaleString() },
    { key: 'category_id', label: 'Category', get: r => catName(r.category_id) },
    { key: 'entry', label: 'Dish #', type: 'int' },
    { key: 'votes', label: 'Votes', type: 'int' },
    { key: 'source', label: 'Source' },
  ], { actions: r => [deleteButton('votes', r.id)] });
}

function results(v) {
  const c = D.computed;
  const bar = el('<div class="toolbar"><span class="grow"></span></div>');
  bar.appendChild(exportLink('results', 'Download results CSV'));
  v.appendChild(bar);
  const t = el('<div class="scroll"><table class="edit"><thead><tr><th>Category</th><th>Place</th><th>#</th><th>Dish</th><th>Baker</th><th>Kerberos</th><th>Floor</th><th>Decided by</th><th>Override #</th></tr></thead><tbody></tbody></table></div>');
  const tb = t.querySelector('tbody');
  const empty = c.results.filter(r => r.how === 'No entries');
  c.results.filter(r => r.how !== 'No entries').forEach(r => {
    const tr = el('<tr><td>' + esc(r.category) + '</td><td>' + (r.place === 1 ? '1st' : r.place === 2 ? 'Runner-up' : r.place) + '</td><td><b>' +
      (r.entry ? '#' + r.entry : '') + '</b></td><td>' + esc(r.dish) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.kerberos) + '</td><td>' + esc(r.floor) +
      '</td><td class="' + (r.status === 'pending' ? 'prize' : 'muted') + '">' + esc(r.how) + '</td><td></td></tr>');
    const input = el('<input type="number" style="max-width:90px" placeholder="—">');
    input.value = r.override || '';
    input.addEventListener('change', async () => {
      try { await api(q('/api/admin/override'), { body: { categoryId: r.categoryId, place: r.place, entry: input.value || null } }); await refresh(); } catch (e) { fail(e); }
    });
    tr.lastChild.appendChild(input);
    tb.appendChild(tr);
  });
  v.appendChild(t);
  if (empty.length) v.appendChild(el('<p class="sub">No dishes in: ' + esc(empty.map(r => r.category).join(', ')) + '.</p>'));
  v.appendChild(el('<p class="sub">Type a dish number in "Override #" to pick a winner yourself; clear it to go back to the judges\' or voters\' choice.</p>'));
  const row = el('<div class="row"></div>');
  row.appendChild(el('<section class="card"><h2>Floor standings</h2><table><thead><tr><th>Rank</th><th>Floor</th><th>Wins</th><th></th></tr></thead><tbody>' +
    c.standings.map(s => '<tr><td>' + s.rank + '</td><td>' + esc(s.floor) + '</td><td>' + s.wins + '</td><td class="prize">' + (s.prize ? 'Prize' : '') + '</td></tr>').join('') +
    '</tbody></table></section>'));
  const k = el('<section class="card"><h2>Winners\' kerberos (' + c.winnerKerberos.length + ')</h2><textarea rows="8" readonly></textarea></section>');
  k.querySelector('textarea').value = c.winnerKerberos.map(x => x.includes('@') ? x : x + '@mit.edu').join('\n');
  row.appendChild(k);
  v.appendChild(row);
}

function categories(v) {
  v.appendChild(el('<p class="sub" style="margin-top:0">Write <code>{ingredient}</code> where the special ingredient goes ("Craziest {ingredient}"). It is set on the Settings tab: currently <b>' + esc(D.settings.ingredient) + '</b>. "OK for" lists the restrictions a category is safe for (' + esc(D.restrictionOptions.join(', ')) + ', or all); judges with a restriction only get categories that list it.</p>'));
  const judged = D.categories.filter(c => c.kind === 'judged');
  const special = D.categories.filter(c => c.kind === 'special');
  v.appendChild(el('<h2>Judged categories</h2>'));
  const b1 = el('<div class="toolbar"></div>');
  b1.appendChild(button('+ Add judged category', () => addRow('categories', { kind: 'judged' })));
  v.appendChild(b1);
  editTable(v, 'categories', judged, [
    { key: 'name', label: 'Name', type: 'text', fmt: r => esc(r.name) + (r.name !== r.display ? ' <span class="sub">→ ' + esc(r.display) + '</span>' : '') },
    { key: 'active', label: 'Active', type: 'bool' },
    { key: 'ok_for', label: 'OK for', type: 'text' },
    { key: 'sort', label: 'Order', type: 'int' },
    { key: 'notes', label: 'Notes', type: 'text' },
  ], { actions: r => [deleteButton('categories', r.id)] });
  v.appendChild(el('<h2 style="margin-top:24px">Special awards (voted)</h2>'));
  const b2 = el('<div class="toolbar"></div>');
  b2.appendChild(button('+ Add special award', () => addRow('categories', { kind: 'special', web_voting: 1 })));
  v.appendChild(b2);
  editTable(v, 'categories', special, [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'active', label: 'Active', type: 'bool' },
    { key: 'web_voting', label: 'On voting page', type: 'bool' },
    { key: 'places', label: 'Places', type: 'int' },
    { key: 'counts', label: 'Counts for floors', type: 'bool' },
    { key: 'sort', label: 'Order', type: 'int' },
    { key: 'notes', label: 'Notes', type: 'text' },
  ], { actions: r => [deleteButton('categories', r.id)] });
}

const SETTINGS = [
  ['ingredient', 'Special ingredient', 'Replaces {ingredient} in category names.'],
  ['floors', 'Floors', 'Floors that compete for floor prizes, comma separated.'],
  ['other_groups', 'Other entrant groups', 'Can enter dishes but never count toward floor prizes.'],
  ['judges_per_category', 'Judges per category', ''],
  ['max_categories_per_judge', 'Max categories per judge', 'Raised by one for a few judges only if a category would be short.'],
  ['cojudges_different_floors', 'Co-judges on different floors', 'true or false.'],
  ['avoid_own_floor', 'Avoid own-floor dishes', 'true flags (and keeps tiebreakers away from) judges whose floor has dishes in the category.'],
  ['tiebreak_method', 'Tiebreak method', '"third judge" or "ask judges".', ['third judge', 'ask judges']],
  ['entry_numbers', 'Entry numbers', '"auto" hands out the next number; "manual" means typing the number already on the tape.', ['auto', 'manual']],
  ['first_entry_number', 'First entry number', ''],
  ['max_categories_per_dish', 'Max categories per dish', ''],
  ['checkin_pin', 'Check-in PIN', 'For the entry-table laptop.'],
  ['top_floors', 'Floors that win a prize', ''],
  ['special_counts', 'Special awards count toward floors', 'true or false. Each award can also opt out on the Categories tab.'],
  ['twilio_from', 'Twilio phone number', 'The number you bought in Twilio, like +16175551234.'],
  ['organizer_phone', 'Organizer phone', 'Optional. Gets a text if a tie has no free tiebreaker.'],
];

function settings(v) {
  const card = el('<section class="card"></section>');
  const name = el('<div><label>Event name</label><input type="text"></div>');
  name.querySelector('input').value = D.event.name;
  card.appendChild(name);
  SETTINGS.forEach(([k, label, note, options]) => {
    const f = el('<div><label>' + esc(label) + '</label></div>');
    const input = options ? el('<select>' + options.map(o => '<option>' + esc(o) + '</option>').join('') + '</select>') : el('<input type="text">');
    input.value = D.settings[k] === undefined ? '' : D.settings[k];
    input.dataset.key = k;
    f.appendChild(input);
    if (note) f.appendChild(el('<div class="sub">' + esc(note) + '</div>'));
    card.appendChild(f);
  });
  card.appendChild(el('<div style="height:14px"></div>'));
  card.appendChild(button('Save settings', async () => {
    const values = {};
    card.querySelectorAll('[data-key]').forEach(i => { values[i.dataset.key] = i.value; });
    try {
      await api(q('/api/admin/settings'), { method: 'PUT', body: { values } });
      const newName = name.querySelector('input').value.trim();
      if (newName && newName !== D.event.name) await api('/api/admin/events/' + D.event.id, { method: 'PATCH', body: { name: newName } });
      await refresh();
      flash('Saved.');
    } catch (e) { fail(e); }
  }, 'primary'));
  v.appendChild(card);
}

let deliveryChecked = 0;
function texts(v) {
  v.appendChild(el('<p class="sub" style="margin-top:0">Every text the site sent or, in test mode, would have sent. In test mode you can open the judging links here to try them. ' +
    '"Waiting for delivery report" means Twilio accepted it; click Check delivery to ask Twilio whether it reached the phone.</p>'));
  const bar = el('<div class="toolbar"><span class="grow"></span></div>');
  const check = button('Check delivery', async () => {
    check.disabled = true; check.textContent = 'Checking...';
    try { const r = await api(q('/api/admin/check-delivery'), { body: {} }); deliveryChecked = Date.now(); await refresh(); flash('Checked ' + r.checked + ' text' + (r.checked === 1 ? '' : 's') + ' with Twilio.'); }
    catch (e) { fail(e); check.disabled = false; check.textContent = 'Check delivery'; }
  });
  bar.insertBefore(check, bar.firstChild);
  v.appendChild(bar);
  const linkify = s => esc(s).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
  editTable(v, 'sms_log', D.log, [
    { key: 'at', label: 'Time', get: r => new Date(r.at).toLocaleString() },
    { key: 'name', label: 'To' },
    { key: 'phone', label: 'Phone' },
    { key: 'body', label: 'Message', fmt: r => linkify(r.body) },
    { key: 'status', label: 'Status', fmt: r => '<span class="pill ' + ({ good: 'good', bad: 'warn', pending: '' })[statusClass(r.status)] + '">' + esc(r.status) + '</span>' },
  ]);
  // Ask Twilio once when the tab opens if some texts are still waiting.
  if (D.log.some(r => r.sid && /waiting|^sent$/.test(r.status)) && Date.now() - deliveryChecked > 20000) {
    deliveryChecked = Date.now();
    api(q('/api/admin/check-delivery'), { body: {} }).then(r => { if (r.checked && tab === 'texts') refresh(); }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Header actions
// ---------------------------------------------------------------------------

$('loginBtn').addEventListener('click', async () => {
  try { await api('/api/admin/login', { body: { password: $('password').value } }); await refresh(); } catch (e) { showMsg($('loginMsg'), e.message); }
});
$('password').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });
$('logout').addEventListener('click', async () => { await api('/api/logout', { body: {} }).catch(() => {}); location.reload(); });
$('eventPick').addEventListener('change', e => { viewEvent = Number(e.target.value); refresh(); });
$('makeLive').addEventListener('click', async () => {
  try { await api('/api/admin/events/' + D.event.id + '/activate', { body: {} }); await refresh(); flash(D.event.name + ' is now the live event.'); } catch (e) { fail(e); }
});
$('newEventBtn').addEventListener('click', () => { $('newEvent').classList.toggle('hidden'); $('neName').focus(); });
$('neCancel').addEventListener('click', () => $('newEvent').classList.add('hidden'));
$('neCreate').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/events', { body: { name: $('neName').value, ingredient: $('neIngredient').value, copyFrom: $('neCopy').value } });
    $('newEvent').classList.add('hidden');
    viewEvent = r.id;
    tab = 'categories';
    await refresh();
    flash('Created. Check the categories below, then share the judge signup link.');
  } catch (e) { showMsg($('neMsg'), e.message); }
});
document.addEventListener('click', e => {
  const pop = document.querySelector('.popover');
  if (pop && !pop.contains(e.target) && !e.target.closest('td.cell')) pop.remove();
});

refresh();
