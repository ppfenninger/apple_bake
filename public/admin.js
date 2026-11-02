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
    '<div class="stat"><b>' + D.judges.length + '</b>judges</div>' +
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
  if (!D.twilioReady) sw.appendChild(el('<p class="sub">Twilio secrets are not set yet, so real texts can\'t go out. See the README.</p>'));

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
        if (r.unassigned.length) lines.push('', 'Not needed (tiebreaker pool): ' + r.unassigned.join(', '));
        if (r.noFloor.length) lines.push('', 'Unknown floor, so the floor rule could not be checked: ' + r.noFloor.join(', '));
        await refresh();
        const rep = $('view').querySelector('pre.report');
        rep.textContent = lines.join('\n');
        rep.classList.remove('hidden');
      } catch (e) { fail(e); }
    }, 'primary'));
  const closeBox = el('<label class="switch" style="padding:0;font-size:14px"><input type="checkbox"> Also close check-in</label>');
  const sendBtn = button('Start judging: text the judges', async () => {
    if (!sendBtn.dataset.armed) {
      sendBtn.dataset.armed = '1';
      sendBtn.textContent = /^true$/i.test(s.test_mode) ? 'Sure? (test mode: nothing is texted)' : 'Sure? Real texts will go out';
      return;
    }
    try {
      const r = await api(q('/api/admin/send-judging'), { body: { closeCheckin: closeBox.querySelector('input').checked } });
      const lines = [(r.testMode ? 'Test mode: logged ' : 'Texted ') + r.texted + ' of ' + r.judges + ' judges. ' + (r.testMode ? 'Open the Texts tab to try the links yourself.' : '')];
      if (r.gaps.length) lines.push('', 'Dishes but no judge (assign someone, then use Re-send on the Judges tab):', ...r.gaps.map(g => '  ' + g));
      if (r.autoWon.length) lines.push('', 'Won automatically (only one dish): ' + r.autoWon.join(', '));
      if (r.flagged) lines.push('', r.flagged + ' judging row(s) have a warning; see the Judging tab.');
      await refresh();
      const rep = $('view').querySelector('pre.report');
      rep.textContent = lines.join('\n');
      rep.classList.remove('hidden');
    } catch (e) { fail(e); }
  }, 'primary');
  const sendWrap = el('<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start"></div>');
  sendWrap.appendChild(sendBtn);
  sendWrap.appendChild(closeBox);
  step('3. Start judging', 'Texts each assigned judge a personal link listing their dish numbers. Check-in can stay open: a dish checked in later is added to its category and those judges get a text. Running it again only texts judges who haven\'t been texted.', sendWrap);
  step('4. Watch it come in', 'Ties go to a third judge automatically. Add paper tallies on the Votes tab, fix anything on the Results tab, then turn on "Results are public".');
  steps.appendChild(report);

  const row = el('<div class="row"></div>');
  row.appendChild(sw);
  row.appendChild(steps);
  v.appendChild(row);

  if (pending.length) {
    v.appendChild(el('<section class="card"><h2>Still waiting</h2><table><tbody>' +
      pending.map(r => '<tr><td>' + esc(r.category) + '</td><td class="muted">' + esc(r.how) + '</td></tr>').join('') + '</tbody></table></section>'));
  }

  const links = el('<section class="card"><h2>Links</h2></section>');
  const o = D.origin;
  [['Voting (print the QR for the tables)', '/vote'], ['Results', '/results'], ['Judge signup', '/signup'],
    ['Check-in (entry-table laptop) · PIN ' + s.checkin_pin, '/checkin'], ['Home', '/']].forEach(([label, path]) => {
    const r = el('<div style="margin:8px 0"><div class="sub">' + esc(label) + '</div><a href="' + path + '" target="_blank">' + esc(o + path) + '</a></div>');
    links.appendChild(r);
  });
  const qrBox = el('<div class="qr" id="voteQr"></div>');
  links.appendChild(qrBox);
  try { new QRCode(qrBox, { text: o + '/vote', width: 160, height: 160 }); } catch (e) { qrBox.remove(); }
  const test = el('<div style="margin-top:14px"><label>Send a test text</label><div class="toolbar"><input type="tel" placeholder="617-555-1234" style="max-width:220px"></div></div>');
  test.querySelector('.toolbar').appendChild(button('Send for real', async () => {
    try {
      const r = await api(q('/api/admin/test-sms'), { body: { to: test.querySelector('input').value, real: true } });
      flash('Test text: ' + r.status, r.ok ? 'ok' : 'error');
    } catch (e) { fail(e); }
  }));
  links.appendChild(test);
  v.appendChild(links);
}

function judges(v) {
  const cats = () => D.categories.filter(c => c.kind === 'judged').map(c => ({ id: c.id, name: c.display }));
  const bar = el('<div class="toolbar"></div>');
  bar.appendChild(button('+ Add judge', () => addRow('judges')));
  bar.appendChild(button('Import CSV', () => imp.classList.toggle('hidden')));
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
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'kerberos', label: 'Kerberos', type: 'text' },
    { key: 'floor', label: 'Floor', type: 'text', fmt: r => r.floor ? esc(r.floor) : '<span class="pill warn">?</span>' },
    { key: 'phone', label: 'Phone', type: 'text', fmt: r => /^\+\d{8,}$/.test(r.phone) ? esc(r.phone) : '<span class="pill warn">' + (esc(r.phone) || 'none') + '</span>' },
    { key: 'restrictions', label: 'Restrictions', type: 'text', fmt: r => r.tags.map(t => '<span class="pill' + (t === 'other' ? ' warn' : '') + '">' + esc(t) + '</span>').join('') },
    { key: 'restriction_details', label: 'Diet notes', type: 'text' },
    { key: 'preferred', label: 'Asked for', type: 'ids', options: cats, fmt: r => r.preferred.map(id => '<span class="pill">' + esc(catName(id)) + '</span>').join('') },
    { key: 'assigned', label: 'Assigned', type: 'ids', options: cats, fmt: r => r.assigned.map(id => '<span class="pill' + (r.preferred.includes(id) ? ' good' : '') + '">' + esc(catName(id)) + '</span>').join('') },
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
  v.appendChild(el('<p class="sub">Click a cell to edit. Green categories are ones the judge asked for. "Link" copies the judge\'s personal judging link.</p>'));
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

function texts(v) {
  v.appendChild(el('<p class="sub" style="margin-top:0">Every text the site sent or, in test mode, would have sent. In test mode you can open the judging links here to try them.</p>'));
  const linkify = s => esc(s).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
  editTable(v, 'sms_log', D.log, [
    { key: 'at', label: 'Time', get: r => new Date(r.at).toLocaleString() },
    { key: 'name', label: 'To' },
    { key: 'phone', label: 'Phone' },
    { key: 'body', label: 'Message', fmt: r => linkify(r.body) },
    { key: 'status', label: 'Status', fmt: r => '<span class="pill' + (/^(sent|TEST)/.test(r.status) ? '' : ' warn') + '">' + esc(r.status) + '</span>' },
  ]);
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
