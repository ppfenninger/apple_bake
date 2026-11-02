// Cloudflare Worker: JSON API for the pages in /public.
import {
  RESTRICTIONS, splitList, truthy, normalizeFloor, normalizePhone, kerberosOf, hasMultipleKerberos, parseRestrictions, matchCategory,
  parseCsv, toCsv,
} from './logic.js';
import {
  ensureSchema, activeEventId, getEvent, getSettings, setSettings, loadEvent, createEvent, now, randomToken, settingBool, settingNum,
} from './db.js';
import { runAssignment, sendJudging, syncJudging, resendJudge, judgeView, submitPicks, computeResults, sendSms, checkDelivery, twilioState, checkInJudge } from './competition.js';
import { makeCookie, clearCookie, sessionRole, safeEqual } from './auth.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(init.headers || {}) },
});

async function body(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

function floorsOf(settings) {
  return { floors: splitList(settings.floors), others: splitList(settings.other_groups) };
}

function judgedCats(data) {
  return data.categories.filter(c => c.kind === 'judged' && c.active);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler, role) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, role });
};

// --- public -----------------------------------------------------------------

route('GET', '/api/info', async ({ env, eventId }) => {
  const [event, s] = await Promise.all([getEvent(env.DB, eventId), getSettings(env.DB, eventId)]);
  return {
    eventName: event.name, ingredient: s.ingredient, signupOpen: truthy(s.signup_open), votingOpen: truthy(s.voting_open),
    checkinOpen: truthy(s.checkin_open), resultsPublic: truthy(s.results_public),
  };
});

route('GET', '/api/signup', async ({ env, eventId }) => {
  const data = await loadEvent(env.DB, eventId);
  const fl = floorsOf(data.settings);
  return {
    eventName: data.event.name, open: truthy(data.settings.signup_open), floors: fl.floors.concat(fl.others),
    categories: judgedCats(data).map(c => ({ id: c.id, name: c.display })), restrictions: RESTRICTIONS,
  };
});

route('POST', '/api/signup', async ({ env, eventId, request }) => {
  const d = await body(request);
  const data = await loadEvent(env.DB, eventId);
  if (!truthy(data.settings.signup_open)) fail(400, 'Judge signup is closed.');
  const fl = floorsOf(data.settings);
  const name = String(d.name || '').trim().slice(0, 100);
  const kerberos = kerberosOf(d.email);
  const phone = normalizePhone(d.phone);
  if (!name) fail(400, 'Please enter your name.');
  if (!kerberos) fail(400, 'Please enter your MIT email or kerberos.');
  if (hasMultipleKerberos(d.email)) fail(400, 'Please enter just one email or kerberos.');
  if (!fl.floors.concat(fl.others).includes(d.floor)) fail(400, 'Please pick your floor.');
  if (!phone) fail(400, 'Please enter a 10-digit cell number.');
  const catIds = judgedCats(data).map(c => c.id);
  const prefs = (d.prefs || []).map(Number).filter(id => catIds.includes(id));
  const tags = (d.restrictions || []).filter(t => RESTRICTIONS.includes(t));
  const details = String(d.details || '').trim().slice(0, 300);
  if (details && parseRestrictions(details).includes('other')) tags.push('other');
  const existing = data.judges.find(j => j.kerberos === kerberos);
  if (existing) {
    await env.DB.prepare('UPDATE judges SET name = ?, floor = ?, phone = ?, restrictions = ?, restriction_details = ?, preferred = ? WHERE id = ?')
      .bind(name, d.floor, phone, tags.join(', '), details, JSON.stringify(prefs), existing.id).run();
  } else {
    await env.DB.prepare(`INSERT INTO judges (event_id, name, kerberos, floor, phone, restrictions, restriction_details, preferred, token, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(eventId, name, kerberos, d.floor, phone, tags.join(', '), details, JSON.stringify(prefs), randomToken(), now()).run();
  }
  return { updated: !!existing };
});

// --- judge check-in (at the event, honor system) ---------------------------------

route('GET', '/api/judge-checkin', async ({ env, eventId, url }) => {
  const event = await getEvent(env.DB, eventId);
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return { eventName: event.name, judges: [] };
  const rows = (await env.DB.prepare('SELECT id, name, kerberos, floor, checked_in FROM judges WHERE event_id = ? ORDER BY name').bind(eventId).all()).results;
  const words = q.split(/\s+/);
  const judges = rows.filter(j => words.every(w => j.name.toLowerCase().includes(w) || j.kerberos.toLowerCase() === w))
    .slice(0, 10).map(j => ({ id: j.id, name: j.name, floor: j.floor, here: !!j.checked_in }));
  return { eventName: event.name, judges };
});

route('POST', '/api/judge-checkin', async ({ env, eventId, request, url }) => {
  const d = await body(request);
  const r = await checkInJudge(env, eventId, Number(d.id), url.origin);
  if (r.error) fail(404, 'We couldn\'t find that judge. Ask the organizer to add you.');
  const res = (r.results || [])[0];
  let message;
  if (!r.started) message = 'You\'ll get a text with your judging link when judging starts.';
  else if (res && res.ok) message = 'Judging has started, so we just texted you your judging link.';
  else if (res) message = 'Judging has started, but your text didn\'t go out. Please find the organizer.';
  else message = 'Judging has started. You\'re on the backup list for now; you\'ll get a text if you\'re needed.';
  return { name: r.name, started: r.started, message };
});

route('GET', '/api/vote', async ({ env, eventId }) => {
  const data = await loadEvent(env.DB, eventId);
  return {
    eventName: data.event.name, open: truthy(data.settings.voting_open),
    categories: data.categories.filter(c => c.kind === 'special' && c.active && c.web_voting).map(c => ({ id: c.id, name: c.display })),
  };
});

route('POST', '/api/vote', async ({ env, eventId, request }) => {
  const d = await body(request);
  const data = await loadEvent(env.DB, eventId);
  if (!truthy(data.settings.voting_open)) fail(400, 'Voting is closed.');
  const cat = data.categories.find(c => c.id === Number(d.categoryId) && c.kind === 'special' && c.active && c.web_voting);
  if (!cat) fail(400, 'Pick a category.');
  const n = Number(String(d.entry || '').replace(/\D/g, ''));
  const entry = data.entries.find(e => e.number === n);
  if (!entry) fail(400, 'There is no dish #' + (n || '?') + '. Check the number on the tape.');
  await env.DB.prepare("INSERT INTO votes (event_id, category_id, entry, votes, source, created_at) VALUES (?, ?, ?, 1, 'web', ?)")
    .bind(eventId, cat.id, n, now()).run();
  return { number: n, dish: entry.dish, category: cat.display };
});

route('GET', '/api/results', async ({ env, eventId, url }) => {
  // Past events' results are public by id; the current one only once published.
  const asked = Number(url.searchParams.get('event')) || eventId;
  const data = await loadEvent(env.DB, asked);
  if (!data.event) fail(404, 'No such event.');
  const events = (await env.DB.prepare('SELECT id, name FROM events ORDER BY id DESC').all()).results;
  const isPublic = asked !== eventId || truthy(data.settings.results_public);
  if (!isPublic) return { public: false, eventName: data.event.name, events: events.filter(e => e.id !== eventId) };
  const r = computeResults(data);
  return {
    public: true, eventName: data.event.name, eventId: asked, complete: r.complete,
    events: events.filter(e => e.id !== eventId || truthy(data.settings.results_public) || asked === e.id),
    results: r.results.filter(x => x.status !== 'none').map(x => ({
      category: x.category, type: x.type, place: x.place, entry: x.entry, dish: x.dish, name: x.name, floor: x.floor, decided: x.status === 'decided',
    })),
    standings: r.standings.filter(s => s.wins > 0).map(s => ({ rank: s.rank, floor: s.floor, wins: s.wins, prize: s.prize })),
  };
});

// --- judge links ---------------------------------------------------------------

route('GET', '/api/judge/:token', async ({ env, params }) => {
  const v = await judgeView(env, params.token);
  if (!v) fail(404, 'This judging link is not valid. Ask an organizer to re-send it.');
  return v;
});

route('POST', '/api/judge/:token', async ({ env, params, request, url }) => {
  const d = await body(request);
  const r = await submitPicks(env, params.token, d.picks, url.origin);
  if (r.error) fail(404, r.error);
  return { ...r, view: await judgeView(env, params.token) };
});

// --- check-in -----------------------------------------------------------------

route('POST', '/api/checkin/login', async ({ env, eventId, request }) => {
  const d = await body(request);
  if (!env.ADMIN_PASSWORD) fail(500, 'The site is missing its ADMIN_PASSWORD secret. See the README.');
  const s = await getSettings(env.DB, eventId);
  await new Promise(r => setTimeout(r, 300)); // slows down guessing
  if (!s.checkin_pin || !safeEqual(String(d.pin || '').trim(), String(s.checkin_pin).trim())) fail(401, 'Wrong PIN.');
  return json({ ok: true }, { headers: { 'Set-Cookie': await makeCookie(env, 'checkin', 12) } });
});

route('GET', '/api/checkin', async ({ env, eventId }) => {
  const data = await loadEvent(env.DB, eventId);
  const fl = floorsOf(data.settings);
  const catName = id => (data.categories.find(c => c.id === id) || {}).display || '?';
  return {
    eventName: data.event.name, open: truthy(data.settings.checkin_open),
    categories: judgedCats(data).map(c => ({ id: c.id, name: c.display })),
    floors: fl.floors.concat(fl.others),
    maxPerDish: Math.max(1, settingNum(data.settings, 'max_categories_per_dish', 1)),
    manualNumbers: /manual/i.test(data.settings.entry_numbers),
    count: data.entries.length,
    recent: data.entries.slice().sort((a, b) => b.id - a.id).slice(0, 10)
      .map(e => ({ number: e.number, dish: e.dish, name: e.name, floor: e.floor, categories: e.categories.map(catName) })),
  };
}, 'checkin');

route('POST', '/api/checkin', async ({ env, eventId, request, url }) => {
  const d = await body(request);
  const data = await loadEvent(env.DB, eventId);
  const s = data.settings;
  if (!truthy(s.checkin_open)) fail(400, 'Check-in is closed.');
  const fl = floorsOf(s);
  const name = String(d.name || '').trim().slice(0, 100);
  const kerberos = kerberosOf(d.kerberos);
  const floor = String(d.floor || '').trim();
  if (!name) fail(400, "Please enter the baker's name.");
  if (!fl.floors.concat(fl.others).includes(floor)) fail(400, 'Please pick a floor.');
  const cats = judgedCats(data);
  const maxPer = Math.max(1, settingNum(s, 'max_categories_per_dish', 1));
  const manual = /manual/i.test(s.entry_numbers);
  const dishes = (d.dishes || []).filter(x => x && (String(x.dish || '').trim() || (x.categories || []).length));
  if (!dishes.length) fail(400, 'Add at least one dish.');
  dishes.forEach((x, i) => {
    if (!String(x.dish || '').trim()) fail(400, 'Dish ' + (i + 1) + ' needs a name.');
    x.categories = (x.categories || []).map(Number).filter(id => cats.some(c => c.id === id));
    if (!x.categories.length) fail(400, 'Pick a category for "' + x.dish + '".');
    if (x.categories.length > maxPer) fail(400, '"' + x.dish + '" can be in at most ' + maxPer + ' categor' + (maxPer === 1 ? 'y' : 'ies') + '.');
  });
  if (hasMultipleKerberos(d.kerberos)) fail(400, 'Only one kerberos per entry: the person who collects the prize. Put every name in the baker field.');
  if (!kerberos && fl.floors.includes(floor)) fail(400, 'Please enter a kerberos (we need it if they win a prize).');

  const used = data.entries.map(e => e.number);
  let next = Math.max(settingNum(s, 'first_entry_number', 1), used.length ? Math.max(...used) + 1 : 0);
  const rows = dishes.map(x => {
    let n;
    if (manual) {
      n = Number(x.number);
      if (!n || n < 1) fail(400, 'Type the number on the tape for "' + x.dish + '".');
      if (used.includes(n)) fail(400, '#' + n + ' is already used.');
    } else n = next++;
    used.push(n);
    return { number: n, dish: String(x.dish).trim().slice(0, 120), categories: x.categories };
  });
  try {
    await env.DB.batch(rows.map(r => env.DB.prepare(
      'INSERT INTO entries (event_id, number, dish, name, kerberos, floor, categories, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(eventId, r.number, r.dish, name, kerberos, floor, JSON.stringify(r.categories), now())));
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) fail(409, 'Someone else just took that number. Press Check in again.');
    throw e;
  }
  await syncJudging(env, eventId, url.origin); // late dishes reach judges who are already judging
  const catName = id => cats.find(c => c.id === id).display;
  return rows.map(r => ({ number: r.number, dish: r.dish, categories: r.categories.map(catName).join(', ') }));
}, 'checkin');

// --- admin --------------------------------------------------------------------

route('POST', '/api/admin/login', async ({ env, request }) => {
  const d = await body(request);
  if (!env.ADMIN_PASSWORD) fail(500, 'The site is missing its ADMIN_PASSWORD secret. See the README.');
  await new Promise(r => setTimeout(r, 400));
  if (!safeEqual(String(d.password || ''), env.ADMIN_PASSWORD)) fail(401, 'Wrong password.');
  return json({ ok: true }, { headers: { 'Set-Cookie': await makeCookie(env, 'admin', 24 * 7) } });
});

route('POST', '/api/logout', async () => json({ ok: true }, { headers: { 'Set-Cookie': clearCookie() } }));

route('GET', '/api/admin/data', async ({ env, viewId, eventId, url }) => {
  const data = await loadEvent(env.DB, viewId);
  const events = (await env.DB.prepare('SELECT id, name, created_at FROM events ORDER BY id DESC').all()).results;
  const log = (await env.DB.prepare('SELECT * FROM sms_log WHERE event_id = ? ORDER BY id DESC LIMIT 500').bind(viewId).all()).results;
  return {
    origin: url.origin, activeEventId: eventId, events, ...data, computed: computeResults(data), log,
    restrictionOptions: RESTRICTIONS, twilio: twilioState(env, data.settings),
  };
}, 'admin');

route('PUT', '/api/admin/settings', async ({ env, viewId, request }) => {
  const d = await body(request);
  await setSettings(env.DB, viewId, d.values || {});
  return { ok: true };
}, 'admin');

route('POST', '/api/admin/events', async ({ env, eventId, request }) => {
  const d = await body(request);
  const name = String(d.name || '').trim();
  if (!name) fail(400, 'Give the event a name, like "Potato Bake 2027".');
  const copyFrom = d.copyFrom === 'defaults' ? null : (Number(d.copyFrom) || eventId);
  const id = await createEvent(env.DB, { name, copyFrom, ingredient: String(d.ingredient || '').trim() || undefined });
  return { id };
}, 'admin');

route('POST', '/api/admin/events/:id/activate', async ({ env, params }) => {
  const ev = await getEvent(env.DB, Number(params.id));
  if (!ev) fail(404, 'No such event.');
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('active_event', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(ev.id)).run();
  return { ok: true };
}, 'admin');

route('PATCH', '/api/admin/events/:id', async ({ env, params, request }) => {
  const d = await body(request);
  const name = String(d.name || '').trim();
  if (!name) fail(400, 'Name cannot be empty.');
  await env.DB.prepare('UPDATE events SET name = ? WHERE id = ?').bind(name, Number(params.id)).run();
  return { ok: true };
}, 'admin');

route('POST', '/api/admin/assign', async ({ env, viewId }) => {
  const r = await runAssignment(env, viewId);
  if (r.error) fail(400, r.error);
  return r;
}, 'admin');

route('POST', '/api/admin/send-judging', async ({ env, viewId, request, url }) => {
  const d = await body(request);
  return sendJudging(env, viewId, url.origin, { restart: !!d.restart, closeCheckin: !!d.closeCheckin, dryRun: !!d.dryRun });
}, 'admin');

route('POST', '/api/admin/check-delivery', async ({ env, viewId, request }) => {
  const d = await body(request);
  return checkDelivery(env, viewId, d.id ? Number(d.id) : null);
}, 'admin');

route('POST', '/api/admin/checkin-all', async ({ env, viewId, request, url }) => {
  const d = await body(request);
  const value = d.value === false ? 0 : 1;
  await env.DB.prepare('UPDATE judges SET checked_in = ?, checked_in_at = CASE WHEN ? = 1 THEN COALESCE(checked_in_at, ?) ELSE NULL END WHERE event_id = ?')
    .bind(value, value, now(), viewId).run();
  await syncJudging(env, viewId, url.origin);
  return { ok: true };
}, 'admin');

route('POST', '/api/admin/resend/:judgeId', async ({ env, viewId, params, url }) => {
  const r = await resendJudge(env, viewId, Number(params.judgeId), url.origin);
  if (r.error) fail(404, r.error);
  return r;
}, 'admin');

route('POST', '/api/admin/test-sms', async ({ env, viewId, request }) => {
  const d = await body(request);
  const to = normalizePhone(d.to);
  if (!to) fail(400, 'Enter a 10-digit phone number.');
  const event = await getEvent(env.DB, viewId);
  const s = await getSettings(env.DB, viewId);
  return sendSms(env, viewId, { ...s, test_mode: d.real ? 'false' : s.test_mode }, to, `${event.name} test text. Texting works!`, 'Test');
}, 'admin');

route('POST', '/api/admin/override', async ({ env, viewId, request }) => {
  const d = await body(request);
  const cid = Number(d.categoryId), place = Number(d.place) || 1;
  if (d.entry === null || d.entry === '' || d.entry === undefined) {
    await env.DB.prepare('DELETE FROM overrides WHERE event_id = ? AND category_id = ? AND place = ?').bind(viewId, cid, place).run();
  } else {
    await env.DB.prepare('INSERT INTO overrides (event_id, category_id, place, entry) VALUES (?, ?, ?, ?) ON CONFLICT(event_id, category_id, place) DO UPDATE SET entry = excluded.entry')
      .bind(viewId, cid, place, Number(d.entry)).run();
  }
  return { ok: true };
}, 'admin');

route('POST', '/api/admin/import-judges', async ({ env, viewId, request }) => {
  const d = await body(request);
  const rows = parseCsv(d.csv);
  if (rows.length < 2) fail(400, 'Paste a CSV with a header row and at least one judge.');
  const head = rows[0].map(h => h.toLowerCase());
  const col = re => head.findIndex(h => re.test(h));
  const c = { name: col(/name/), email: col(/e-?mail|kerb/), floor: col(/floor/), phone: col(/cell|phone|number/), diet: col(/allerg|diet|restrict/), prefs: col(/categor/) };
  if (c.name < 0) fail(400, 'The CSV needs a "Name" column.');
  const data = await loadEvent(env.DB, viewId);
  const fl = floorsOf(data.settings);
  const cats = judgedCats(data).map(x => ({ id: x.id, name: x.display }));
  const problems = [];
  let added = 0, updated = 0;
  const stmts = [];
  rows.slice(1).forEach(r => {
    const get = i => (i >= 0 ? String(r[i] || '').trim() : '');
    const name = get(c.name);
    if (!name) return;
    const kerberos = kerberosOf(get(c.email));
    const floor = normalizeFloor(get(c.floor), fl.floors, fl.others);
    const phone = normalizePhone(get(c.phone));
    const details = get(c.diet);
    const tags = parseRestrictions(details);
    const prefs = splitList(get(c.prefs)).map(p => matchCategory(p, cats)).filter(Boolean).map(x => x.id);
    if (!floor) problems.push(name + ': floor "' + get(c.floor) + '"');
    if (!phone) problems.push(name + ': phone "' + get(c.phone) + '"');
    if (tags.includes('other')) problems.push(name + ': check diet "' + details + '"');
    const existing = kerberos && data.judges.find(j => j.kerberos === kerberos);
    if (existing) {
      updated++;
      stmts.push(env.DB.prepare('UPDATE judges SET name = ?, floor = ?, phone = ?, restrictions = ?, restriction_details = ?, preferred = ? WHERE id = ?')
        .bind(name, floor, phone, tags.join(', '), details, JSON.stringify(prefs), existing.id));
    } else {
      added++;
      stmts.push(env.DB.prepare(`INSERT INTO judges (event_id, name, kerberos, floor, phone, restrictions, restriction_details, preferred, token, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(viewId, name, kerberos, floor, phone, tags.join(', '), details, JSON.stringify(prefs), randomToken(), now()));
    }
  });
  if (stmts.length) await env.DB.batch(stmts);
  return { added, updated, problems };
}, 'admin');

// Generic row editing for the admin tables.
const TABLES = {
  judges: {
    cols: { name: 'text', kerberos: 'kerberos', floor: 'floor', phone: 'phone', restrictions: 'text', restriction_details: 'text',
      preferred: 'ids', assigned: 'ids', locked: 'bool', skip_tiebreak: 'bool', checked_in: 'bool' },
    insert: { name: 'New judge' }, extra: () => ({ token: randomToken(), created_at: now() }),
  },
  entries: {
    cols: { number: 'int', dish: 'text', name: 'text', kerberos: 'kerberos', floor: 'floor', categories: 'ids' },
    extra: () => ({ created_at: now() }),
  },
  categories: {
    cols: { kind: 'kind', name: 'text', active: 'bool', ok_for: 'text', web_voting: 'bool', places: 'int', counts: 'bool', sort: 'int', notes: 'text' },
    insert: { name: 'New category' },
  },
  judging: { cols: { pick: 'intOrNull', closed: 'bool', flags: 'text' }, noInsert: true },
  votes: { cols: { category_id: 'int', entry: 'int', votes: 'int', source: 'text', note: 'text' }, extra: () => ({ created_at: now() }) },
};

function coerce(type, v, settings) {
  const fl = floorsOf(settings);
  switch (type) {
    case 'bool': return truthy(v) ? 1 : 0;
    case 'int': { const n = parseInt(v, 10); if (!Number.isFinite(n)) fail(400, 'Expected a number.'); return n; }
    case 'intOrNull': return v === '' || v === null || v === undefined ? null : parseInt(v, 10);
    case 'ids': return JSON.stringify((Array.isArray(v) ? v : splitList(v)).map(Number).filter(Number.isFinite));
    case 'phone': return normalizePhone(v) || String(v || '').trim();
    case 'floor': return normalizeFloor(v, fl.floors, fl.others) || String(v || '').trim();
    case 'kerberos': return kerberosOf(v);
    case 'kind': return v === 'special' ? 'special' : 'judged';
    default: return String(v === null || v === undefined ? '' : v).slice(0, 500);
  }
}

// Dish or judge-assignment changes after judging started are pushed to the judges.
async function afterRowChange(env, viewId, table, url) {
  if (table === 'entries' || table === 'judges') await syncJudging(env, viewId, url.origin);
}

route('POST', '/api/admin/rows/:table', async ({ env, viewId, params, request, url }) => {
  const t = TABLES[params.table];
  if (!t || t.noInsert) fail(404, 'Unknown table.');
  const d = await body(request);
  const s = await getSettings(env.DB, viewId);
  const values = { ...(t.insert || {}), ...(d.values || {}) };
  const row = { event_id: viewId, ...(t.extra ? t.extra() : {}) };
  Object.keys(values).forEach(k => { if (t.cols[k]) row[k] = coerce(t.cols[k], values[k], s); });
  if (params.table === 'entries' && !row.number) {
    const max = await env.DB.prepare('SELECT MAX(number) AS m FROM entries WHERE event_id = ?').bind(viewId).first();
    row.number = (max.m || 0) + 1;
  }
  if (params.table === 'categories' && row.sort === undefined) {
    const max = await env.DB.prepare('SELECT MAX(sort) AS m FROM categories WHERE event_id = ?').bind(viewId).first();
    row.sort = (max.m || 0) + 10;
  }
  const keys = Object.keys(row);
  try {
    const r = await env.DB.prepare(`INSERT INTO ${params.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map(k => row[k])).run();
    await afterRowChange(env, viewId, params.table, url);
    return { id: r.meta.last_row_id };
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) fail(409, 'That number is already used.');
    throw e;
  }
}, 'admin');

route('PATCH', '/api/admin/rows/:table/:id', async ({ env, viewId, params, request, url }) => {
  const t = TABLES[params.table];
  if (!t) fail(404, 'Unknown table.');
  const d = await body(request);
  const s = await getSettings(env.DB, viewId);
  const sets = [], vals = [];
  Object.keys(d.values || {}).forEach(k => {
    if (!t.cols[k]) return;
    sets.push(k + ' = ?');
    vals.push(coerce(t.cols[k], d.values[k], s));
  });
  if (!sets.length) fail(400, 'Nothing to change.');
  try {
    await env.DB.prepare(`UPDATE ${params.table} SET ${sets.join(', ')} WHERE id = ? AND event_id = ?`).bind(...vals, Number(params.id), viewId).run();
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) fail(409, 'That number is already used.');
    throw e;
  }
  if (params.table === 'judges' && 'checked_in' in (d.values || {})) {
    await env.DB.prepare('UPDATE judges SET checked_in_at = CASE WHEN checked_in = 1 THEN COALESCE(checked_in_at, ?) ELSE NULL END WHERE id = ?').bind(now(), Number(params.id)).run();
  }
  if (params.table === 'judging' && 'pick' in (d.values || {})) {
    await env.DB.prepare('UPDATE judging SET recheck = 0, picked_at = ? WHERE id = ?').bind(now(), Number(params.id)).run();
  }
  await afterRowChange(env, viewId, params.table, url);
  return { ok: true };
}, 'admin');

route('DELETE', '/api/admin/rows/:table/:id', async ({ env, viewId, params, url }) => {
  if (!TABLES[params.table]) fail(404, 'Unknown table.');
  await env.DB.prepare(`DELETE FROM ${params.table} WHERE id = ? AND event_id = ?`).bind(Number(params.id), viewId).run();
  if (params.table === 'judges') await env.DB.prepare('DELETE FROM judging WHERE judge_id = ? AND event_id = ?').bind(Number(params.id), viewId).run();
  await afterRowChange(env, viewId, params.table, url);
  return { ok: true };
}, 'admin');

route('GET', '/api/admin/export/:what', async ({ env, viewId, params }) => {
  const data = await loadEvent(env.DB, viewId);
  const catName = id => (data.categories.find(c => c.id === id) || {}).display || id;
  let rows;
  const what = params.what.replace(/\.csv$/, '');
  if (what === 'judges') {
    rows = [['Name', 'Kerberos', 'Floor', 'Phone', 'Restrictions', 'Details', 'Preferred', 'Assigned']]
      .concat(data.judges.map(j => [j.name, j.kerberos, j.floor, j.phone, j.restrictions, j.restriction_details,
        j.preferred.map(catName).join('; '), j.assigned.map(catName).join('; ')]));
  } else if (what === 'entries') {
    rows = [['Entry #', 'Dish', 'Name', 'Kerberos', 'Floor', 'Categories', 'Checked in']]
      .concat(data.entries.map(e => [e.number, e.dish, e.name, e.kerberos, e.floor, e.categories.map(catName).join('; '), e.created_at]));
  } else if (what === 'results') {
    const r = computeResults(data);
    rows = [['Category', 'Type', 'Place', 'Entry #', 'Dish', 'Name', 'Kerberos', 'Floor', 'Decided by']]
      .concat(r.results.map(x => [x.category, x.type, x.place, x.entry || '', x.dish, x.name, x.kerberos, x.floor, x.how]))
      .concat([[], ['Rank', 'Floor', 'Wins', 'Prize']], r.standings.map(s => [s.rank, s.floor, s.wins, s.prize ? 'yes' : '']))
      .concat([[], ["Winners' kerberos"]], r.winnerKerberos.map(k => [k]));
  } else if (what === 'votes') {
    rows = [['Time', 'Category', 'Entry #', 'Votes', 'Source', 'Note']]
      .concat(data.votes.map(v => [v.created_at, catName(v.category_id), v.entry, v.votes, v.source, v.note]));
  } else fail(404, 'Unknown export.');
  const filename = (data.event.name + ' ' + what).replace(/[^\w -]/g, '').replace(/\s+/g, '-') + '.csv';
  return new Response(toCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` } });
}, 'admin');

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Judge links (/j/<token>) serve the judging page; the page reads the token from the URL.
    if (url.pathname.startsWith('/j/')) return env.ASSETS.fetch(new Request(new URL('/judge', url), request));
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env.DB);
      const eventId = await activeEventId(env.DB);
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        if (r.role) {
          const role = await sessionRole(request, env);
          if (!role || (r.role === 'admin' && role !== 'admin')) fail(401, r.role === 'admin' ? 'Please log in.' : 'Please enter the check-in PIN.');
        }
        // Admin calls can work on any event (?event=ID); everything else uses the active event.
        let viewId = eventId;
        if (r.role === 'admin' && url.searchParams.get('event')) {
          viewId = Number(url.searchParams.get('event'));
          if (!(await getEvent(env.DB, viewId))) fail(404, 'No such event.');
        }
        const out = await r.handler({ request, env, url, params, eventId, viewId });
        return out instanceof Response ? out : json(out);
      }
      return json({ error: 'Not found' }, { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
      console.error(e);
      return json({ error: 'Something went wrong: ' + e.message }, { status: 500 });
    }
  },
};
